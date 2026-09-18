import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultWorkerWorktree, detectProjectOrchestration, keepIsolatedWorkersForeground, offerProjectOrchestrationSetup, writeIgnoreRules } from "../extensions/goal-project-config.ts";

function repo(): string {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-project-config-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
	git("init", "-q");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "Test");
	writeFileSync(path.join(cwd, "src.rs"), "v0\n");
	git("add", ".");
	git("commit", "-qm", "baseline");
	return cwd;
}

function harness(cwd: string, answer: string | undefined, hasUI = true) {
	const prompts: string[] = [];
	const notices: string[] = [];
	const ctx = { cwd, hasUI, ui: { select: async (title: string, options: string[]) => { prompts.push(title); return answer === undefined ? undefined : options.find((option) => option.startsWith(answer)); }, notify: (message: string) => { notices.push(message); } } };
	const core = { enterGoalModal: () => {}, exitGoalModal: () => {} };
	return { prompts, notices, offer: () => offerProjectOrchestrationSetup(core as never, ctx as never) };
}

test("outside a git repository there is nothing to detect", () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-project-config-nogit-"));
	try {
		assert.equal(detectProjectOrchestration(cwd), undefined);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("detection reports existing Pi config and which runtime paths are not ignored", () => {
	const cwd = repo();
	try {
		assert.deepEqual(detectProjectOrchestration(cwd), { prefix: "", subagentSettings: false, projectAgents: [], unignored: [".pi/goals/", ".pi/.goals-pool-snapshot.json", ".pi-subagents/"] });
		mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ subagents: { projectRootResolution: "git-root" } }));
		writeFileSync(path.join(cwd, ".pi", "agents", "worker.md"), "---\nname: worker\n---\n");
		writeFileSync(path.join(cwd, ".gitignore"), ".pi/\n");
		assert.deepEqual(detectProjectOrchestration(cwd), { prefix: "", subagentSettings: true, projectAgents: ["worker.md"], unignored: [".pi-subagents/"] });
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("ignore rules are anchored to the project directory inside the repository", () => {
	const root = repo();
	try {
		const cwd = path.join(root, "packages", "app");
		mkdirSync(cwd, { recursive: true });
		const found = detectProjectOrchestration(cwd)!;
		assert.equal(found.prefix, "packages/app/");
		const file = writeIgnoreRules(cwd, found, "gitignore");
		assert.equal(path.resolve(file), path.resolve(root, ".gitignore"));
		assert.match(readFileSync(file, "utf8"), /^\/packages\/app\/\.pi\/goals\/$/m);
		assert.deepEqual(detectProjectOrchestration(cwd)!.unignored, []);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("the setup offer explains why and writes only the destination the user picks", async () => {
	for (const [answer, expectExclude, expectGitignore] of [["Skip", false, false], ["Add to .git/info/exclude", true, false], ["Add to .gitignore", false, true], [undefined, false, false]] as const) {
		const cwd = repo();
		try {
			const h = harness(cwd, answer);
			await h.offer();
			assert.equal(h.prompts.length, 1);
			assert.match(h.prompts[0]!, /worktree isolation refuses to start/);
			assert.match(h.prompts[0]!, /Existing project orchestration config: none/);
			assert.equal(/pi-goal-x runtime state/.test(readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf8")), expectExclude);
			assert.equal(existsSync(path.join(cwd, ".gitignore")), expectGitignore);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	}
});

test("the setup offer asks once per repository and never writes without a UI", async () => {
	const cwd = repo();
	try {
		const headless = harness(cwd, "Add to .gitignore", false);
		await headless.offer();
		assert.equal(headless.prompts.length, 0);
		assert.match(headless.notices[0]!, /No changes were made/);
		assert.equal(existsSync(path.join(cwd, ".gitignore")), false);
		const again = harness(cwd, "Add to .gitignore");
		await again.offer();
		assert.equal(again.prompts.length, 0, "the repository was already offered this session");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("implementation worker launches default to managed worktrees on a clean tree", () => {
	const cwd = repo();
	try {
		const worker = { workflowScript: "return (await runs.run('impl', {agent:'worker', task:'build'})).output" };
		assert.equal(defaultWorkerWorktree(worker, cwd), true);
		assert.equal((worker as Record<string, unknown>).worktree, true);
		const alias = { tasks: [{ agent: "scout", task: "map" }, { agent: "implementer", task: "build" }] };
		assert.equal(defaultWorkerWorktree(alias, cwd), true);
		const explicit = { workflowScript: "runs.run('a', {agent:\"worker\", task:'x'})", worktree: false };
		assert.equal(defaultWorkerWorktree(explicit, cwd), false);
		assert.equal(explicit.worktree, false, "an explicit choice is kept");
		const readOnly = { workflowScript: "runs.all([{key:'m', agent:'scout', task:'map'}])" };
		assert.equal(defaultWorkerWorktree(readOnly, cwd), false);
		assert.equal("worktree" in readOnly, false);
		mkdirSync(path.join(cwd, ".pi-subagents"), { recursive: true });
		writeFileSync(path.join(cwd, ".pi-subagents", "state.json"), "{}");
		assert.equal(defaultWorkerWorktree({ tasks: [{ agent: "worker", task: "x" }] }, cwd), true, "subagent state does not make the tree dirty");
		writeFileSync(path.join(cwd, "src.rs"), "dirty\n");
		const dirty = { tasks: [{ agent: "worker", task: "x" }] };
		assert.equal(defaultWorkerWorktree(dirty, cwd), false, "pi-subagents would refuse isolation on a dirty tree");
		assert.equal("worktree" in dirty, false);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("isolated implementation workers run in the foreground unless async is explicit", () => {
	const script = (extra: string) => ({ workflowScript: `return runs.run('impl', {agent:'worker', ${extra} task:'build'})` });
	const inScript = script("worktree:true,");
	assert.equal(keepIsolatedWorkersForeground(inScript), true, "worktree:true inside the script");
	assert.equal((inScript as Record<string, unknown>).async, false);

	const topLevel = { ...script(""), worktree: true };
	assert.equal(keepIsolatedWorkersForeground(topLevel), true, "worktree:true at the top level, as defaultWorkerWorktree sets it");
	assert.equal((topLevel as Record<string, unknown>).async, false);

	const explicitAsync = { ...script("worktree:true,"), async: true };
	assert.equal(keepIsolatedWorkersForeground(explicitAsync), false);
	assert.equal(explicitAsync.async, true, "an explicit choice is kept");

	const shared = script("worktree:false,");
	assert.equal(keepIsolatedWorkersForeground(shared), false, "no isolation requested, nothing to protect");
	assert.equal("async" in shared, false);

	const scout = { workflowScript: "return runs.run('map', {agent:'scout', worktree:true, task:'map'})" };
	assert.equal(keepIsolatedWorkersForeground(scout), false, "read-only agents stay async");

	const management = { action: "list", worktree: true };
	assert.equal(keepIsolatedWorkersForeground(management), false);
});
