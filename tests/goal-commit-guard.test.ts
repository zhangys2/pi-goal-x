import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { clearCommitGuardAsk, commandCommitsEverything, commitGuardBlockReason, preexistingDirtyPaths } from "../extensions/goal-commit-guard.ts";
import { gitBaseline } from "../extensions/goal-task-review.ts";

function repo(): string {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-commit-guard-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
	git("init", "-q");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "Test");
	writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n");
	writeFileSync(path.join(cwd, "user-work.rs"), "v0\n");
	writeFileSync(path.join(cwd, "goal-work.rs"), "v0\n");
	git("add", ".");
	git("commit", "-qm", "baseline");
	return cwd;
}

test("only sweeping stage/commit commands are guarded", () => {
	for (const command of ["git add -A && git commit -m x", "git commit -am 'x'", "git add . && git commit -m x", "git commit --all -m x", "git add :/ && git commit -m x"]) {
		assert.equal(commandCommitsEverything(command), true, command);
	}
	for (const command of ["git commit -m x src/lib.rs", "git add src/lib.rs && git commit -m x", "git status --short", "git add -A", "git log --all --oneline"]) {
		assert.equal(commandCommitsEverything(command), false, command);
	}
});

test("pre-existing dirty paths exclude the goal's own later changes", () => {
	const cwd = repo();
	try {
		writeFileSync(path.join(cwd, "user-work.rs"), "user edit\n");
		writeFileSync(path.join(cwd, "user-untracked.rs"), "user file\n");
		mkdirSync(path.join(cwd, ".pi", "goals"), { recursive: true });
		writeFileSync(path.join(cwd, ".pi", "goals", "goal_events.jsonl"), "{}\n");
		const baseline = gitBaseline(cwd)!;
		writeFileSync(path.join(cwd, "goal-work.rs"), "goal edit\n");
		assert.deepEqual(preexistingDirtyPaths(cwd, baseline), ["user-untracked.rs", "user-work.rs"]);
		execFileSync("git", ["add", "."], { cwd });
		execFileSync("git", ["commit", "-qm", "user work committed"], { cwd });
		assert.deepEqual(preexistingDirtyPaths(cwd, baseline), [], "nothing pre-existing is still dirty");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("files the goal committed itself are not the user's pre-existing work", () => {
	for (const dirtyStart of [false, true]) {
		const cwd = repo();
		try {
			if (dirtyStart) writeFileSync(path.join(cwd, "user-work.rs"), "user edit\n");
			const baseline = gitBaseline(cwd)!;
			writeFileSync(path.join(cwd, "goal-work.rs"), "goal edit\n");
			execFileSync("git", ["commit", "-qm", "goal work", "goal-work.rs"], { cwd });
			writeFileSync(path.join(cwd, "goal-work.rs"), "goal edit again\n");
			assert.deepEqual(preexistingDirtyPaths(cwd, baseline), dirtyStart ? ["user-work.rs"] : [], `dirty start: ${dirtyStart}`);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	}
});

function core(cwd: string, goal: unknown) {
	return { state: { goal } } as never;
}

test("a sweeping commit is blocked until the user answers, then proceeds", () => {
	const cwd = repo();
	try {
		writeFileSync(path.join(cwd, "user-work.rs"), "user edit\n");
		const baseline = gitBaseline(cwd)!;
		writeFileSync(path.join(cwd, "goal-work.rs"), "goal edit\n");
		const goal = { id: "g1", status: "active", taskList: { tasks: [], blockCompletion: false, proposedAt: "now", reviewBaseline: baseline } };
		const ctx = { cwd } as never;
		clearCommitGuardAsk("g1");
		const blocked = commitGuardBlockReason(core(cwd, goal), ctx, "git add -A && git commit -m 'checkpoint'");
		assert.match(blocked!, /already changed before this goal started/);
		assert.match(blocked!, /- user-work\.rs/);
		assert.doesNotMatch(blocked!, /goal-work\.rs/);
		assert.ok(commitGuardBlockReason(core(cwd, goal), ctx, "git commit -am 'checkpoint'"), "retrying before the user answers is still blocked");
		clearCommitGuardAsk("g1");
		assert.equal(commitGuardBlockReason(core(cwd, goal), ctx, "git add -A && git commit -m 'checkpoint'"), undefined, "after the user answers, the approved commit proceeds");
		clearCommitGuardAsk("g1");
		assert.equal(commitGuardBlockReason(core(cwd, goal), ctx, "git add -A && git commit -m 'checkpoint'"), undefined, "the goal is asked once");
		assert.equal(commitGuardBlockReason(core(cwd, goal), ctx, "git commit -m 'scoped' goal-work.rs"), undefined, "naming the goal's own paths is allowed");
		assert.equal(commitGuardBlockReason(core(cwd, { ...goal, status: "paused" }), ctx, "git add -A && git commit -m x"), undefined);
		assert.equal(commitGuardBlockReason(core(cwd, null), ctx, "git add -A && git commit -m x"), undefined);
		assert.equal(commitGuardBlockReason(core(cwd, { ...goal, taskList: undefined }), ctx, "git add -A && git commit -m x"), undefined, "without a baseline there is nothing to compare");
	} finally { clearCommitGuardAsk(null); rmSync(cwd, { recursive: true, force: true }); }
});

test("a clean start leaves sweeping commits alone", () => {
	const cwd = repo();
	try {
		const baseline = gitBaseline(cwd)!;
		writeFileSync(path.join(cwd, "goal-work.rs"), "goal edit\n");
		const goal = { id: "g2", status: "active", taskList: { tasks: [], blockCompletion: false, proposedAt: "now", reviewBaseline: baseline } };
		assert.equal(commitGuardBlockReason(core(cwd, goal), { cwd } as never, "git add -A && git commit -m 'goal work'"), undefined);
	} finally { clearCommitGuardAsk(null); rmSync(cwd, { recursive: true, force: true }); }
});
