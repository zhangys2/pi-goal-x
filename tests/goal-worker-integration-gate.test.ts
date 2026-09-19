/**
 * Worker patch integration at the update_goal_task boundary: status=integrate
 * records the commit on the task, isolated tasks may run in parallel, and an
 * isolated task is reviewed as its integration commits only.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { createGoal, goalFocusDetails, type GoalRecord } from "../extensions/goal-record.ts";
import { parseGoalFile, writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { goalLedgerPath } from "../extensions/goal-ledger.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function harness(cwd: string, sessionEntries: unknown[], reviews: string[]) {
	const handlers = new Map<string, Function>();
	const tools = new Map<string, ToolDefinition>();
	let activeTools = ["read", "bash", "edit", "write"];
	const pi = {
		registerTool: (def: ToolDefinition) => { tools.set(def.name, def); },
		registerCommand: () => {},
		on: (event: string, handler: Function) => { handlers.set(event, handler); },
		appendEntry: () => {},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; },
		hasUI: false,
	};
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: { getBranch: () => sessionEntries, getCwd: () => cwd, getSessionId: () => "integration-session", getRoot: () => cwd },
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, onTerminalInput: () => () => {}, select: async () => undefined, confirm: async () => false, custom: async () => undefined },
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, { runTaskReview: async (args: any) => { reviews.push(args.completionSummary); return { approved: true, disapproved: false, output: "<approved/>" }; } });
	return { handlers, tools, ctx };
}

/** A repository with committed code, ignored goal state, and one worker patch per name. */
async function setup(tasks: Array<Record<string, unknown>>, workers: Record<string, [string, string]>) {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-integration-gate-"));
	git(cwd, "init", "-q", "-b", "main");
	git(cwd, "config", "user.email", "test@example.invalid");
	git(cwd, "config", "user.name", "Test");
	writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n");
	writeFileSync(path.join(cwd, "app.ts"), "export const app = 1;\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-qm", "base");
	const base = git(cwd, "rev-parse", "HEAD").trim();
	const patches: Record<string, string> = {};
	for (const [name, [file, content]] of Object.entries(workers)) {
		writeFileSync(path.join(cwd, file), content);
		git(cwd, "add", "-A");
		patches[name] = path.join(cwd, "..", `${path.basename(cwd)}-${name}.patch`);
		writeFileSync(patches[name]!, git(cwd, "diff", "--cached", "--binary", base));
		git(cwd, "reset", "-q", "--hard", base);
		git(cwd, "clean", "-qfd", "--exclude=.pi");
	}
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const goal = createGoal({ objective: "Integration goal", autoContinue: false, sisyphus: false }, Date.UTC(2026, 8, 19));
	goal.taskList = { tasks: tasks as any, blockCompletion: false, proposedAt: new Date().toISOString() };
	writeActiveGoalFile({ cwd }, goal);
	const reviews: string[] = [];
	const h = harness(cwd, [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }], reviews);
	await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
	await h.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "go", systemPromptOptions: {} }, h.ctx);
	const call = async (params: Record<string, unknown>) => (await (h.tools.get("update_goal_task")!.execute as any)("call", params, undefined, undefined, h.ctx)).content[0].text as string;
	const goalOnDisk = (): GoalRecord => {
		const file = readdirSync(path.join(cwd, ".pi", "goals")).find((n) => n.startsWith("active_goal_"))!;
		return parseGoalFile(path.join(cwd, ".pi", "goals", file))!;
	};
	const events = () => readFileSync(goalLedgerPath({ cwd }), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const cleanup = () => { rmSync(cwd, { recursive: true, force: true }); for (const p of Object.values(patches)) rmSync(p, { force: true }); };
	return { cwd, call, reviews, patches, goalOnDisk, events, cleanup };
}

