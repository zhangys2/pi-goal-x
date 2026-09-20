import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export interface LoopConfig {
	intervalMs: number;
	durationMs?: number;
	prompt?: string;
}

export type LoopStopReason = "deadline" | "cancelled" | "replaced" | "error";

type Timer = ReturnType<typeof setTimeout>;

export interface LoopControllerOptions {
	config: LoopConfig;
	now?: () => number;
	isIdle?: () => boolean;
	schedule?: (callback: () => void, delayMs: number) => Timer;
	cancel?: (timer: Timer) => void;
	send: (prompt: string) => void;
	onError?: (error: unknown) => void;
	onStop?: (reason: LoopStopReason) => void;
}

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/u;
const DURATION_MULTIPLIERS: Record<string, number | undefined> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 60 * 60_000,
	d: 24 * 60 * 60_000,
};
const MAX_DURATION_MS = 7 * 24 * 60 * 60_000;

export const LOOP_COMMAND_NAME = "loop";
export const LOOP_USAGE =
	"Usage: /loop <interval> [<duration>|--until <duration>] [<prompt>] | /loop stop";

const LOOP_STATUS_KEY = "loop";
const LOOP_COMPLETIONS: AutocompleteItem[] = [
	{ value: "stop", label: "stop", description: "Stop the active loop" },
	{ value: "cancel", label: "cancel", description: "Stop the active loop" },
];

export function parseDuration(value: string): number {
	const match = DURATION_PATTERN.exec(value.trim().toLowerCase());
	const multiplier = match ? DURATION_MULTIPLIERS[match[2] ?? ""] : undefined;
	if (!match || multiplier === undefined) {
		throw new Error(`Invalid duration "${value}". Use a value such as 30s, 5m, or 1h.`);
	}
	const durationMs = Number(match[1]) * multiplier;
	if (!Number.isFinite(durationMs) || durationMs <= 0) {
		throw new Error(`Duration "${value}" must be greater than zero.`);
	}
	if (durationMs > MAX_DURATION_MS) throw new Error("Loop duration cannot exceed 7d.");
	return durationMs;
}

export function parseLoopArguments(input: string): LoopConfig | "stop" {
	const words = input.trim().split(/\s+/u).filter(Boolean);
	if (words.length === 1 && ["stop", "cancel"].includes(words[0]?.toLowerCase() ?? "")) return "stop";
	if (words.length < 1) throw new Error(LOOP_USAGE);

	const intervalMs = parseDuration(words[0] ?? "");
	let cursor = 1;
	let durationMs: number | undefined;
	if (words[cursor]?.toLowerCase() === "--until") {
		durationMs = parseDuration(words[cursor + 1] ?? "");
		cursor += 2;
	} else if (DURATION_PATTERN.test(words[cursor] ?? "")) {
		durationMs = parseDuration(words[cursor] ?? "");
		cursor += 1;
	}
	const prompt = words.slice(cursor).join(" ").trim() || undefined;
	if (durationMs !== undefined && intervalMs > durationMs) {
		throw new Error("Loop interval cannot exceed the loop duration.");
	}
	return { intervalMs, durationMs, prompt };
}

/**
 * One repeating prompt. The next send is scheduled from the moment the agent
 * settles, not from the moment the prompt was sent, so a run that outlasts the
 * interval never overlaps the run after it.
 */
export class LoopController {
	private readonly now: () => number;
	private readonly isIdle: () => boolean;
	private readonly schedule: (callback: () => void, delayMs: number) => Timer;
	private readonly cancel: (timer: Timer) => void;
	private timer: Timer | undefined;
	private phase: "idle" | "inFlight" | "scheduled" | "waitingForIdle" = "idle";
	private stopped = false;
	private readonly deadlineAt: number | undefined;
	private readonly options: LoopControllerOptions;

	constructor(options: LoopControllerOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.isIdle = options.isIdle ?? (() => true);
		this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
		this.cancel = options.cancel ?? clearTimeout;
		this.deadlineAt =
			options.config.durationMs === undefined ? undefined : this.now() + options.config.durationMs;
	}

	start(): void {
		if (this.phase !== "idle" || this.stopped) throw new Error("Loop has already started.");
		this.sendNext();
	}

	onAgentSettled(): void {
		if (this.stopped) return;
		if (this.phase === "inFlight") {
			this.scheduleNext();
			return;
		}
		if (this.phase === "waitingForIdle") this.sendNext();
	}

	stop(reason: LoopStopReason): void {
		if (this.stopped) return;
		this.stopped = true;
		this.phase = "idle";
		if (this.timer !== undefined) {
			this.cancel(this.timer);
			this.timer = undefined;
		}
		this.options.onStop?.(reason);
	}

	private sendNext(): void {
		if (this.deadlineAt !== undefined && this.now() >= this.deadlineAt) {
			this.stop("deadline");
			return;
		}
		if (!this.isIdle()) {
			this.phase = "waitingForIdle";
			return;
		}
		this.phase = "inFlight";
		const prompt = this.options.config.prompt;
		if (!prompt) {
			this.fail(new Error("Loop prompt cannot be empty."));
			return;
		}
		try {
			this.options.send(prompt);
		} catch (error) {
			this.fail(error);
		}
	}

