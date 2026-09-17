import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { gitBaseline, gitTaskDiff, openCodeTaskConflict, taskNeedsCodeReview, taskReviewSkipReason } from "../extensions/goal-task-review.ts";
import type { GoalTask } from "../extensions/goal-record.ts";

test("code-changing tasks require a review", () => {
	assert.equal(taskNeedsCodeReview({ title: "Implement the parser", verificationContract: "Tests pass", changedFiles: "src/parser.ts" }), true);
	assert.equal(taskNeedsCodeReview({ title: "Fix calibration bug", verificationContract: "pytest passes", changedFiles: "src/calibration.py" }), true);
	assert.equal(taskNeedsCodeReview({ title: "Update docs", verificationContract: "README is accurate", changedFiles: "README.md" }), false);
	assert.equal(taskNeedsCodeReview({ title: "Research prior art", verificationContract: "Sources are cited", changedFiles: "" }), false);
	assert.equal(taskNeedsCodeReview({ title: "Update docs", verificationContract: "README is accurate" }), true, "unknown changes fail closed");
});

test("explicit code-change labels override misleading task and evidence words", () => {
	assert.equal(taskNeedsCodeReview({ title: "Fix report CSV export", verificationContract: "Updated docs", evidence: "report.json", codeChange: true }), true);
	assert.equal(taskNeedsCodeReview({ title: "Implement plan loader", verificationContract: "Updated docs", codeChange: true }), true);
	assert.equal(taskNeedsCodeReview({ title: "Prepare report", verificationContract: "Updated docs and report.json", codeChange: false }), false);
});

