import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { gitBaseline, gitTaskDiff, taskNeedsCodeReview, taskReviewSkipReason } from "../extensions/goal-task-tools.ts";

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
		assert.match(diff, /tracked\.txt/);
		assert.match(diff, /after/);
		assert.match(diff, /new-untracked\.txt/);
		assert.doesNotMatch(diff, /old-untracked\.txt/);
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
