import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildGoalReportModel } from "../extensions/goal-report-model.ts";
import { goalSubagentArtifacts, renderGoalReport, reportFileName, writeGoalReport } from "../extensions/goal-report.ts";
import type { GoalRecord, GoalTask } from "../extensions/goal-record.ts";
import type { GoalLedgerEvent } from "../extensions/goal-ledger.ts";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function task(id: string, over: Partial<GoalTask> = {}): GoalTask {
	return { id, title: `Task ${id}`, status: "pending", ...over };
}

function fixture(over: Partial<GoalRecord> = {}, events: GoalLedgerEvent[] = []) {
	const goal = {
		id: "g1",
		objective: "=== Goal ===\nObjective: Finish the roadmap",
		status: "active",
		sisyphus: false,
		autoContinue: true,
		createdAt: "2026-09-17T02:30:00.000Z",
		updatedAt: at(5),
		usage: { tokensUsed: 120_000, activeSeconds: 3_600 },
		taskList: { tasks: [
			task("w1", { status: "complete", reviewBaseline: { revision: "r", untracked: {} }, evidence: "cargo test --workspace passes", subtasks: [task("w1a", { status: "complete" })] }),
			task("w2", { reviewBaseline: { revision: "r", untracked: {} }, verificationContract: "Bound the market channel." }),
		], blockCompletion: true, proposedAt: at(500) },
		...over,
	} as GoalRecord;
	return buildGoalReportModel({ goal, events, now: NOW });
}

