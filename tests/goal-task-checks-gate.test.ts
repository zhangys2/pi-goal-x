/**
 * Executed task checks at the update_goal_task boundary: checks run before the
 * code review, a failure keeps the task pending without a review, and a pass is
 * stored on the task and written to the ledger with the completion.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { convertFlatTasks, mergeTasksWithExisting } from "../extensions/goal-task-tools.ts";
import { createGoal, goalFocusDetails, normalizeTaskItem, type GoalRecord } from "../extensions/goal-record.ts";
import { parseGoalFile, writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { goalLedgerPath } from "../extensions/goal-ledger.ts";

const node = process.execPath;
const pass = { command: node, args: ["-e", "process.exit(0)"] };
const fail = { command: node, args: ["-e", "console.error('CHECK_BROKE'); process.exit(2)"] };

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
		sessionManager: { getBranch: () => sessionEntries, getCwd: () => cwd, getSessionId: () => "checks-session", getRoot: () => cwd },
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, onTerminalInput: () => () => {}, select: async () => undefined, confirm: async () => false, custom: async () => undefined },
		getSystemPrompt: () => "base",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, { runTaskReview: async (args: any) => { reviews.push(args.completionSummary); return { approved: true, disapproved: false, output: "<approved/>" }; } });
	return { handlers, tools, ctx };
}

async function setup(tasks: Array<Record<string, unknown>>) {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-checks-gate-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	const goal = createGoal({ objective: "Checks goal", autoContinue: false, sisyphus: false }, Date.UTC(2026, 8, 19));
	goal.taskList = { tasks: tasks as any, blockCompletion: false, proposedAt: new Date().toISOString() };
	writeActiveGoalFile({ cwd }, goal);
	const reviews: string[] = [];
	const h = harness(cwd, [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goal.id, "created") }], reviews);
	await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
	await h.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "go", systemPromptOptions: {} }, h.ctx);
	const call = async (params: Record<string, unknown>) => (h.tools.get("update_goal_task")!.execute as any)("call", params, undefined, undefined, h.ctx);
	const goalOnDisk = (): GoalRecord => {
		const file = readdirSync(path.join(cwd, ".pi", "goals")).find((n) => n.startsWith("active_goal_"))!;
		return parseGoalFile(path.join(cwd, ".pi", "goals", file))!;
	};
	const events = () => readFileSync(goalLedgerPath({ cwd }), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	return { cwd, call, reviews, goalOnDisk, events, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("passing checks complete the task and reach the reviewer as facts", async () => {
	const f = await setup([{ id: "code", title: "Implement", status: "pending", codeChange: true, checks: [pass] }]);
	try {
		const result = await f.call({ task_id: "code", status: "complete", evidence: "done" });
		assert.match(result.content[0].text, /code complete/);
		const task = f.goalOnDisk().taskList!.tasks[0]!;
		assert.equal(task.status, "complete");
		assert.equal(task.checkRun?.passed, true);
		assert.match(f.reviews[0] ?? "", /Checks goal-x ran/);
		const types = f.events().filter((e) => e.taskId === "code").map((e) => e.type);
		assert.deepEqual(types.slice(-3), ["task_checks", "task_review", "task_complete"], "the pass is written with the completion");
	} finally { f.cleanup(); }
});

test("a failing check keeps the task pending and starts no review", async () => {
	const f = await setup([{ id: "code", title: "Implement", status: "pending", codeChange: true, checks: [pass, fail] }]);
	try {
		const result = await f.call({ task_id: "code", status: "complete", evidence: "done" });
		assert.match(result.content[0].text, /remains pending because one of its checks failed/);
		assert.match(result.content[0].text, /exit 2/);
		assert.match(result.content[0].text, /CHECK_BROKE/);
		assert.equal(f.goalOnDisk().taskList!.tasks[0]!.status, "pending");
		assert.equal(f.reviews.length, 0);
		const checks = f.events().filter((e) => e.type === "task_checks");
		assert.equal(checks.length, 1);
		assert.equal(checks[0].passed, false);
		assert.equal(checks[0].results.length, 2);
	} finally { f.cleanup(); }
});

test("a failing check in a batch rejects the whole batch", async () => {
	const f = await setup([
		{ id: "a", title: "First", status: "pending", codeChange: false, checks: [pass] },
		{ id: "b", title: "Second", status: "pending", codeChange: false, checks: [fail] },
	]);
	try {
		const result = await f.call({ updates: [{ task_id: "a", status: "complete" }, { task_id: "b", status: "complete" }] });
		assert.match(result.content[0].text, /b remains pending/);
		assert.deepEqual(f.goalOnDisk().taskList!.tasks.map((t) => t.status), ["pending", "pending"]);
		assert.equal(f.events().some((e) => e.type === "task_checks" && e.passed), false, "the first task's pass is not written without its completion");
	} finally { f.cleanup(); }
});

test("checks run even when the task needs no review", async () => {
	const f = await setup([{ id: "docs", title: "Docs", status: "pending", codeChange: false, checks: [fail] }]);
	try {
		const result = await f.call({ task_id: "docs", status: "complete" });
		assert.match(result.content[0].text, /checks failed/);
		assert.equal(f.goalOnDisk().taskList!.tasks[0]!.status, "pending");
	} finally { f.cleanup(); }
});

test("checks are structural task input and survive persistence", () => {
	const converted = convertFlatTasks([{ id: "t", title: "T", checks: [{ command: "npm", args: ["test"], timeout_seconds: 30 }] }]);
	assert.ok(converted.ok);
	assert.deepEqual(converted.tasks[0]!.checks, [{ command: "npm", args: ["test"], timeoutSeconds: 30 }]);
	assert.equal(convertFlatTasks([{ id: "t", title: "T", checks: [{ command: "" }] }]).ok, false);
	const merged = mergeTasksWithExisting([{ ...converted.tasks[0]!, checkRun: { passed: true, at: "x", results: [] } }], [{ id: "t", title: "T", status: "pending" }]);
	assert.equal(merged[0]!.checks, undefined, "omitting checks clears them");
	assert.equal(merged[0]!.checkRun?.passed, true, "a recorded run is progress and is kept");
	const restored = normalizeTaskItem(JSON.parse(JSON.stringify(converted.tasks[0])));
	assert.deepEqual(restored?.checks, converted.tasks[0]!.checks);
});
