/** Install and exercise the exact packed artifact outside the checkout. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = process.env.PI_GOAL_PACKAGE_EVIDENCE ?? mkdtempSync(path.join(tmpdir(), "goal-package-evidence-"));
mkdirSync(evidence, { recursive: true });
const project = realpathSync(mkdtempSync(path.join(tmpdir(), "goal-installed-smoke-")));
const run = (command, args, cwd) => {
	try {
		return execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
	} catch (error) {
		writeFileSync(path.join(evidence, "failure.log"), `${error.stdout ?? ""}\n${error.stderr ?? ""}`);
		throw error;
	}
};

try {
	let tarball = process.env.PI_GOAL_PACKAGE_TARBALL;
	if (!tarball) {
		const [packed] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", evidence], root));
		tarball = path.join(evidence, packed.filename);
	}
	tarball = path.resolve(tarball);
	const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
	writeFileSync(path.join(project, "package.json"), JSON.stringify({ private: true, type: "module" }));
	const peers = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]
		.map(name => `${name}@${JSON.parse(readFileSync(path.join(root, "node_modules", name, "package.json"), "utf8")).version}`);
	writeFileSync(path.join(evidence, "install.log"), run("npm", ["install", "--no-audit", "--no-fund", tarball, ...peers], project));

	const installed = path.join(project, "node_modules/pi-goal-x");
	const entry = path.join(installed, "extensions/goal.ts");
	assert.equal(lstatSync(installed).isSymbolicLink(), false, "package must be installed, not linked");
	assert.equal(realpathSync(entry), entry, "installed entry must not resolve through a symlink");
	assert.ok(!entry.startsWith(root), "smoke must not load checkout code");

	const artifact = path.join(project, "artifact");
	cpSync(installed, artifact, { recursive: true });
	const tests = ["goal-core-tools.test.ts", "goal-ledger.test.ts", "goal-tasks.test.ts", "goal-tool-inputs.test.ts", "goal-widget.test.ts", "tui-test-utils.ts"];
	mkdirSync(path.join(artifact, "tests"));
	for (const file of tests) cpSync(path.join(root, "tests", file), path.join(artifact, "tests", file));
	const testFiles = tests.filter(file => file.endsWith(".test.ts")).map(file => `tests/${file}`);
	const output = run(process.execPath, ["--experimental-strip-types", "--test", "--test-concurrency=2", ...testFiles], artifact);
	assert.match(output, /fail 0/);
	writeFileSync(path.join(evidence, "tests.log"), output);
	const report = {
		version: JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8")).version,
		source: run("git", ["rev-parse", "HEAD"], root).trim(),
		tarball,
		integrity,
		sha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"),
		installedEntry: entry,
		testedEntry: path.join(artifact, "extensions/goal.ts"),
		passed: true,
	};
	writeFileSync(path.join(evidence, "package.json"), JSON.stringify(report, null, 2) + "\n");
	console.log(`Installed package PASS: ${report.version}; goal tools, ledger, task counts, input validation and keyboard focus. Evidence: ${evidence}`);
} finally {
	rmSync(project, { recursive: true, force: true });
}