test("isolated tasks run in parallel, integrate their patches, and are reviewed as their own commits", async () => {
	const f = await setup(
		[{ id: "api", title: "API", status: "pending", codeChange: true, isolated: true }, { id: "ui", title: "UI", status: "pending", codeChange: true, isolated: true }],
		{ api: ["api.ts", "export const API_WORK = 1;\n"], ui: ["ui.ts", "export const UI_WORK = 1;\n"] },
	);
	try {
		assert.match(await f.call({ task_id: "api", status: "start" }), /Started api/);
		assert.match(await f.call({ task_id: "ui", status: "start" }), /Started ui/, "a second isolated task may start");
		assert.match(await f.call({ task_id: "api", status: "complete" }), /no integrated worker patch/);

		assert.match(await f.call({ task_id: "api", status: "integrate", patch_path: f.patches.api, commit_message: "Add API" }), /Integrated as/);
		assert.match(await f.call({ task_id: "ui", status: "integrate", patch_path: f.patches.ui, commit_message: "Add UI" }), /Integrated as/);
		assert.equal(git(f.cwd, "log", "--format=%s", "-2").trim(), "Add UI\nAdd API");
		const api = f.goalOnDisk().taskList!.tasks[0]!;
		assert.equal(api.integrations?.length, 1);
		assert.equal(api.integrations![0]!.commit, git(f.cwd, "rev-parse", "HEAD~1").trim());

		assert.match(await f.call({ task_id: "api", status: "complete" }), /api complete/);
		assert.match(f.reviews[0]!, /API_WORK/);
		assert.doesNotMatch(f.reviews[0]!, /UI_WORK/, "another task's integration is not in this review");
		const outcomes = f.events().filter((e) => e.type === "task_integration").map((e) => e.outcome);
		assert.deepEqual(outcomes, ["integrated", "integrated"]);
	} finally { f.cleanup(); }
});

test("a shared-worktree code task still conflicts with an open isolated task", async () => {
	const f = await setup([{ id: "iso", title: "Isolated", status: "pending", codeChange: true, isolated: true }, { id: "inplace", title: "In place", status: "pending", codeChange: true }], {});
	try {
		await f.call({ task_id: "iso", status: "start" });
		assert.match(await f.call({ task_id: "inplace", status: "start" }), /cannot start while code task "iso"/);
	} finally { f.cleanup(); }
});

test("a failed integration is recorded and leaves the task unchanged", async () => {
	const f = await setup([{ id: "api", title: "API", status: "pending", codeChange: true, isolated: true, checks: [{ command: process.execPath, args: ["-e", "process.exit(5)"] }] }], { api: ["api.ts", "export const x = 1;\n"] });
	try {
		assert.match(await f.call({ task_id: "api", status: "integrate", patch_path: f.patches.api, commit_message: "Add API" }), /Start task "api"/);
		await f.call({ task_id: "api", status: "start" });
		const text = await f.call({ task_id: "api", status: "integrate", patch_path: f.patches.api, commit_message: "Add API" });
		assert.match(text, /not integrated \(checks failed\)/);
		assert.equal(git(f.cwd, "log", "--format=%s", "-1").trim(), "base");
		assert.equal(f.goalOnDisk().taskList!.tasks[0]!.integrations, undefined);
		const events = f.events();
		assert.equal(events.find((e) => e.type === "task_integration")?.outcome, "checks_failed");
		assert.equal(events.find((e) => e.type === "task_checks")?.trigger, "integration");
	} finally { f.cleanup(); }
});

test("integrate fields are rejected outside status=integrate and in batches", async () => {
	const f = await setup([{ id: "api", title: "API", status: "pending" }], {});
	try {
		assert.match(await f.call({ task_id: "api", status: "start", patch_path: "x.patch" }), /apply only to status=integrate/);
		assert.match(await f.call({ updates: [{ task_id: "api", status: "start" }], patch_path: "x.patch" }), /integrate is single-task only/);
	} finally { f.cleanup(); }
});
