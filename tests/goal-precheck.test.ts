/**
 * Log-only evidence pre-check (specs/2026-09-23-jev-pre-audit-gate): request
 * building, verdict mapping, failure handling, settings, and the completion
 * flow recording one precheck_result per audit without changing the outcome.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import goalExtension from "../extensions/goal.ts";
import { buildPrecheckRequest, runEvidencePrecheck, type PrecheckOutcome } from "../extensions/goal-precheck.ts";
import { createGoal, goalFocusDetails, type GoalRecord, type GoalTask } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import { goalLedgerPath } from "../extensions/goal-ledger.ts";
import { invalidateGoalSettingsCache, loadGoalSettings, loadSettingsSnapshot } from "../extensions/goal-settings.ts";

const SETTINGS = { enabled: true, model: "jev-1.13.0", rejectBelow: 0.15 };
const ENV = { TYPESAFE_API_KEY: "test-key" };

function task(id: string, extra: Partial<GoalTask> = {}): GoalTask {
	return { id, title: `Task ${id}`, status: "complete", verificationContract: `requirement ${id}`, evidence: `did ${id}`, ...extra };
}

function goalWith(tasks: GoalTask[], verificationContract?: string): GoalRecord {
	const goal = createGoal({ objective: "Ship the export", autoContinue: true, sisyphus: false }, Date.UTC(2026, 8, 23));
	goal.taskList = { tasks, blockCompletion: true, proposedAt: "2026-09-23T00:00:00.000Z" };
	if (verificationContract) goal.verificationContract = verificationContract;
	return goal;
}

function answering(p: Record<string, unknown>, init: { status?: number; model?: string } = {}) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetchStub = async (url: string | URL | Request, reqInit?: RequestInit) => {
		calls.push({ url: String(url), init: reqInit! });
		const body = JSON.parse(String(reqInit!.body));
		const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: p[k] }]));
		return new Response(JSON.stringify(init.status && init.status >= 400 ? { detail: "nope" } : { model: init.model ?? "jev-1.13.0", answers }), { status: init.status ?? 200 });
	};
	return { calls, fetch: fetchStub as typeof fetch };
}

// ── request building ─────────────────────────────────────────────────────────

test("asks one question per complete task with a requirement and no passing checks", () => {
	const passed = { passed: true, at: "t", results: [] };
	const goal = goalWith([
		task("a"),
		task("checked", { checkRun: passed }),
		task("skipped", { status: "skipped", skipReason: "not needed" }),
		task("nocontract", { verificationContract: undefined }),
		task("parent", { subtasks: [task("child")] }),
	], "all good");
	const req = buildPrecheckRequest(goal, "done");
	assert.ok(req);
	assert.deepEqual(Object.keys(req.questions).sort(), ["t:a", "t:child", "t:parent"]);
	const state = req.state as { tasks: { id: string }[]; goal_verification_contract: string; completion_summary: string };
	assert.deepEqual(state.tasks.map((t) => t.id).sort(), ["a", "checked", "child", "nocontract", "parent"], "complete tasks are context; skipped ones are not");
	assert.equal(state.goal_verification_contract, "all good");
	assert.equal(state.completion_summary, "done");
	assert.ok(!("goal" in req.questions), "the goal contract gets no question");
});

test("truncates long evidence and returns null when nothing is asked", () => {
	const req = buildPrecheckRequest(goalWith([task("a", { evidence: "x".repeat(5000) })]), undefined);
	const evidence = (req!.state as { tasks: { evidence: string }[] }).tasks[0]!.evidence;
	assert.ok(evidence.length <= 2000);
	assert.equal(buildPrecheckRequest(goalWith([task("a", { verificationContract: undefined })]), undefined), null);
	assert.equal(buildPrecheckRequest(createGoal({ objective: "no tasks", autoContinue: true, sisyphus: false }), undefined), null);
});

// ── verdicts ─────────────────────────────────────────────────────────────────

test("passes when every answer clears the threshold and sends model and key", async () => {
	const stub = answering({ "t:a": 0.9, "t:b": 0.6 });
	const out = await runEvidencePrecheck({ goal: goalWith([task("a"), task("b")]), settings: SETTINGS, env: ENV, fetch: stub.fetch });
	assert.equal(out.verdict, "passed");
	assert.equal(out.model, "jev-1.13.0");
	assert.deepEqual(out.items, [{ taskId: "a", pYes: 0.9 }, { taskId: "b", pYes: 0.6 }]);
	assert.equal(stub.calls[0]!.url, "https://api.typesafe.ai/v1/systemone");
	assert.equal((stub.calls[0]!.init.headers as Record<string, string>).authorization, "Bearer test-key");
	assert.equal(JSON.parse(String(stub.calls[0]!.init.body)).model, "jev-1.13.0");
});

test("rejects when any answer is below the threshold", async () => {
	const stub = answering({ "t:a": 0.9, "t:b": 0.05 });
	const out = await runEvidencePrecheck({ goal: goalWith([task("a"), task("b")]), settings: SETTINGS, env: ENV, fetch: stub.fetch });
	assert.equal(out.verdict, "rejected");
});

test("honours TYPESAFE_BASE_URL", async () => {
	const stub = answering({ "t:a": 0.9 });
	await runEvidencePrecheck({ goal: goalWith([task("a")]), settings: SETTINGS, env: { ...ENV, TYPESAFE_BASE_URL: "https://example.test/" }, fetch: stub.fetch });
	assert.equal(stub.calls[0]!.url, "https://example.test/v1/systemone");
});

// ── failures never throw ─────────────────────────────────────────────────────

test("maps every failure to a skipped or error outcome", async () => {
	const goal = goalWith([task("a")]);
	const run = (overrides: Partial<Parameters<typeof runEvidencePrecheck>[0]>) =>
		runEvidencePrecheck({ goal, settings: SETTINGS, env: ENV, fetch: answering({ "t:a": 0.9 }).fetch, ...overrides });
	const expect = async (p: Promise<PrecheckOutcome>, verdict: string, reason: string) => {
		const out = await p;
		assert.equal(out.verdict, verdict, reason);
		assert.equal(out.reason, reason);
	};
	let called = false;
	await expect(run({ env: {}, fetch: (async () => { called = true; return new Response("{}"); }) as typeof fetch }), "skipped", "no_api_key");
	assert.equal(called, false, "no request without a key");
	await expect(run({ goal: goalWith([task("a", { verificationContract: undefined })]) }), "skipped", "nothing_to_check");
	await expect(run({ goal: goalWith([task("a", { title: "t".repeat(90_000) })]) }), "skipped", "oversize");
	await expect(run({ fetch: answering({}, { status: 529 }).fetch }), "error", "http_529");
	await expect(run({ fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch }), "error", "network");
	await expect(run({ fetch: answering({ "t:a": "high" }).fetch }), "error", "malformed");
	await expect(run({ fetch: answering({ "t:a": 1.5 }).fetch }), "error", "malformed");
	await expect(run({ fetch: (async () => new Response(JSON.stringify({ model: "m", answers: {} }))) as typeof fetch }), "error", "malformed");
	const aborted = new AbortController();
	aborted.abort();
	await expect(run({
		signal: aborted.signal,
		fetch: ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
			if (init?.signal?.aborted) reject(init.signal.reason);
			init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
		})) as typeof fetch,
	}), "error", "aborted");
});

// ── settings ─────────────────────────────────────────────────────────────────

test("precheck settings default off and layer project over global", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "precheck-settings-"));
	try {
		mkdirSync(path.join(dir, ".pi"), { recursive: true });
		const globalFile = path.join(dir, "global.json");
		const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: globalFile };
		assert.deepEqual(loadGoalSettings(dir, env).precheck, { enabled: false, model: "jev-1.13.0", rejectBelow: 0.15 });
		writeFileSync(globalFile, JSON.stringify({ precheck: { enabled: true, rejectBelow: 0.2 } }));
		writeFileSync(path.join(dir, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ precheck: { rejectBelow: 0.1, model: "jev-latest" } }));
		invalidateGoalSettingsCache();
		assert.deepEqual(loadGoalSettings(dir, env).precheck, { enabled: true, model: "jev-latest", rejectBelow: 0.1 });
		writeFileSync(path.join(dir, ".pi", "pi-goal-x-settings.json"), JSON.stringify({ precheck: { rejectBelow: 0.9, apiKey: "x" } }));
		invalidateGoalSettingsCache();
		const snap = loadSettingsSnapshot(dir, env);
		assert.equal(snap.value.precheck?.rejectBelow, 0.2, "invalid project value falls back to global");
		assert.ok(snap.diagnostics.some((d) => d.settingPath === "precheck.rejectBelow"), "out-of-range rejectBelow reported");
		assert.ok(snap.diagnostics.some((d) => d.settingPath === "precheck.apiKey"), "keys are never accepted from settings");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── completion flow ──────────────────────────────────────────────────────────

function createHarness(cwd: string, goalId: string, deps: Record<string, unknown>) {
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
	const sessionEntries = [{ type: "custom", customType: "pi-goal-focus", data: goalFocusDetails(goalId, "created") }];
	const ctx = {
		cwd,
		hasUI: false,
		sessionManager: { getBranch: () => sessionEntries, getCwd: () => cwd, getSessionId: () => "precheck-session", getRoot: () => cwd },
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, onTerminalInput: () => () => {}, select: async () => undefined, confirm: async () => false, custom: async () => undefined },
		getSystemPrompt: () => "base prompt",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
	goalExtension(pi as any, deps as any);
	return { handlers, tools, ctx };
}

async function completeOnce(settings: Record<string, unknown>, precheckOutcome: PrecheckOutcome | null) {
	const cwd = mkdtempSync(path.join(tmpdir(), "precheck-flow-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "pi-goal-x-settings.json"), JSON.stringify(settings));
	const goal = writeActiveGoalFile({ cwd }, goalWith([task("a")]));
	const precheckCalls: unknown[] = [];
	const auditorCalls: any[] = [];
	const h = createHarness(cwd, goal.id, {
		runCompletionAuditor: async (args: any) => { auditorCalls.push(args); return { approved: true, disapproved: false, output: "ok\n<approved/>", model: "mock" }; },
		runEvidencePrecheck: async (args: unknown) => { precheckCalls.push(args); return precheckOutcome; },
	});
	await h.handlers.get("session_start")?.({ reason: "start" }, h.ctx);
	await h.handlers.get("before_agent_start")?.({ systemPrompt: "base", prompt: "test", systemPromptOptions: {} }, h.ctx);
	const result = await (h.tools.get("update_goal")!.execute as any)("u-1", { status: "complete" }, undefined, undefined, h.ctx);
	let events: Record<string, unknown>[] = [];
	try { events = readFileSync(goalLedgerPath({ cwd }), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch {}
	const activeFiles = readdirSync(path.join(cwd, ".pi", "goals")).filter((n) => n.startsWith("active_goal_"));
	rmSync(cwd, { recursive: true, force: true });
	const text = (result.content?.[0]?.text as string).replace(/active_goal_\S+\.md/g, "<goal-file>");
	return { text, events, precheckCalls, auditorCalls, activeFiles, terminate: result.terminate };
}

const REJECTED: PrecheckOutcome = { verdict: "rejected", model: "jev-1.13.0", items: [{ taskId: "a", pYes: 0.03 }], ms: 12 };

test("disabled by default: no pre-check call and no precheck_result", async () => {
	const out = await completeOnce({}, REJECTED);
	assert.equal(out.precheckCalls.length, 0);
	assert.ok(!out.events.some((e) => e.type === "precheck_result"));
	assert.equal(out.auditorCalls.length, 1);
});

test("enabled: records one log-only precheck_result before audit_result and changes nothing else", async () => {
	const off = await completeOnce({}, null);
	const on = await completeOnce({ precheck: { enabled: true } }, REJECTED);
	assert.equal(on.precheckCalls.length, 1);
	const results = on.events.filter((e) => e.type === "precheck_result");
	assert.equal(results.length, 1);
	assert.deepEqual({ ...results[0], at: undefined }, { type: "precheck_result", goalId: results[0]!.goalId, verdict: "rejected", enforced: false, model: "jev-1.13.0", items: [{ taskId: "a", pYes: 0.03 }], ms: 12, at: undefined });
	const types = on.events.map((e) => e.type);
	assert.ok(types.indexOf("precheck_result") < types.indexOf("audit_result"), "logged before the audit result");
	assert.equal(on.auditorCalls.length, 1, "a rejecting pre-check still runs the auditor");
	assert.equal(on.text, off.text, "tool result unchanged");
	assert.equal(on.terminate, off.terminate);
	assert.deepEqual(Object.keys(on.auditorCalls[0]).sort(), Object.keys(off.auditorCalls[0]).sort(), "auditor inputs unchanged");
	const summary = (call: any) => String(call.detailedSummary).replace(/active_goal_\S+\.md/g, "<goal-file>");
	assert.equal(summary(on.auditorCalls[0]), summary(off.auditorCalls[0]));
	assert.equal(on.activeFiles.length, 1, "approved goal awaits deferred archival as usual");
});

test("auditor disabled: the pre-check does not run", async () => {
	const out = await completeOnce({ disabled: true, precheck: { enabled: true } }, REJECTED);
	assert.equal(out.precheckCalls.length, 0);
	assert.ok(!out.events.some((e) => e.type === "precheck_result"));
});
