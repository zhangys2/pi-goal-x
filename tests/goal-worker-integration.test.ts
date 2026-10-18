import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer, type Socket } from "node:net";

import { integratePatch, patchPaths, uncommittedPaths } from "../extensions/goal-worker-integration.ts";
import { runIntegrationGit } from "../extensions/goal-integration-git.ts";

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

test("an already-cancelled integration never applies or commits a patch", async () => {
	const f = fixture((dir) => writeFileSync(path.join(dir, "b.txt"), "changed\n"));
	try {
		const controller = new AbortController();
		controller.abort();
		const before = f.head();
		const result = await integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "Cancelled", signal: controller.signal });
		assert.equal(result.outcome, "cancelled");
		assert.equal(f.head(), before);
		assert.equal(readFileSync(path.join(f.dir, "b.txt"), "utf8"), "bee\n");
	} finally { f.cleanup(); }
});

test("rollback preserves a patch path modified after application", async () => {
	const f = fixture((dir) => writeFileSync(path.join(dir, "a.txt"), "patch\n"));
	try {
		const before = f.head();
		const result = await integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "Do not overwrite", checks: [{ command: node, args: ["-e", "require('fs').writeFileSync('a.txt','NEW_EDIT\\n'); process.exit(1)"] }] });
		assert.equal(result.outcome, "checks_failed");
		assert.equal(f.head(), before);
		assert.equal(readFileSync(path.join(f.dir, "a.txt"), "utf8"), "NEW_EDIT\n");
		assert.deepEqual(result.leftover, ["a.txt"]);
		assert.match(result.message, /preserv|changed|user/i);
	} finally { f.cleanup(); }
});

test("patches cannot alter excluded goal runtime state", async () => {
	const f = fixture((dir) => {
		mkdirSync(path.join(dir, ".pi", "goals"), { recursive: true });
		writeFileSync(path.join(dir, ".pi", "goals", "goal_events.jsonl"), "worker\n");
	});
	try {
		mkdirSync(path.join(f.dir, ".pi", "goals"), { recursive: true });
		const state = path.join(f.dir, ".pi", "goals", "goal_events.jsonl");
		writeFileSync(state, "CURRENT_GOAL\n");
		const result = await integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "Unsafe" });
		assert.equal(result.outcome, "rejected");
		assert.equal(readFileSync(state, "utf8"), "CURRENT_GOAL\n");
	} finally { f.cleanup(); }
});

async function gate() {
	let connected!: (socket: Socket) => void;
	const connection = new Promise<Socket>((resolve) => { connected = resolve; });
	const server = createServer((socket) => { socket.on("error", () => {}); connected(socket); });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	const script = `const s=require('net').connect(${port},'127.0.0.1'); s.on('data',()=>{s.end();process.exit(0)});`;
	return { server, connection, script };
}

test("concurrent integrations are rejected by a repository lock", async () => {
	const f = fixture((dir) => writeFileSync(path.join(dir, "b.txt"), "changed\n"));
	const g = await gate();
	let socket: Socket | undefined;
	let pending: Promise<Awaited<ReturnType<typeof integratePatch>>> | undefined;
	try {
		pending = integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "First", checks: [{ command: node, args: ["-e", g.script] }] });
		socket = await g.connection;
		const second = await integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "Second" });
		assert.equal(second.outcome, "rejected");
		assert.match(second.message, /integration.*lock|integration.*running/i);
		socket.write("finish");
		assert.equal((await pending).outcome, "integrated");
	} finally {
		socket?.destroy();
		g.server.close();
		await pending;
		f.cleanup();
	}
});

test("cancelling during checks rolls back before any commit", async () => {
	const f = fixture((dir) => writeFileSync(path.join(dir, "b.txt"), "changed\n"));
	const g = await gate();
	const controller = new AbortController();
	let socket: Socket | undefined;
	try {
		const before = f.head();
		const pending = integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "Cancelled", signal: controller.signal, checks: [{ command: node, args: ["-e", g.script] }] });
		socket = await g.connection;
		controller.abort();
		const result = await pending;
		assert.equal(result.outcome, "cancelled");
		assert.equal(f.head(), before);
		assert.equal(readFileSync(path.join(f.dir, "b.txt"), "utf8"), "bee\n");
		assert.equal(result.leftover, undefined);
		assert.equal((await integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "Retry" })).outcome, "integrated", "rollback releases its lock");
	} finally { socket?.destroy(); g.server.close(); f.cleanup(); }
});

test("the repository integration lock also excludes another process", async () => {
	const f = fixture((dir) => writeFileSync(path.join(dir, "b.txt"), "changed\n"));
	const g = await gate();
	let socket: Socket | undefined;
	let pending: Promise<Awaited<ReturnType<typeof integratePatch>>> | undefined;
	try {
		pending = integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "First", checks: [{ command: node, args: ["-e", g.script] }] });
		socket = await g.connection;
		const moduleUrl = pathToFileURL(path.resolve("extensions/goal-worker-integration.ts")).href;
		const script = `import { integratePatch } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await integratePatch(${JSON.stringify({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "Second" })})));`;
		const { stdout } = await promisify(execFile)(node, ["--experimental-strip-types", "--input-type=module", "-e", script], { timeout: 10000 });
		const second = JSON.parse(stdout.trim());
		assert.equal(second.outcome, "rejected");
		assert.match(second.message, /integration.*running/i);
		socket.write("finish");
		assert.equal((await pending).outcome, "integrated");
	} finally { socket?.destroy(); g.server.close(); await pending; f.cleanup(); }
});

test("cancelling a running commit hook stops its process tree without advancing HEAD", async () => {
	const f = fixture((dir) => writeFileSync(path.join(dir, "b.txt"), "changed\n"));
	const g = await gate();
	const controller = new AbortController();
	let socket: Socket | undefined;
	try {
		const before = f.head();
		writeFileSync(path.join(f.dir, ".git", "hooks", "pre-commit"), `#!/bin/sh\nexec "${node.replaceAll("\\", "/")}" -e ${JSON.stringify(g.script)}\n`, { mode: 0o755 });
		const pending = integratePatch({ cwd: f.dir, patchPath: f.patchFile, commitMessage: "Cancelled hook", signal: controller.signal });
		socket = await g.connection;
		const closed = new Promise<void>((resolve) => socket!.once("close", resolve));
		controller.abort();
		const result = await pending;
		await closed;
		assert.equal(result.outcome, "cancelled");
		assert.equal(f.head(), before);
		assert.ok(readFileSync(path.join(f.dir, "b.txt"), "utf8") === "bee\n" || result.leftover?.includes("b.txt"), "any uncertain recovery must name preserved paths");
	} finally { socket?.destroy(); g.server.close(); f.cleanup(); }
});

test("Git execution times out instead of waiting indefinitely", async () => {
	const f = fixture((dir) => writeFileSync(path.join(dir, "b.txt"), "changed\n"));
	try {
		const result = await runIntegrationGit(f.dir, ["-c", `alias.wait=!"${node.replaceAll("\\", "/")}" -e "setInterval(()=>{},1000)"`, "wait"], undefined, undefined, 500);
		assert.equal(result.ok, false);
		assert.equal(result.timedOut, true);
		assert.match(result.stderr, /timed out/);
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