	private fail(error: unknown): void {
		try {
			this.options.onError?.(error);
		} finally {
			this.stop("error");
		}
	}

	private scheduleNext(): void {
		if (this.stopped) return;
		let delayMs = this.options.config.intervalMs;
		if (this.deadlineAt !== undefined) {
			const remainingMs = this.deadlineAt - this.now();
			if (remainingMs <= 0) {
				this.stop("deadline");
				return;
			}
			delayMs = Math.min(delayMs, remainingMs);
		}
		this.phase = "scheduled";
		this.timer = this.schedule(() => {
			this.timer = undefined;
			this.sendNext();
		}, delayMs);
		(this.timer as Timer & { unref?: () => void }).unref?.();
	}
}

/**
 * /loop repeats a prompt on an interval. It is independent of the goal
 * lifecycle: it drives a session with no goal as well as one with a goal, and
 * it never touches goal storage. goal.ts registers it before the goal
 * lifecycle handlers so its agent_settled/session_shutdown listeners are the
 * earlier ones.
 */
export function registerLoopCommand(pi: ExtensionAPI): void {
	type ActiveLoop = {
		session: ExtensionContext["sessionManager"];
		controller: LoopController;
		ctx: ExtensionContext;
	};
	let active: ActiveLoop | undefined;

	const owns = (ctx: ExtensionContext): boolean => active?.session === ctx.sessionManager;
	const clearStatus = (ctx: ExtensionContext): void => ctx.ui.setStatus(LOOP_STATUS_KEY, undefined);
	const stopActive = (reason: LoopStopReason, notify = false): void => {
		const current = active;
		if (!current) return;
		active = undefined;
		current.controller.stop(reason);
		clearStatus(current.ctx);
		if (notify) current.ctx.ui.notify("Loop stopped.", "info");
	};

	pi.on("agent_settled", async (_event, ctx) => {
		if (!owns(ctx)) return;
		try {
			active?.controller.onAgentSettled();
		} catch (error) {
			ctx.ui.notify(`Loop failed: ${formatLoopError(error)}`, "error");
			stopActive("error");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!owns(ctx)) return;
		stopActive("cancelled");
	});

	pi.registerCommand(LOOP_COMMAND_NAME, {
		description:
			"Repeat a prompt at an interval until stopped or an optional deadline. /loop stop ends it.",
		getArgumentCompletions: (prefix) =>
			LOOP_COMPLETIONS.filter((item) => item.value.startsWith(prefix.trim().toLowerCase())),
		handler: async (rawArgs, ctx) => {
			let parsed: LoopConfig | "stop";
			try {
				parsed = parseLoopArguments(rawArgs ?? "");
			} catch (error) {
				ctx.ui.notify(formatLoopError(error), "warning");
				return;
			}
			if (parsed === "stop") {
				if (!owns(ctx)) {
					ctx.ui.notify("No active loop.", "warning");
					return;
				}
				stopActive("cancelled", true);
				return;
			}

			const prompt = parsed.prompt ?? lastUserPrompt(ctx);
			if (!prompt) {
				ctx.ui.notify(
					"No previous user prompt to repeat; provide a prompt after the loop interval.",
					"warning",
				);
				return;
			}
			if (active) stopActive("replaced");
			const config: LoopConfig = { ...parsed, prompt };
			const controller = new LoopController({
				config,
				isIdle: () => owns(ctx) && ctx.isIdle(),
				send: (text) => pi.sendUserMessage(text, { deliverAs: "followUp" }),
				onError: (error) => {
					if (owns(ctx)) ctx.ui.notify(`Loop failed: ${formatLoopError(error)}`, "error");
				},
				onStop: (reason) => {
					if (active?.controller !== controller) return;
					active = undefined;
					clearStatus(ctx);
					if (reason === "deadline") ctx.ui.notify("Loop finished at its deadline.", "info");
				},
			});
			active = { session: ctx.sessionManager, controller, ctx };
			ctx.ui.setStatus(LOOP_STATUS_KEY, loopStatusText(config));
			controller.start();
		},
	});
}

export function formatLoopDuration(durationMs: number): string {
	if (durationMs % (60 * 60_000) === 0) return `${durationMs / (60 * 60_000)}h`;
	if (durationMs % 60_000 === 0) return `${durationMs / 60_000}m`;
	if (durationMs % 1_000 === 0) return `${durationMs / 1_000}s`;
	return `${durationMs}ms`;
}

export function loopStatusText(config: LoopConfig): string {
	const every = `loop: every ${formatLoopDuration(config.intervalMs)}`;
	return config.durationMs === undefined
		? `${every} - /loop stop`
		: `${every} for ${formatLoopDuration(config.durationMs)} - /loop stop`;
}

function formatLoopError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function lastUserPrompt(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.map((part) => (isTextPart(part) ? part.text : "")).join("\n")
					: "";
		const prompt = text.trim();
		if (prompt && !prompt.startsWith("/loop")) return prompt;
	}
	return undefined;
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
	return (
		typeof part === "object" &&
		part !== null &&
		(part as { type?: unknown }).type === "text" &&
		typeof (part as { text?: unknown }).text === "string"
	);
}
