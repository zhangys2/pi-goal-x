import assert from "node:assert/strict";
import test from "node:test";

import { buildGoalReportModel, REPORT_REJECTION_THRESHOLD } from "../extensions/goal-report-model.ts";
import type { GoalLedgerEvent } from "../extensions/goal-ledger.ts";
import type { GoalRecord, GoalTask } from "../extensions/goal-record.ts";

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function task(id: string, over: Partial<GoalTask> = {}): GoalTask {
	return { id, title: `Task ${id}`, status: "pending", ...over };
}

function goal(over: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g1",
		objective: "=== Goal ===\nObjective: Finish the roadmap",
		status: "active",
		sisyphus: false,
		autoContinue: true,
		createdAt: at(600),
		updatedAt: at(5),
		usage: { tokensUsed: 120_000, activeSeconds: 3_600 },
		...over,
	} as GoalRecord;
}

const baseline = { revision: "abc", untracked: {} };

test("the plan keeps the confirmed shape while current state reflects progress", () => {
	const model = buildGoalReportModel({
		now: NOW,
		goal: goal({
			taskList: { tasks: [
				task("w1", { status: "complete", reviewBaseline: baseline, subtasks: [task("w1a", { status: "complete" })] }),
				task("w2", { reviewBaseline: baseline }),
				task("w3"),
				task("w4", { status: "skipped", skipReason: "user asked" }),
			], blockCompletion: true, proposedAt: at(500) },
		}),
		events: [],
	});
	assert.deepEqual(model.plan.map((n) => [n.id, n.parentId, n.order, n.state]), [
		["w1", undefined, 0, "pending"],
		["w1a", "w1", 0, "pending"],
		["w2", undefined, 1, "pending"],
		["w3", undefined, 2, "pending"],
		["w4", undefined, 3, "pending"],
	], "the plan graph is the accepted plan, not progress");
	assert.deepEqual(model.current.map((n) => [n.id, n.state]), [
		["w1", "complete"], ["w1a", "complete"], ["w2", "in_progress"], ["w3", "pending"], ["w4", "skipped"],
	]);
	assert.equal(model.auditorEnabled, true);
	assert.equal(model.tokensUsed, 120_000);
});

test("rejections count per task, reset on approval, and drive the only numeric rule", () => {
	const events: GoalLedgerEvent[] = [
		{ type: "task_started", goalId: "g1", taskId: "w5", at: at(300) },
		{ type: "task_review", goalId: "g1", taskId: "w5", verdict: "disapproved", report: "bounded feed missing", at: at(250) },
		{ type: "task_review", goalId: "g1", taskId: "w5", verdict: "disapproved", report: "still unbounded", at: at(200) },
		{ type: "task_review", goalId: "g1", taskId: "w5", verdict: "error", report: "provider failed", at: at(190) },
		{ type: "task_review", goalId: "g1", taskId: "w5", verdict: "disapproved", report: "scope too wide", at: at(150) },
		{ type: "task_review", goalId: "g1", taskId: "w6", verdict: "disapproved", report: "docs drift", at: at(140) },
		{ type: "task_review", goalId: "g1", taskId: "w6", verdict: "approved", at: at(130) },
		{ type: "task_complete", goalId: "g1", taskId: "w6", evidence: "cargo test passes", at: at(130) },
	];
	const model = buildGoalReportModel({
		now: NOW,
		goal: goal({ taskList: { tasks: [task("w5", { reviewBaseline: baseline }), task("w6", { status: "complete", evidence: "cargo test passes" })], blockCompletion: false, proposedAt: at(400) } }),
		events,
	});
	const w5 = model.tasks.find((t) => t.id === "w5")!;
	assert.equal(w5.attempts, 3, "errors do not count as rejections");
	assert.equal(w5.state, "retrying");
	assert.equal(model.tasks.find((t) => t.id === "w6")!.attempts, 0, "an approval clears the count");
	assert.equal(model.reviews.length, 6);
	const repeat = model.recommendations.filter((r) => r.rule === "repeat_rejection");
	assert.equal(repeat.length, 1);
	assert.equal(repeat[0]!.taskId, "w5");
	assert.match(repeat[0]!.evidence, new RegExp(`${REPORT_REJECTION_THRESHOLD} disapproved`));
});

test("overlapping code tasks are reported once per later start", () => {
	const events: GoalLedgerEvent[] = [
		{ type: "task_started", goalId: "g1", taskId: "w1", at: at(300) },
		{ type: "task_started", goalId: "g1", taskId: "w2", at: at(290) },
		{ type: "task_complete", goalId: "g1", taskId: "w1", evidence: "cargo test", at: at(280) },
		{ type: "task_started", goalId: "g1", taskId: "w3", at: at(270) },
	];
	const model = buildGoalReportModel({ now: NOW, goal: goal(), events });
	const overlaps = model.recommendations.filter((r) => r.rule === "overlapping_tasks");
	// Each start that lands on an open task is its own violation: w2 overlapped w1, and w3 overlapped w2.
	assert.deepEqual(overlaps.map((r) => r.taskId), ["w2", "w3"]);
	assert.match(overlaps[0]!.evidence, /w1 started/);
});

