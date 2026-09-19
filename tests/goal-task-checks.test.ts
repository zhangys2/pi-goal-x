import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { formatCheckFailure, formatCheckResults, parseTaskChecks, runTaskChecks, spawnPlan } from "../extensions/goal-task-checks.ts";

const node = process.execPath;

test("passing checks run in order and record each command", async () => {
	const run = await runTaskChecks(process.cwd(), [
		{ command: node, args: ["-e", "process.exit(0)"] },
		{ command: node, args: ["-e", "console.log('second')"] },
	]);
	assert.equal(run.passed, true);
	assert.equal(run.results.length, 2);
	assert.deepEqual(run.results.map((r) => r.exitCode), [0, 0]);
	assert.equal(run.results[1]!.output, undefined, "passing checks keep no output");
});

test("the first failing check stops the run and keeps its output tail", async () => {
	const run = await runTaskChecks(process.cwd(), [
		{ command: node, args: ["-e", "console.log('x'.repeat(9000)); console.error('BROKEN_TAIL'); process.exit(3)"] },
		{ command: node, args: ["-e", "process.exit(0)"] },
	]);
	assert.equal(run.passed, false);
	assert.equal(run.results.length, 1, "later checks do not run");
	assert.equal(run.results[0]!.exitCode, 3);
	assert.match(run.results[0]!.output ?? "", /BROKEN_TAIL$/m);
	assert.ok((run.results[0]!.output ?? "").length <= 4000);
	assert.match(formatCheckFailure(run), /exit 3/);
});

test("a check that runs past its timeout is killed and fails", async () => {
	const started = Date.now();
	const run = await runTaskChecks(process.cwd(), [{ command: node, args: ["-e", "setTimeout(() => {}, 60000)"], timeoutSeconds: 1 }]);
	assert.equal(run.passed, false);
	assert.equal(run.results[0]!.timedOut, true);
	assert.ok(Date.now() - started < 20000, "the process is killed, not awaited");
	assert.match(formatCheckResults(run), /timed out/);
});

test("an aborted run kills the running check", async () => {
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 200);
	const run = await runTaskChecks(process.cwd(), [{ command: node, args: ["-e", "setTimeout(() => {}, 60000)"] }], { signal: controller.signal });
	assert.equal(run.passed, false);
	assert.equal(run.results[0]!.aborted, true);
});

test("a missing command fails without throwing", async () => {
	const run = await runTaskChecks(process.cwd(), [{ command: "definitely-not-a-command-goal-x", args: [] }]);
	assert.equal(run.passed, false);
	assert.ok(run.results[0]!.error || run.results[0]!.exitCode !== 0);
});

test("arguments are passed literally, without a shell", async () => {
	const run = await runTaskChecks(process.cwd(), [{ command: node, args: ["-e", "process.exit(process.argv[1] === 'a && b | $HOME *' ? 0 : 1)", "a && b | $HOME *"] }]);
	assert.equal(run.passed, true);
});

test("check input is validated", () => {
	assert.deepEqual(parseTaskChecks("t", undefined), { ok: true });
	assert.deepEqual(parseTaskChecks("t", [{ command: " npm ", args: ["test"] }]), { ok: true, checks: [{ command: "npm", args: ["test"] }] });
	assert.deepEqual(parseTaskChecks("t", [{ command: "npm", timeout_seconds: 90.5 }]), { ok: true, checks: [{ command: "npm", args: [], timeoutSeconds: 91 }] });
	assert.equal(parseTaskChecks("t", [{ command: "" }]).ok, false);
	assert.equal(parseTaskChecks("t", [{ command: "npm", args: "test" }]).ok, false);
	assert.equal(parseTaskChecks("t", [{ command: "npm", timeout_seconds: 99999 }]).ok, false);
	assert.equal(parseTaskChecks("t", Array.from({ length: 9 }, () => ({ command: "npm" }))).ok, false);
});

test("Windows .cmd files run through cmd.exe with escaped arguments", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "goal-check-cmd-"));
	try {
		writeFileSync(path.join(dir, "tool.cmd"), "@echo off\r\n");
		const plan = spawnPlan({ command: "tool", args: ["a b", "x&y"] }, dir, { PATH: dir, PATHEXT: ".EXE;.CMD", ComSpec: "cmd.exe" }, "win32");
		assert.equal(plan.file, "cmd.exe");
		assert.equal(plan.verbatim, true);
		assert.deepEqual(plan.args.slice(0, 3), ["/d", "/s", "/c"]);
		assert.match(plan.args[3]!, /tool\.cmd/i);
		assert.match(plan.args[3]!, /\^"a\^ b\^"/, "spaces are quoted and escaped");
		assert.match(plan.args[3]!, /x\^&y/, "cmd metacharacters are escaped");
		assert.deepEqual(spawnPlan({ command: "tool", args: [] }, dir, {}, "linux"), { file: "tool", args: [], verbatim: false });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a real .cmd receives its arguments unchanged", { skip: process.platform !== "win32" }, async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "goal-check-cmd-real-"));
	try {
		writeFileSync(path.join(dir, "echo-args.cmd"), `@"${node}" -e "process.exit(JSON.stringify(process.argv.slice(1)) === JSON.stringify(['a b', 'x&y', 'q%%PATH%%']) ? 0 : 7)" %*\r\n`);
		const run = await runTaskChecks(dir, [{ command: "echo-args", args: ["a b", "x&y", "q%PATH%"] }], { env: { ...process.env, PATH: `${dir};${process.env.PATH}` } });
		assert.equal(run.passed, true, JSON.stringify(run.results));
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
