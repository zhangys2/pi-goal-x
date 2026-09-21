/**
 * /loop repeats one prompt on an interval. The controller is driven by
 * injected clock/timer/idle seams so the schedule is asserted without waiting
 * on real time; the command tests cover dispatch, replacement, and stopping.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	LoopController,
	parseDuration,
	parseLoopArguments,
	registerLoopCommand,
	type LoopStopReason,
} from "../extensions/goal-loop.ts";

// ── Fake timer / clock seam ─────────────────────────────────────────────────

function createClock() {
	let nowMs = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	let nextId = 1;
	return {
		now: () => nowMs,
		schedule: (callback: () => void, delayMs: number) => {
			const id = nextId++;
			timers.set(id, { at: nowMs + delayMs, callback });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		cancel: (timer: ReturnType<typeof setTimeout>) => {
			timers.delete(timer as unknown as number);
		},
		pending: () => timers.size,
		/** Advance the clock and run every timer whose deadline has passed. */
		advance: (deltaMs: number) => {
			nowMs += deltaMs;
			for (const [id, timer] of [...timers]) {
				if (timer.at > nowMs) continue;
				timers.delete(id);
				timer.callback();
			}
		},
	};
}

function createLoop(options: {
	intervalMs: number;
	durationMs?: number;
	idle?: () => boolean;
}) {
	const clock = createClock();
	const sent: string[] = [];
	const stops: LoopStopReason[] = [];
	const controller = new LoopController({
		config: { intervalMs: options.intervalMs, durationMs: options.durationMs, prompt: "tick" },
		now: clock.now,
		isIdle: options.idle ?? (() => true),
		schedule: clock.schedule,
		cancel: clock.cancel,
		send: (prompt) => { sent.push(prompt); },
		onStop: (reason) => { stops.push(reason); },
	});
	return { clock, sent, stops, controller };
}

// ── Argument parsing ────────────────────────────────────────────────────────

test("parseDuration accepts the supported units and rejects the rest", () => {
	assert.equal(parseDuration("500ms"), 500);
	assert.equal(parseDuration("30s"), 30_000);
	assert.equal(parseDuration("5m"), 300_000);
	assert.equal(parseDuration("1h"), 3_600_000);
	assert.equal(parseDuration("2d"), 172_800_000);
	assert.throws(() => parseDuration("5 minutes"), /Invalid duration/);
	assert.throws(() => parseDuration("0s"), /greater than zero/);
	assert.throws(() => parseDuration("8d"), /cannot exceed 7d/);
});

test("parseLoopArguments reads interval, deadline, and prompt", () => {
	assert.deepEqual(parseLoopArguments("5m"), {
		intervalMs: 300_000,
		durationMs: undefined,
		prompt: undefined,
	});
	assert.deepEqual(parseLoopArguments("5m check the queue"), {
		intervalMs: 300_000,
		durationMs: undefined,
		prompt: "check the queue",
	});
	assert.deepEqual(parseLoopArguments("30s 10m poll CI"), {
		intervalMs: 30_000,
		durationMs: 600_000,
		prompt: "poll CI",
	});
	assert.deepEqual(parseLoopArguments("30s --until 10m poll CI"), {
		intervalMs: 30_000,
		durationMs: 600_000,
		prompt: "poll CI",
	});
	assert.equal(parseLoopArguments("stop"), "stop");
	assert.equal(parseLoopArguments(" Cancel "), "stop");
	assert.throws(() => parseLoopArguments(""), /Usage: \/loop/);
	assert.throws(() => parseLoopArguments("10m 30s"), /interval cannot exceed/);
});

test("a prompt that starts with a duration word is kept as the prompt", () => {
	// Only the token right after the interval is read as a deadline; the rest
	// is prompt text even when it looks like one.
	assert.deepEqual(parseLoopArguments("1m rerun 5m later"), {
		intervalMs: 60_000,
		durationMs: undefined,
		prompt: "rerun 5m later",
	});
});

// ── Controller schedule ─────────────────────────────────────────────────────

test("the loop sends immediately and re-sends one interval after the agent settles", () => {
	const { clock, sent, controller } = createLoop({ intervalMs: 60_000 });

	controller.start();
	assert.deepEqual(sent, ["tick"]);

	clock.advance(120_000); // No timer runs while the agent is still working.
	assert.deepEqual(sent, ["tick"]);

	controller.onAgentSettled();
	clock.advance(59_999);
	assert.deepEqual(sent, ["tick"]);
	clock.advance(1);
	assert.deepEqual(sent, ["tick", "tick"]);
});

test("a busy session defers the send until the agent settles", () => {
	let idle = false;
	const { clock, sent, controller } = createLoop({ intervalMs: 60_000, idle: () => idle });

	controller.start();
	assert.deepEqual(sent, []);
	assert.equal(clock.pending(), 0);

	idle = true;
	controller.onAgentSettled();
	assert.deepEqual(sent, ["tick"]);
});

test("the deadline stops the loop instead of sending past it", () => {
	const { clock, sent, stops, controller } = createLoop({ intervalMs: 60_000, durationMs: 90_000 });

	controller.start();
	controller.onAgentSettled();
	clock.advance(60_000);
	assert.deepEqual(sent, ["tick", "tick"]);

	controller.onAgentSettled(); // 30s left: the next wake is clamped to the deadline.
	clock.advance(30_000);
	assert.deepEqual(sent, ["tick", "tick"]);
	assert.deepEqual(stops, ["deadline"]);
	assert.equal(clock.pending(), 0);
});