test("task diff includes new untracked files and excludes pre-existing untracked files", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-task-diff-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd });
		execFileSync("git", ["config", "user.name", "Test"], { cwd });
		writeFileSync(path.join(cwd, "tracked.txt"), "before\n");
		writeFileSync(path.join(cwd, "old-untracked.txt"), "old\n");
		execFileSync("git", ["add", "tracked.txt"], { cwd });
		execFileSync("git", ["commit", "-qm", "baseline"], { cwd });
		const baseline = gitBaseline(cwd)!;
		writeFileSync(path.join(cwd, "tracked.txt"), "after\n");
		execFileSync("git", ["add", "tracked.txt"], { cwd });
		writeFileSync(path.join(cwd, "new-untracked.txt"), "new\n");
		const diff = gitTaskDiff(cwd, baseline);
		assert.match(diff, /tracked.txt/);
		assert.match(diff, /after/);
		assert.match(diff, /new-untracked.txt/);
		assert.doesNotMatch(diff, /old-untracked.txt/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("review controls skip disabled, excluded, and auditor-disabled reviews", () => {
	const task = { reviewType: "generated" };
	assert.equal(taskReviewSkipReason(task, { disableTaskReviews: true }), "Per-task reviews disabled in settings.");
	assert.equal(taskReviewSkipReason(task, { excludedTypes: ["Generated"] }), "Review type 'generated' excluded by settings.");
	assert.equal(taskReviewSkipReason(task, { auditorDisabled: true }), "Auditor disabled.");
	assert.equal(taskReviewSkipReason(task, {}), undefined);
});

test("legacy inference ignores completion evidence filenames and documentation words", () => {
	assert.equal(taskNeedsCodeReview({ title: "Fix report CSV export", verificationContract: "Export verified", evidence: "updated docs and report.json", changedFiles: "src/export.ts" }), true);
	assert.equal(taskNeedsCodeReview({ title: "Prepare report", verificationContract: "report.yaml generated", evidence: "test passed", changedFiles: "reports/report.yaml" }), false);
	assert.equal(taskNeedsCodeReview({ title: "Update documentation", verificationContract: "README updated", changedFiles: "docs/guide.md\nsrc/parser.ts mentioned in prose" }), false);
	assert.equal(taskNeedsCodeReview({ title: "Update documentation", verificationContract: "README updated", changedFiles: "docs/guide.md" }), false);
});

test("task diff includes edited pre-existing untracked files and new files named in the tracked diff", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-task-diff-untracked-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd });
		execFileSync("git", ["config", "user.name", "Test"], { cwd });
		writeFileSync(path.join(cwd, "tracked.txt"), "before\n");
		writeFileSync(path.join(cwd, "notes.ts"), "old\n");
		execFileSync("git", ["add", "tracked.txt"], { cwd });
		execFileSync("git", ["commit", "-qm", "baseline"], { cwd });
		const baseline = gitBaseline(cwd)!;
		writeFileSync(path.join(cwd, "tracked.txt"), "see fresh.ts\n");
		writeFileSync(path.join(cwd, "notes.ts"), "EDITED_UNTRACKED\n");
		writeFileSync(path.join(cwd, "fresh.ts"), "FRESH_CONTENT\n");
		const diff = gitTaskDiff(cwd, baseline);
		assert.match(diff, /EDITED_UNTRACKED/, "an untracked file edited during the task is reviewed");
		assert.match(diff, /FRESH_CONTENT/, "a new file is not dropped because its name appears in the tracked diff");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("an oversized task diff says it is truncated and lists every changed file", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-task-diff-truncated-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd });
		execFileSync("git", ["config", "user.name", "Test"], { cwd });
		writeFileSync(path.join(cwd, "tracked.txt"), "before\n");
		execFileSync("git", ["add", "tracked.txt"], { cwd });
		execFileSync("git", ["commit", "-qm", "baseline"], { cwd });
		const baseline = gitBaseline(cwd)!;
		writeFileSync(path.join(cwd, "big.ts"), "x".repeat(130000));
		writeFileSync(path.join(cwd, "small.ts"), "SMALL_CONTENT\n");
		const diff = gitTaskDiff(cwd, baseline);
		assert.match(diff, /truncated/i, "the reviewer is told the diff is incomplete");
		assert.doesNotMatch(diff, /SMALL_CONTENT/, "fixture: small.ts content falls past the limit");
		assert.match(diff, /small.ts/, "files past the limit are still named");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("task diff leaves out goal and subagent runtime state that is not ignored", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-task-diff-runtime-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd });
		execFileSync("git", ["config", "user.name", "Test"], { cwd });
		writeFileSync(path.join(cwd, "src.rs"), "before\n");
		execFileSync("git", ["add", "."], { cwd });
		execFileSync("git", ["commit", "-qm", "baseline"], { cwd });
		const baseline = gitBaseline(cwd)!;
		mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
		mkdirSync(path.join(cwd, ".pi-subagents", "artifacts"), { recursive: true });
		writeFileSync(path.join(cwd, ".pi", "goals", "goal_events.jsonl"), "{}\n");
		writeFileSync(path.join(cwd, ".pi", ".goals-pool-snapshot.json"), "{}\n");
		writeFileSync(path.join(cwd, ".pi-subagents", "artifacts", "run_output.md"), "child\n");
		writeFileSync(path.join(cwd, ".pi", "project-skill.md"), "project file\n");
		writeFileSync(path.join(cwd, "src.rs"), "after\n");
		const diff = gitTaskDiff(cwd, baseline);
		assert.match(diff, /src\.rs/);
		assert.match(diff, /project-skill\.md/, "other .pi files are still project changes");
		assert.doesNotMatch(diff, /goal_events|goals-pool-snapshot|pi-subagents/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a started code task blocks starting an unrelated code task", () => {
	const baseline = { revision: "abc", untracked: {} };
	const task = (id: string, extra: Partial<GoalTask> = {}): GoalTask => ({ id, title: id, status: "pending", ...extra });
	const tasks = [
		task("w1", { codeChange: true, reviewBaseline: baseline, subtasks: [task("w1a", { codeChange: true })] }),
		task("w2", { codeChange: true }),
		task("docs", { codeChange: false }),
		task("done", { codeChange: true, status: "complete", reviewBaseline: baseline }),
	];
	assert.equal(openCodeTaskConflict(tasks, "w2")?.id, "w1");
	assert.equal(openCodeTaskConflict(tasks, "w1"), undefined, "restarting the open task is allowed");
	assert.equal(openCodeTaskConflict(tasks, "w1a"), undefined, "a subtask of the open task is allowed");
	assert.equal(openCodeTaskConflict(tasks, "docs"), undefined, "a task that changes no code is allowed");
	assert.equal(openCodeTaskConflict([tasks[1]!, tasks[3]!], "w2"), undefined, "completed tasks are not open");
});
