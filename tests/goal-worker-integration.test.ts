import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { integratePatch, patchPaths, uncommittedPaths } from "../extensions/goal-worker-integration.ts";

const node = process.execPath;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * A repository with a worker patch made the way pi-subagents makes one: the
 * worker branches from `base`, and its patch is `git diff --binary base`.
 */
function fixture(worker: (dir: string) => void) {
	const dir = mkdtempSync(path.join(tmpdir(), "goal-integrate-"));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "test@example.invalid");
	git(dir, "config", "user.name", "Test");
	git(dir, "config", "core.autocrlf", "false");
	writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
	writeFileSync(path.join(dir, "b.txt"), "bee\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "base");
	const base = git(dir, "rev-parse", "HEAD").trim();
	git(dir, "switch", "-q", "-c", "worker");
	worker(dir);
	git(dir, "add", "-A");
	const patch = git(dir, "diff", "--cached", "--binary", "--no-color", "--no-ext-diff", base);
	git(dir, "commit", "-qm", "worker");
	git(dir, "switch", "-q", "main");
	git(dir, "branch", "-q", "-D", "worker");
	const patchFile = path.join(tmpdir(), `goal-integrate-${path.basename(dir)}.patch`);
	writeFileSync(patchFile, patch);
	const head = () => git(dir, "rev-parse", "HEAD").trim();
	const cleanup = () => { rmSync(dir, { recursive: true, force: true }); rmSync(patchFile, { force: true }); };
	return { dir, base, patchFile, head, cleanup };
}

test("a patch made on an older base applies on top, is committed, and leaves the tree clean", async () => {
	const f = fixture((dir) => {
		writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nTHREE\n");
		writeFileSync(path.join(dir, "new.txt"), "new\n");
	});
	try {
		writeFileSync(path.join(f.dir, "a.txt"), "ONE\ntwo\nthree\n");
		git(f.dir, "commit", "-qam", "main moved on");
		const before = f.head();
		const result = await integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "Integrate worker", checks: [{ command: node, args: ["-e", "process.exit(require('fs').readFileSync('a.txt','utf8') === 'ONE\\ntwo\\nTHREE\\n' ? 0 : 1)"] }] });
		assert.equal(result.outcome, "integrated", result.message);
		assert.notEqual(f.head(), before);
		assert.equal(git(f.dir, "rev-parse", "HEAD~1").trim(), before, "one commit on top of the current branch");
		assert.equal(readFileSync(path.join(f.dir, "a.txt"), "utf8"), "ONE\ntwo\nTHREE\n");
		assert.deepEqual(result.files?.sort(), ["a.txt", "new.txt"]);
		assert.equal(result.checkRun?.passed, true);
		assert.deepEqual(uncommittedPaths(f.dir, ""), []);
	} finally { f.cleanup(); }
});

test("a conflicting patch is reported and every path it touched is restored", async () => {
	const f = fixture((dir) => {
		writeFileSync(path.join(dir, "a.txt"), "one\nWORKER\nthree\n");
		writeFileSync(path.join(dir, "added.txt"), "added\n");
	});
	try {
		writeFileSync(path.join(f.dir, "a.txt"), "one\nMAIN\nthree\n");
		git(f.dir, "commit", "-qam", "conflicting change");
		const before = f.head();
		const result = await integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "Integrate worker" });
		assert.equal(result.outcome, "conflict", result.message);
		assert.match(result.message, /a\.txt/);
		assert.equal(f.head(), before);
		assert.equal(readFileSync(path.join(f.dir, "a.txt"), "utf8"), "one\nMAIN\nthree\n");
		assert.equal(existsSync(path.join(f.dir, "added.txt")), false, "a file the patch added is removed");
		assert.deepEqual(uncommittedPaths(f.dir, ""), []);
		assert.equal(result.leftover, undefined);
	} finally { f.cleanup(); }
});

test("a failing check undoes the applied patch", async () => {
	const f = fixture((dir) => { writeFileSync(path.join(dir, "b.txt"), "broken\n"); rmSync(path.join(dir, "a.txt")); });
	try {
		const before = f.head();
		const result = await integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "Integrate", checks: [{ command: node, args: ["-e", "process.exit(4)"] }] });
		assert.equal(result.outcome, "checks_failed");
		assert.match(result.message, /exit 4/);
		assert.equal(f.head(), before);
		assert.equal(readFileSync(path.join(f.dir, "b.txt"), "utf8"), "bee\n");
		assert.equal(readFileSync(path.join(f.dir, "a.txt"), "utf8"), "one\ntwo\nthree\n", "a deleted file is restored");
		assert.deepEqual(uncommittedPaths(f.dir, ""), []);
	} finally { f.cleanup(); }
});

test("a rejecting commit hook undoes the applied patch", async () => {
	const f = fixture((dir) => writeFileSync(path.join(dir, "b.txt"), "changed\n"));
	try {
		mkdirSync(path.join(f.dir, ".git", "hooks"), { recursive: true });
		writeFileSync(path.join(f.dir, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho HOOK_SAID_NO >&2\nexit 1\n", { mode: 0o755 });
		const before = f.head();
		const result = await integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "Integrate" });
		assert.equal(result.outcome, "commit_failed", result.message);
		assert.equal(f.head(), before);
		assert.equal(readFileSync(path.join(f.dir, "b.txt"), "utf8"), "bee\n");
	} finally { f.cleanup(); }
});

test("preconditions reject without touching the repository", async () => {
	const f = fixture((dir) => writeFileSync(path.join(dir, "b.txt"), "changed\n"));
	try {
		const empty = path.join(f.dir, "..", `${path.basename(f.dir)}-empty.patch`);
		writeFileSync(empty, "");
		try {
			assert.equal((await integratePatch({ cwd: f.dir, patchPath: empty, commitMessage: "x" })).outcome, "rejected");
		} finally { rmSync(empty, { force: true }); }
		assert.match((await integratePatch({ cwd: f.dir, patchPath: "missing.patch", commitMessage: "x" })).message, /not found/);
		assert.match((await integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: " " })).message, /commit_message/);

		writeFileSync(path.join(f.dir, "a.txt"), "user edit\n");
		const dirty = await integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "x" });
		assert.equal(dirty.outcome, "rejected");
		assert.match(dirty.message, /a\.txt/);
		assert.equal(readFileSync(path.join(f.dir, "a.txt"), "utf8"), "user edit\n", "the user's edit is untouched");
		git(f.dir, "checkout", "--", "a.txt");

		mkdirSync(path.join(f.dir, ".pi", "goals"), { recursive: true });
		writeFileSync(path.join(f.dir, ".pi", "goals", "goal_events.jsonl"), "{}\n");
		mkdirSync(path.join(f.dir, ".pi-subagents"), { recursive: true });
		writeFileSync(path.join(f.dir, ".pi-subagents", "run.json"), "{}\n");
		assert.deepEqual(uncommittedPaths(f.dir, ""), [], "goal and subagent runtime state does not count");
		assert.equal((await integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "x" })).outcome, "integrated");

		git(f.dir, "checkout", "-q", "--detach");
		assert.match((await integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "x" })).message, /detached/);
	} finally { f.cleanup(); }
});

test("patch paths include both sides of a rename", () => {
	const f = fixture((dir) => { git(dir, "mv", "b.txt", "c.txt"); });
	try {
		const parsed = patchPaths(f.dir, f.patchFile);
		assert.ok(parsed.ok);
		assert.deepEqual(parsed.paths.sort(), ["b.txt", "c.txt"]);
	} finally { f.cleanup(); }
});