test("the plan graph is plain and the current graph is styled per status", () => {
	const report = renderGoalReport(fixture(), { now: NOW });
	const plan = report.split("## Current state")[0]!;
	assert.match(plan, /## Plan\n\n```mermaid\nflowchart TD/);
	assert.match(plan, /t_w1\["w1: Task w1"\]/);
	assert.match(plan, /t_w1 --> t_w1a/);
	assert.doesNotMatch(plan, /classDef/, "the accepted plan carries no status styling");
	const current = report.split("## Current state")[1]!;
	assert.match(current, /classDef complete/);
	assert.match(current, /class t_w1 complete/);
	assert.match(current, /class t_w2 in_progress/);
});

test("mermaid labels are sanitised and truncated, and ids are identifier-safe", () => {
	const model = fixture({ taskList: { tasks: [task("w-1/a", { title: `Implement "quoted" [brackets] ${"x".repeat(120)}` })], blockCompletion: false, proposedAt: at(9) } });
	const report = renderGoalReport(model, { now: NOW });
	const line = report.split("\n").find((l) => l.includes("t_w_1_a["))!;
	assert.ok(line, "id is identifier-safe");
	const inner = line.slice(line.indexOf('["') + 2, line.lastIndexOf('"]'));
	assert.doesNotMatch(inner, /["[\]]/, "quotes and brackets are stripped from the label");
	assert.ok(inner.length <= 60, `label is truncated: ${inner.length}`);
});

test("an ordered plan adds declared-order edges, a regular plan does not", () => {
	const ordered = renderGoalReport(fixture({ sisyphus: true }), { now: NOW }).split("## Current state")[0]!;
	assert.match(ordered, /t_w1 -\.-> t_w2/);
	const regular = renderGoalReport(fixture(), { now: NOW }).split("## Current state")[0]!;
	assert.doesNotMatch(regular, /-\.->/);
});

test("the report quotes reviews and evidence and never claims to re-run them", () => {
	const events: GoalLedgerEvent[] = [
		{ type: "task_review", goalId: "g1", taskId: "w1", verdict: "disapproved", report: "missing tests", at: at(300) },
		{ type: "task_review", goalId: "g1", taskId: "w1", verdict: "approved", at: at(280) },
		{ type: "audit_result", goalId: "g1", verdict: "disapproved", report: "contract not met", at: at(100) },
	];
	const report = renderGoalReport(fixture({}, events), { now: NOW });
	assert.match(report, /Evidence \(quoted, not re-run\): cargo test --workspace passes/);
	assert.match(report, /\*\*disapproved\*\*: missing tests/);
	assert.match(report, /### Goal audits[\s\S]*\*\*disapproved\*\*: contract not met/);
});

test("empty sections are omitted and a table cell cannot break the table", () => {
	const bare = renderGoalReport(buildGoalReportModel({
		goal: { id: "g2", objective: "Do it", status: "active", sisyphus: false, autoContinue: false, createdAt: at(10), updatedAt: at(10), usage: { tokensUsed: 0, activeSeconds: 0 } } as GoalRecord,
		events: [],
		now: NOW,
	}), { now: NOW });
	for (const heading of ["## Plan", "## Current state", "## Tasks", "## Reviews", "## Attention", "## Subagent", "## Timeline", "## Recommendations"]) {
		assert.doesNotMatch(bare, new RegExp(heading), `${heading} is omitted when empty`);
	}
	assert.match(bare, /# Goal report: Do it/);

	const piped = renderGoalReport(fixture({ taskList: { tasks: [task("w1", { title: "a | b\nsecond line" })], blockCompletion: false, proposedAt: at(9) } }), { now: NOW });
	const row = piped.split("\n").find((l) => l.startsWith("| w1"))!;
	assert.match(row, /a \\\| b second line/);
	assert.equal((row.match(/(?<!\\)\|/g) ?? []).length, 7, "six columns: only the unescaped pipes delimit cells");
});

test("attention spans render their reason, attempts and fix", () => {
	const report = renderGoalReport(fixture(
		{ status: "blocked", pauseReason: "MSVC missing", pauseSuggestedAction: "Install it, then /goal-resume", blockedAttempts: ["unset CC"] },
		[{ type: "goal_blocked", goalId: "g1", reason: "MSVC missing", source: "agent", at: at(60) }],
	), { now: NOW });
	assert.match(report, /- \*\*blocked\*\* 2026-09-17 11:00:00Z \(still open\) — 1h/);
	assert.match(report, /Already tried: unset CC/);
	assert.match(report, /To fix: Install it, then \/goal-resume/);
});

test("recommendations name the task and their evidence", () => {
	const events: GoalLedgerEvent[] = [
		{ type: "task_review", goalId: "g1", taskId: "w2", verdict: "disapproved", report: "one", at: at(50) },
		{ type: "task_review", goalId: "g1", taskId: "w2", verdict: "disapproved", report: "two", at: at(40) },
		{ type: "task_review", goalId: "g1", taskId: "w2", verdict: "disapproved", report: "three", at: at(30) },
	];
	const report = renderGoalReport(fixture({}, events), { now: NOW });
	assert.match(report, /## Recommendations/);
	assert.match(report, /\*\*w2\*\* — Split or renegotiate "w2"/);
	assert.match(report, /Evidence: 3 disapproved task_review events/);
});

test("the report writes atomically under the goals directory and names itself after the goal", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-report-write-"));
	try {
		const model = fixture();
		assert.equal(reportFileName("g1", "2026-09-17T02:30:00.000Z"), "report_20260917023000_g1.md");
		const relPath = writeGoalReport({ cwd }, model, { now: NOW });
		assert.equal(relPath, ".pi/goals/reports/report_20260917023000_g1.md");
		const written = readFileSync(path.join(cwd, relPath), "utf8");
		assert.match(written, /# Goal report: Finish the roadmap/);
		assert.match(written, /safe to delete/);
		writeGoalReport({ cwd }, model, { now: NOW + 1000 });
		assert.match(readFileSync(path.join(cwd, relPath), "utf8"), /Generated 2026-09-17 12:00:01Z/, "regeneration replaces the file in place");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("subagent artifacts are listed by window, newest first, and bounded", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-report-artifacts-"));
	try {
		assert.deepEqual(goalSubagentArtifacts(cwd, { from: at(600), to: at(0) }), [], "no directory means no section");
		const dir = path.join(cwd, ".pi-subagents", "artifacts");
		mkdirSync(dir, { recursive: true });
		for (const [name, minutes] of [["old.md", 900], ["inside-a.md", 100], ["inside-b.md", 50], ["future.md", -10]] as const) {
			const file = path.join(dir, name);
			writeFileSync(file, name);
			const stamp = new Date(NOW - minutes * 60_000);
			utimesSync(file, stamp, stamp);
		}
		assert.deepEqual(goalSubagentArtifacts(cwd, { from: at(600), to: at(0) }), ["inside-b.md", "inside-a.md"]);
		const report = renderGoalReport(fixture(), { now: NOW, artifacts: ["inside-b.md"] });
		assert.match(report, /## Subagent artifacts[\s\S]*does not track child runs[\s\S]*`inside-b\.md`/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
