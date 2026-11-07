/**
 * Guided drafting is the normal entry path; the two -direct commands are the
 * explicit immediate-creation escape hatch.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { parseGoalFile } from "../extensions/storage/goal-files.ts";
import { mutateSettingsLayer } from "../extensions/goal-settings.ts";
import { applyGoalPreset } from "../extensions/goal-presets.ts";

const CURATED_COMMANDS = ["gx", "loop"];

const REMOVED_COMMANDS = ["goals", "goals-set", "sisyphus-set", "goal-abort", "goal", "sisyphus", "goal-direct", "sisyphus-direct", "goal-tweak", "goal-pause", "goal-resume", "goal-clear", "goal-list", "goal-status", "goal-refresh", "goal-recovery", "goal-focus", "goal-unfocus", "goal-settings", "goal-cancel", "goal-report", "goal-onboarding"];

function createHarness(cwd: string) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const notifications: string[] = [];
	const messages: string[] = [];
	const tools = new Map<string, any>();
	let activeTools = ["read", "bash", "edit", "write"];
	const pi = {
		registerTool: (def: any) => { tools.set(def.name, def); },
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendUserMessage: (message: string) => { messages.push(message); },
		sendMessage: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		hasUI: false,
	};
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => [] as unknown[],
			getCwd: () => cwd,
			getSessionId: () => "palette-session",
			getRoot: () => cwd,
		},
		ui: {
			notify: (message: string) => { notifications.push(message); },
			setStatus: () => {},
			setWidget: () => {},
			onTerminalInput: () => () => {},
			select: async () => undefined,
			confirm: async () => false,
			custom: async () => undefined,
		},
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, {});
	return { handlers, commands, ctx, notifications, messages, tools, getActiveTools: () => [...activeTools] };
}

function activeGoalFiles(cwd: string): string[] {
	try {
		return readdirSync(path.join(cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_"));
	} catch {
		return [];
	}
}

test("exactly the curated commands are registered; legacy commands are absent", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-"));
	try {
		const h = createHarness(cwd);
		for (const name of CURATED_COMMANDS) {
			assert.ok(h.commands.has(name), `${name} must be registered`);
		}
		for (const name of REMOVED_COMMANDS) {
			assert.equal(h.commands.has(name), false, `${name} must NOT be registered`);
		}
		assert.equal(h.commands.size, CURATED_COMMANDS.length, "no aliases or extras");
		const completions = h.commands.get("gx")!.getArgumentCompletions("").map((item: { value: string }) => item.value);
		assert.ok(completions.includes("sisyphus"));
		assert.ok(completions.includes("status"));
		assert.ok(completions.includes("sisyphus direct"));
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("/gx list recovery is a read-only lifecycle recovery summary", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-recovery-view-"));
	try {
		const h = createHarness(cwd);
		await h.commands.get("gx")!.handler("list recovery", h.ctx);
		assert.ok(h.notifications.some((message) => message.includes("Goal recovery") && message.includes("no goal state changed")));
		assert.equal(activeGoalFiles(cwd).length, 0);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("headless onboarding explains the draft-confirm flow without creating a goal", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-onboarding-"));
	try {
		const h = createHarness(cwd);
		await h.commands.get("gx")!.handler("onboarding", h.ctx);
		assert.ok(h.notifications.some((message) => message.includes("draft") && message.includes("confirm")));
		assert.equal(activeGoalFiles(cwd).length, 0);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("/gx <objective> starts guided drafting without creating a goal", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-create-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("gx")!.handler("Create hello.txt with 'Hello'", h.ctx);
		const files = activeGoalFiles(cwd);
		assert.equal(files.length, 0, "drafting does not create before confirmation");
		assert.ok(h.messages.some((message) => message.includes("GOAL CONFIRMATION")), "drafting prompt sent to agent");
		assert.deepEqual(h.getActiveTools().filter((name) => name.startsWith("goal_") || name === "propose_goal_draft"), ["goal_question", "goal_questionnaire", "propose_goal_draft"]);
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("/gx subcommand-like objective text stays in guided drafting", async () => {
	for (const objective of [
		"status page redesign",
		"list export bug",
		"pause menu fix",
		"focus mode toggle",
		"clear cache on logout",
	]) {
		const cwd = mkdtempSync(path.join(tmpdir(), "goal-command-objective-"));
		try {
			const h = createHarness(cwd);
			await h.commands.get("gx")!.handler(objective, h.ctx);
			const prompt = h.messages.map(String).join("\n");
			assert.ok(prompt.includes("GOAL CONFIRMATION"), objective);
			assert.ok(prompt.includes(objective), objective);
			assert.equal(activeGoalFiles(cwd).length, 0, "drafting does not create a goal");
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	}
});

test("/gx preserves accepted command arguments instead of drafting", async () => {
	for (const args of ["status verbose", "recovery repair", "list recovery", "settings controls"]) {
		const cwd = mkdtempSync(path.join(tmpdir(), "goal-command-args-"));
		try {
			const h = createHarness(cwd);
			await h.commands.get("gx")!.handler(args, h.ctx);
			assert.ok(!h.messages.some(message => String(message).includes("GOAL CONFIRMATION")), args);
			assert.equal(activeGoalFiles(cwd).length, 0, args);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	}
});

test("/gx -- disambiguates a draft objective matching a valid command form", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-command-escape-"));
	try {
		const h = createHarness(cwd);
		await h.commands.get("gx")!.handler("-- status verbose", h.ctx);
		const prompt = h.messages.map(String).join("\n");
		assert.ok(prompt.includes("GOAL CONFIRMATION"));
		assert.ok(prompt.includes("\nstatus verbose\n"));
		assert.ok(!prompt.includes("\n-- status verbose\n"));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("bare /gx begins a guided draft and asks for an objective", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-status-"));
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("gx")!.handler("", h.ctx);
		assert.equal(activeGoalFiles(cwd).length, 0, "no goal created");
		assert.ok(h.messages.some((message) => message.includes("ask the user what they want")), "draft prompt requests an objective");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("confirmed draft creates the proposed goal and agent-selected task plan together", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-confirm-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("gx")!.handler("Ship a small feature", h.ctx);
		const proposal = h.tools.get("propose_goal_draft");
		assert.ok(proposal, "draft proposal tool registered");
		await proposal.execute("draft-1", {
			objective: "Ship a small feature.\nSuccess criteria: tests pass.",
			sisyphus: false,
			tasks: [{ id: "implement", title: "Implement the feature" }, { id: "verify", title: "Run tests" }],
			block_completion: true,
		}, new AbortController().signal, undefined, h.ctx);
		const files = activeGoalFiles(cwd);
		assert.equal(files.length, 1, "confirmed draft creates one goal");
		const goal = parseGoalFile(path.join(cwd, ".pi", "goals", files[0]!));
		assert.deepEqual(goal?.taskList?.tasks.map((task) => task.id), ["implement", "verify"]);
		assert.equal(goal?.taskList?.blockCompletion, true);
		assert.ok(h.getActiveTools().includes("update_goal"), "execution profile restored after confirmation");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("/gx direct and /gx sisyphus direct create goals immediately", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-palette-sisy-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	try {
		const h = createHarness(cwd);
		await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
		await h.commands.get("gx")!.handler("direct Create hello.txt", h.ctx);
		await h.commands.get("gx")!.handler("sisyphus direct 1) create a.txt 2) create b.txt", h.ctx);
		const files = activeGoalFiles(cwd);
		assert.equal(files.length, 2, "direct commands create immediately");
		const parsed = files.map((file) => parseGoalFile(path.join(cwd, ".pi", "goals", file)));
		assert.ok(parsed.some((goal) => goal?.sisyphus === true), "sisyphus direct mode");
		assert.ok(parsed.some((goal) => goal?.sisyphus === false), "regular direct mode");
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); } catch {}
	}
});

test("project default auditor setting applies to newly created goals only", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-default-auditor-"));
	try {
		applyGoalPreset(cwd, "lightweight");
		const h = createHarness(cwd);
		await h.commands.get("gx")!.handler("direct Create a small sample", h.ctx);
		const files = activeGoalFiles(cwd);
		assert.equal(files.length, 1);
		const record = parseGoalFile(path.join(cwd, ".pi", "goals", files[0]!));
		assert.equal(record?.skipAuditor, true);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("/gx settings renders sectioned rows with clearer auditor wording", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-settings-"));
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	const h = createHarness(cwd);
	try {
		// The settings menu is interactive: give the harness ctx a TUI.
		(h.ctx as { hasUI: boolean }).hasUI = true;
		// Capture the options list passed to ctx.ui.select; answer "Done" on the
		// first call so the menu closes immediately.
		let captured: string[] | null = null;
		const ui = h.ctx.ui as unknown as { select: (title: string, options: string[]) => Promise<string | undefined> };
		ui.select = async (_title: string, options: string[]) => {
			if (captured === null) captured = options;
			return "Done";
		};

		await h.commands.get("gx")!.handler("settings", h.ctx);

		assert.ok(captured, "settings menu must call ui.select");
		const opts: string[] = captured ?? [];
		assert.ok(opts.some((l) => l.startsWith("─── Editing: project (")), "scope header names the edited layer");
		assert.ok(opts.some((l) => l.startsWith("Scope: project")), "scope switch is selectable");
		assert.ok(opts.includes("─── Advanced execution ───"));
		assert.ok(opts.includes("─── Goal behavior ───"), "Goal behavior section header");
		assert.ok(opts.includes("─── Task tracking ───"), "Task tracking section header");
		assert.ok(opts.includes("─── Completion auditor ───"), "Completion auditor section header");
		assert.ok(opts.some((l) => l.includes("auditor disabled:")), "clearer auditor wording row");
		assert.ok(opts.some((l) => l.includes("provider:")) && opts.some((l) => l.includes("model:")), "provider/model rows");

		assert.equal(opts.filter((l) => l.startsWith("───")).length, 7, "editing header + six settings sections including both execution and evidence controls");

		assert.ok(opts.includes("─── Advanced execution ───"), "Advanced execution section header");

		assert.ok(opts.includes("─── Blocker Oracle ───"), "Blocker Oracle section header");
		assert.ok(opts.includes("─── Evidence pre-check ───"), "Evidence pre-check section header");
		assert.ok(opts.some((l) => l.includes("precheck enabled (log-only, sends goal text to TypeSafe): false")), "pre-check toggle defaults off and names the data flow");
		assert.ok(opts.includes("Done"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ── #19: positive-integer rows use a row-driven lower bound ──────────────────
// The stall timeout row defaults to 0 ("no stall timeout") and must accept 0;
// subtaskDepth is a nesting depth and must keep rejecting 0 and non-integers.

test("/gx settings: stall timeout row accepts 0 (row-driven lower bound)", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-settings-bound-"));
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	const h = createHarness(cwd);
	try {
		(h.ctx as { hasUI: boolean }).hasUI = true;
		const ui = h.ctx.ui as unknown as {
			select: (title: string, options: string[]) => Promise<string | undefined>;
			input: (prompt: string, defaultValue?: string) => Promise<string | undefined>;
		};
		let selectCalls = 0;
		ui.select = async (_title: string, options: string[]) => {
			selectCalls++;
			if (selectCalls === 1) {
				const stallRow = options.find((o) => o.includes("stall timeout (minutes)"));
				assert.ok(stallRow, "stall timeout row must be listed");
				return stallRow;
			}
			return "Done";
		};
		ui.input = async (_prompt: string) => "0";

		await h.commands.get("gx")!.handler("settings", h.ctx);

		const saved = JSON.parse(readFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), "utf8"));
		assert.equal(saved.stallTimeoutMinutes, 0, "stallTimeoutMinutes must accept 0");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/gx settings: autonomous allowance accepts an explicit zero override", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-settings-zero-"));
	const h = createHarness(cwd);
	try {
		(h.ctx as { hasUI: boolean }).hasUI = true;
		let selectCalls = 0;
		h.ctx.ui.select = async (_title, options) => {
			selectCalls++;
			if (selectCalls === 1) {
				const row = options.find(o => o.includes("autonomous run allowance"));
				assert.ok(row);
				return row;
			}
			if (selectCalls === 2) return options.find(o => o === "Set project override...");
			assert.ok(options.some(o => o.includes("autonomous run allowance: 0 (disabled) (project override)")));
			return "Done";
		};
		h.ctx.ui.input = async () => "0";
		await h.commands.get("gx")!.handler("settings", h.ctx);
		const saved = JSON.parse(readFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), "utf8"));
		assert.equal(saved.maxAutonomousRuns, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/gx settings: subtaskDepth rejects 0 (min 1) and never saves it", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-settings-bound-"));
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	const h = createHarness(cwd);
	try {
		(h.ctx as { hasUI: boolean }).hasUI = true;
		const ui = h.ctx.ui as unknown as {
			select: (title: string, options: string[]) => Promise<string | undefined>;
			input: (prompt: string, defaultValue?: string) => Promise<string | undefined>;
		};
		let selectCalls = 0;
		ui.select = async (_title: string, options: string[]) => {
			selectCalls++;
			if (selectCalls === 1) {
				const depthRow = options.find((o) => o.includes("subtaskDepth"));
				assert.ok(depthRow, "subtaskDepth row must be listed");
				return depthRow;
			}
			return "Done";
		};
		ui.input = async (_prompt: string) => "0";

		await h.commands.get("gx")!.handler("settings", h.ctx);

		assert.ok(h.notifications.some((n) => n.includes("subtaskDepth must be an integer >= 1")),
			`expected subtaskDepth bound warning, got notifications: ${h.notifications.join(" | ")}`);
		const settingsPath = path.join(cwd, ".pi", "pi-goal-x-settings.json");
		// A rejected input never persists: the file is either absent or lacks the key.
		if (readFileSyncSafe(settingsPath)) {
			assert.ok(!readFileSyncSafe(settingsPath)!.includes("subtaskDepth"), "subtaskDepth must not be written");
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/gx settings: max objective length row defaults to 0 and accepts a configured limit", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-settings-objective-max-"));
	mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	const h = createHarness(cwd);
	try {
		(h.ctx as { hasUI: boolean }).hasUI = true;
		const ui = h.ctx.ui as unknown as {
			select: (title: string, options: string[]) => Promise<string | undefined>;
			input: (prompt: string, defaultValue?: string) => Promise<string | undefined>;
		};
		let selectCalls = 0;
		let inputValue = "0";
		ui.select = async (_title: string, options: string[]) => {
			selectCalls++;
			if (selectCalls === 1) {
				const row = options.find((o) => o.includes("max objective length"));
				assert.ok(row, "max objective length row must be listed");
				assert.ok(row!.includes(": 0"), "row defaults to 0 = no limit");
				return row;
			}
			return "Done";
		};
		ui.input = async (_prompt: string, defaultValue?: string) => {
			assert.equal(defaultValue, "0", "input defaults to 0");
			return inputValue;
		};

		await h.commands.get("gx")!.handler("settings", h.ctx);

		let saved = JSON.parse(readFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), "utf8"));
		assert.equal(saved.objectiveMaxChars, 0, "0 = no limit persists explicitly");

		// A configured limit persists too.
		inputValue = "6000";
		selectCalls = 0;
		await h.commands.get("gx")!.handler("settings", h.ctx);
		saved = JSON.parse(readFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), "utf8"));
		assert.equal(saved.objectiveMaxChars, 6000, "configured limit persists");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

function readFileSyncSafe(p: string): string | null {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return null;
	}
}

for (const [key, label] of [["strictExecutionContract", "explicit execution contracts (opt-in)"], ["idleContinuationBackoff", "slow repeated idle replies (opt-in)"]] as const) test(`/gx settings: ${key} can be set and removed through the menu`, async () => {
 const cwd = mkdtempSync(path.join(tmpdir(), "goal-settings-contract-"));
 mkdirSync(path.join(cwd, ".pi"), {recursive: true});
 const h = createHarness(cwd);
 try {
  (h.ctx as {hasUI: boolean}).hasUI = true;
  const ui = h.ctx.ui as unknown as {select: (title: string, options: string[]) => Promise<string | undefined>};
  for (const action of ["Set project override to true", "Set project override to false", "Use inherited value"]) {
   let step = 0;
   ui.select = async (_title, options) => {
    step++;
    if (step === 1) return options.find(option => option.includes(`${label}:`));
    if (step === 2) { assert.ok(options.includes(action)); return action; }
    return "Done";
   };
   await h.commands.get("gx")!.handler("settings", h.ctx);
   const saved = JSON.parse(readFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), "utf8"));
   assert.equal(saved[key], action === "Use inherited value" ? undefined : action.endsWith("true"));
  }
 } finally { rmSync(cwd, {recursive: true, force: true}); }
});
