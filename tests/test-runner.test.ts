import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

const suites = ["unit", "integration", "e2e"] as const;

function fixture(t: TestContext) {
	const root = mkdtempSync(path.join(tmpdir(), "goal-x-runner-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const scripts = path.join(root, "scripts");
	mkdirSync(scripts);
	const runner = path.join(scripts, "run-unit-tests.mjs");
	copyFileSync(new URL("../scripts/run-unit-tests.mjs", import.meta.url), runner);
	writeFileSync(path.join(scripts, "test-adapter-hooks.mjs"), "");
	writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
	const manifest = { version: 1, unitFiles: [] as string[], integrationFiles: [] as string[], e2eFiles: [] as string[] };
	for (const suite of suites) {
		const directory = suite === "unit" ? "tests" : `tests/${suite}`;
		mkdirSync(path.join(root, directory), { recursive: true });
		const entry = `${directory}/fixture.test.ts`;
		const marker = `${suite}.executed`;
		writeFileSync(path.join(root, entry), [
			'import test from "node:test";',
			'import { writeFileSync } from "node:fs";',
			`test(${JSON.stringify(suite)}, () => writeFileSync(${JSON.stringify(path.join(root, marker))}, "ran"));`,
		].join("\n"));
		manifest[`${suite}Files`].push(`./${entry}`);
	}
	const manifestPath = path.join(root, "tests", ".test-manifest.json");
	writeFileSync(manifestPath, JSON.stringify(manifest));
	return {
		manifest,
		manifestPath,
		ran: (suite: typeof suites[number]) => existsSync(path.join(root, `${suite}.executed`)),
		run: (...args: string[]) => {
			// A nested test runner needs its own context, as in the SDK subprocess tests.
			const { NODE_TEST_CONTEXT: _, ...env } = process.env;
			const result = spawnSync(process.execPath, [runner, ...args], { cwd: root, env, encoding: "utf8", timeout: 15_000 });
			assert.ifError(result.error);
			assert.equal(result.signal, null, `${result.stdout}\n${result.stderr}`);
			return result;
		},
	};
}

for (const args of [["--selfcheck"], ["all", "--selfcheck"]]) {
	test(`runner ${args.join(" ")} validates without executing tests`, (t) => {
		const f = fixture(t);
		const result = f.run(...args);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Runner self-check OK/);
		for (const suite of suites) assert.equal(f.ran(suite), false, `${suite} tests unexpectedly executed`);
		assert.doesNotMatch(result.stdout, /suite finished/);
	});
}

for (const suite of suites) {
	test(`runner selfcheck rejects ${suite} manifest drift without executing tests`, (t) => {
		const f = fixture(t);
		f.manifest[`${suite}Files`] = [`./tests/${suite}-missing.test.ts`];
		writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
		const result = f.run("--selfcheck");
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Runner self-check FAILED/);
		assert.match(result.stderr, new RegExp(`unexpected ${suite} entry`));
		assert.match(result.stderr, new RegExp(`missing ${suite} entry`));
		for (const name of suites) assert.equal(f.ran(name), false);
	});
}

test("runner selfcheck rejects a missing manifest without executing tests", (t) => {
	const f = fixture(t);
	rmSync(f.manifestPath);
	const result = f.run("--selfcheck");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Missing .*\.test-manifest\.json/);
	for (const suite of suites) assert.equal(f.ran(suite), false);
});

for (const suite of ["unit", "integration", "e2e", "all"] as const) {
	test(`runner still executes the ${suite} suite`, (t) => {
		const f = fixture(t);
		const result = suite === "unit" ? f.run() : f.run(suite);
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		assert.match(result.stdout, /suite finished/);
		for (const name of suites) assert.equal(f.ran(name), suite === "all" || name === suite);
	});
}

test("runner still regenerates the manifest without executing tests", (t) => {
	const f = fixture(t);
	rmSync(f.manifestPath);
	const result = f.run("--write-manifest");
	assert.equal(result.status, 0, result.stderr);
	const written = JSON.parse(readFileSync(f.manifestPath, "utf8"));
	for (const suite of suites) {
		assert.deepEqual(written[`${suite}Files`], f.manifest[`${suite}Files`]);
		assert.equal(f.ran(suite), false);
	}
});