test("stop cancels the pending timer and reports the reason once", () => {
	const { clock, sent, stops, controller } = createLoop({ intervalMs: 60_000 });

	controller.start();
	controller.onAgentSettled();
	assert.equal(clock.pending(), 1);

	controller.stop("cancelled");
	controller.stop("cancelled");
	clock.advance(600_000);
	assert.deepEqual(sent, ["tick"]);
	assert.deepEqual(stops, ["cancelled"]);
	assert.equal(clock.pending(), 0);
});

test("a send failure stops the loop and reports the error", () => {
	const errors: unknown[] = [];
	const stops: LoopStopReason[] = [];
	const controller = new LoopController({
		config: { intervalMs: 60_000, prompt: "tick" },
		send: () => { throw new Error("session is gone"); },
		onError: (error) => { errors.push(error); },
		onStop: (reason) => { stops.push(reason); },
	});

	controller.start();
	assert.equal((errors[0] as Error).message, "session is gone");
	assert.deepEqual(stops, ["error"]);
});

// ── Command surface ─────────────────────────────────────────────────────────

type CommandHandler = (rawArgs: string, ctx: ExtensionContext) => Promise<void> | void;

function createCommandHarness(branch: unknown[] = []) {
	const sent: string[] = [];
	const notifications: string[] = [];
	const statuses: (string | undefined)[] = [];
	const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
	let command: { description?: string; handler: CommandHandler; getArgumentCompletions?: (prefix: string) => unknown } | undefined;
	let idle = true;

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, options: typeof command) => {
			assert.equal(name, "loop");
			command = options;
		},
		sendUserMessage: (message: string) => { sent.push(message); },
	};
	const sessionManager = { getBranch: () => branch };
	const ctx = {
		sessionManager,
		isIdle: () => idle,
		ui: {
			notify: (message: string) => { notifications.push(message); },
			setStatus: (_key: string, text: string | undefined) => { statuses.push(text); },
		},
	} as unknown as ExtensionContext;

	registerLoopCommand(pi as never);
	assert.ok(command, "the /loop command is registered");

	return {
		ctx,
		sent,
		notifications,
		statuses,
		setIdle: (value: boolean) => { idle = value; },
		run: (rawArgs: string) => (command as { handler: CommandHandler }).handler(rawArgs, ctx),
		completions: (prefix: string) => (command as { getArgumentCompletions: (p: string) => { value: string }[] }).getArgumentCompletions(prefix),
		emit: async (event: string) => {
			for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
		},
	};
}

test("/loop <interval> <prompt> sends the prompt and shows the loop status", async () => {
	const h = createCommandHarness();

	await h.run("5m poll the deploy");

	assert.deepEqual(h.sent, ["poll the deploy"]);
	assert.deepEqual(h.statuses, ["loop: every 5m - /loop stop"]);
});

test("/loop with a deadline names it in the status", async () => {
	const h = createCommandHarness();

	await h.run("30s --until 10m poll the deploy");

	assert.deepEqual(h.statuses, ["loop: every 30s for 10m - /loop stop"]);
});

test("/loop without a prompt repeats the last user message", async () => {
	const h = createCommandHarness([
		{ type: "message", message: { role: "user", content: "run the failing test" } },
		{ type: "message", message: { role: "assistant", content: "done" } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "/loop 5m" }] } },
	]);

	await h.run("5m");

	assert.deepEqual(h.sent, ["run the failing test"]);
});

test("/loop without a prompt and without history explains itself and sends nothing", async () => {
	const h = createCommandHarness();

	await h.run("5m");

	assert.deepEqual(h.sent, []);
	assert.match(h.notifications[0] ?? "", /No previous user prompt/);
});

test("a bad interval is reported, not thrown", async () => {
	const h = createCommandHarness();

	await h.run("soon");

	assert.deepEqual(h.sent, []);
	assert.match(h.notifications[0] ?? "", /Invalid duration/);
});

test("/loop stop ends the loop and clears the status", async () => {
	const h = createCommandHarness();

	await h.run("5m poll the deploy");
	await h.run("stop");

	assert.deepEqual(h.statuses, ["loop: every 5m - /loop stop", undefined]);
	assert.deepEqual(h.notifications, ["Loop stopped."]);

	await h.emit("agent_settled"); // The stopped loop no longer reacts.
	assert.deepEqual(h.sent, ["poll the deploy"]);
});

test("/loop stop without an active loop says so", async () => {
	const h = createCommandHarness();

	await h.run("stop");

	assert.deepEqual(h.notifications, ["No active loop."]);
});

test("a second /loop replaces the first one", async () => {
	const h = createCommandHarness();

	await h.run("5m poll the deploy");
	await h.run("1m poll the queue");

	assert.deepEqual(h.sent, ["poll the deploy", "poll the queue"]);
	assert.deepEqual(h.statuses, [
		"loop: every 5m - /loop stop",
		undefined,
		"loop: every 1m - /loop stop",
	]);
});

test("session shutdown stops the loop", async () => {
	const h = createCommandHarness();

	await h.run("5m poll the deploy");
	await h.emit("session_shutdown");
	await h.emit("agent_settled");

	assert.deepEqual(h.sent, ["poll the deploy"]);
	assert.deepEqual(h.statuses, ["loop: every 5m - /loop stop", undefined]);
});

test("argument completions offer stop and cancel", () => {
	const h = createCommandHarness();

	assert.deepEqual(h.completions("").map((item) => item.value), ["stop", "cancel"]);
	assert.deepEqual(h.completions("st").map((item) => item.value), ["stop"]);
});