test("blocks, pauses and resumes become measured spans, and the open one runs to now", () => {
	const events: GoalLedgerEvent[] = [
		{ type: "goal_paused", goalId: "g1", reason: "no disposition", source: "agent", at: at(120) },
		{ type: "goal_resumed", goalId: "g1", reason: "user", at: at(90) },
		{ type: "goal_blocked", goalId: "g1", reason: "MSVC missing", source: "agent", at: at(60) },
	];
	const model = buildGoalReportModel({
		now: NOW,
		goal: goal({ status: "blocked", pauseReason: "MSVC missing", pauseSuggestedAction: "Install the toolchain, then /goal-resume", blockedAttempts: ["unset CC", "clang-cl"] }),
		events,
	});
	assert.deepEqual(model.attention.map((s) => [s.kind, s.seconds, s.open]), [["paused", 1800, false], ["blocked", 3600, true]]);
	const blocked = model.attention[1]!;
	assert.equal(blocked.suggestedAction, "Install the toolchain, then /goal-resume");
	assert.deepEqual(blocked.attempts, ["unset CC", "clang-cl"]);
});

test("a live wait is reported with its deadline, and an expired wait recommends the fix", () => {
	const waiting = buildGoalReportModel({
		now: NOW,
		goal: goal({ scheduler: { version: 1, owner: "s", generation: "g", used: 1, phase: "waiting", repairUsed: false, decision: { kind: "wait" }, wait: { id: "w", token: "t", reason: "Await the remote build", deadline: NOW + 3 * 60 * 60_000 } } }),
		events: [],
	});
	const wait = waiting.attention.find((s) => s.kind === "wait")!;
	assert.match(wait.reason, /Await the remote build \(deadline 2026-09-17T15:00:00\.000Z\)/);
	assert.equal(wait.seconds, 300, "measured from the goal's last update to now");
	assert.equal(waiting.recommendations.some((r) => r.rule === "wait_expired"), false);

	const expired = buildGoalReportModel({
		now: NOW,
		goal: goal({ status: "paused" }),
		events: [{ type: "goal_paused", goalId: "g1", reason: "Wait deadline reached without the expected signal: Await the remote build", source: "agent", at: at(30) }],
	});
	const recommendation = expired.recommendations.find((r) => r.rule === "wait_expired")!;
	assert.match(recommendation.text, /belongs in a block/);
	assert.match(recommendation.evidence, /deadline reached/);
});

test("completions without a named verification command are flagged, code-free tasks are not", () => {
	const model = buildGoalReportModel({
		now: NOW,
		goal: goal({ taskList: { tasks: [
			task("code", { status: "complete", codeChange: true, evidence: "implemented the bridge" }),
			task("verified", { status: "complete", codeChange: true, evidence: "cargo test --workspace passes" }),
			task("docs", { status: "complete", codeChange: false, evidence: "rewrote the section" }),
		], blockCompletion: false, proposedAt: at(400) } }),
		events: [],
	});
	assert.deepEqual(model.recommendations.filter((r) => r.rule === "unverified_completion").map((r) => r.taskId), ["code"]);
});

test("a task changing a file its contract forbade is reported as scope drift", () => {
	const model = buildGoalReportModel({
		now: NOW,
		goal: goal({ taskList: { tasks: [
			task("w4", { status: "complete", codeChange: true, evidence: "cargo test passes", verificationContract: "Add the client. Do not modify docs/spec-improvements.md." }),
			task("w5", { status: "complete", codeChange: true, evidence: "cargo test passes", verificationContract: "Bound the channels." }),
		], blockCompletion: false, proposedAt: at(400) } }),
		events: [],
		changedFiles: { w4: ["barter-execution/src/client/binance/mod.rs", "docs/spec-improvements.md"], w5: ["barter/src/system/mod.rs"] },
	});
	const drift = model.recommendations.filter((r) => r.rule === "scope_drift");
	assert.deepEqual(drift.map((r) => r.taskId), ["w4"]);
	assert.match(drift[0]!.text, /docs\/spec-improvements\.md/);
});

test("an untouched goal reports no tasks, no spans and no recommendations", () => {
	const model = buildGoalReportModel({ now: NOW, goal: goal(), events: [{ type: "goal_created", goalId: "g1", objective: "x", sisyphus: false, autoContinue: true, at: at(600) }] });
	assert.deepEqual(model.plan, []);
	assert.deepEqual(model.tasks, []);
	assert.deepEqual(model.attention, []);
	assert.deepEqual(model.recommendations, []);
	assert.deepEqual(model.timeline, [{ at: at(600), text: "goal created" }]);
});
