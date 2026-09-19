/**
 * Worker patch integration: apply an isolated worker's patch on top of the
 * current branch with a three-way merge, run the task's checks there, and
 * commit — or restore exactly the paths the patch touched.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { formatCheckFailure, runTaskChecks, type TaskCheck, type TaskCheckRun } from "./goal-task-checks.ts";

export type IntegrationOutcome = "integrated" | "conflict" | "checks_failed" | "commit_failed" | "rejected";

export interface IntegrationResult {
	outcome: IntegrationOutcome;
	message: string;
	commit?: string;
	files?: string[];
	checkRun?: TaskCheckRun;
	/** Paths the restore could not return to HEAD; the user must look at them. */
	leftover?: string[];
}

const MAX_LISTED_PATHS = 20;

function git(cwd: string, args: string[], input?: string): { ok: boolean; stdout: string; stderr: string } {
	const result = spawnSync("git", args, { cwd, input, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
	return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: (result.stderr ?? "").trim() || (result.error?.message ?? "") };
}

function listed(paths: readonly string[]): string {
	const shown = paths.slice(0, MAX_LISTED_PATHS).join(", ");
	return paths.length > MAX_LISTED_PATHS ? `${shown}, and ${paths.length - MAX_LISTED_PATHS} more` : shown;
}

/**
 * Uncommitted paths in the repository, ignoring goal and subagent runtime state
 * under the project directory the way pi-subagents does for its own worktrees.
 */
export function uncommittedPaths(top: string, projectPrefix: string): string[] {
	const exclude = [".pi/goals", ".pi/.goals-pool-snapshot.json", ".pi-subagents"].map((p) => `:(top,exclude)${projectPrefix}${p}`);
	const status = git(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ":(top)", ...exclude, ":(top,exclude).pi-subagents"]);
	if (!status.ok) return ["(git status failed)"];
	const entries = status.stdout.split("\0").filter(Boolean);
	const paths: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		paths.push(entry.slice(3));
		// A rename or copy is followed by its source path.
		if (entry[0] === "R" || entry[0] === "C") i++;
	}
	return paths;
}

/** Every path a patch adds, changes, deletes, or renames, relative to the repository root. */
export function patchPaths(top: string, patchFile: string): { ok: true; paths: string[] } | { ok: false; message: string } {
	const numstat = git(top, ["apply", "--numstat", "-z", patchFile]);
	if (!numstat.ok) return { ok: false, message: numstat.stderr || "git apply could not read the patch" };
	const tokens = numstat.stdout.split("\0");
	const paths: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (!token) continue;
		const fields = token.split("\t");
		if (fields.length < 3) continue;
		if (fields[2]) paths.push(fields[2]);
		else { paths.push(tokens[i + 1]!, tokens[i + 2]!); i += 2; }
	}
	// numstat names only the destination of a rename; restoring must also bring back the source.
	for (const match of readFileSync(patchFile, "utf8").matchAll(/^rename from (.+)$/gm)) paths.push(unquoteGitPath(match[1]!));
	return { ok: true, paths: [...new Set(paths.filter(Boolean))] };
}

/** Undoes git's C-style quoting of paths with special or non-ASCII characters. */
function unquoteGitPath(value: string): string {
	if (!value.startsWith("\"")) return value;
	const bytes: number[] = [];
	const escapes: Record<string, number> = { n: 10, t: 9, r: 13, "\"": 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
	for (let i = 1; i < value.length - 1; i++) {
		const ch = value[i]!;
		if (ch !== "\\") { bytes.push(...Buffer.from(ch, "utf8")); continue; }
		const next = value[++i]!;
		if (/[0-7]/.test(next)) { bytes.push(parseInt(value.slice(i, i + 3), 8)); i += 2; }
		else bytes.push(escapes[next] ?? next.charCodeAt(0));
	}
	return Buffer.from(bytes).toString("utf8");
}

function restore(top: string, projectPrefix: string, paths: readonly string[]): string[] {
	const inHead = paths.filter((p) => git(top, ["cat-file", "-e", `HEAD:${p}`]).ok);
	const added = paths.filter((p) => !inHead.includes(p));
	// Paths go through stdin: a large patch would exceed the Windows command-line limit.
	if (inHead.length) git(top, ["--literal-pathspecs", "checkout", "HEAD", "--pathspec-from-file=-", "--pathspec-file-nul"], inHead.join("\0"));
	if (added.length) {
		git(top, ["--literal-pathspecs", "rm", "-q", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], added.join("\0"));
		for (const file of added) rmSync(path.join(top, file), { force: true });
	}
	const touched = new Set(paths);
	return uncommittedPaths(top, projectPrefix).filter((p) => touched.has(p));
}

export async function integratePatch(options: {
	cwd: string;
	patchPath: string;
	commitMessage: string;
	checks?: readonly TaskCheck[];
	signal?: AbortSignal;
}): Promise<IntegrationResult> {
	const reject = (message: string): IntegrationResult => ({ outcome: "rejected", message });
	const topResult = git(options.cwd, ["rev-parse", "--show-toplevel"]);
	if (!topResult.ok) return reject("The project is not a git repository.");
	const top = topResult.stdout.trim();
	const projectPrefix = git(options.cwd, ["rev-parse", "--show-prefix"]).stdout.trim();
	if (!git(top, ["symbolic-ref", "-q", "HEAD"]).ok) return reject("HEAD is detached. Check out the goal's branch before integrating.");
	if (!git(top, ["rev-parse", "--verify", "-q", "HEAD"]).ok) return reject("The branch has no commit yet.");
	if (!options.commitMessage.trim()) return reject("commit_message is required.");
	const patchFile = path.resolve(options.cwd, options.patchPath);
	let size: number;
	try { size = statSync(patchFile).size; } catch { return reject(`Patch file not found: ${patchFile}`); }
	if (size === 0) return reject("The patch is empty: the worker made no changes.");
	const dirty = uncommittedPaths(top, projectPrefix);
	if (dirty.length) return reject(`The working tree has uncommitted changes, so a failed integration could not be undone cleanly: ${listed(dirty)}. Commit or set them aside first.`);
	const parsed = patchPaths(top, patchFile);
	if (!parsed.ok) return reject(`The file is not a valid patch: ${parsed.message}`);
	const files = parsed.paths;

	const undo = (outcome: IntegrationOutcome, message: string, extra: Partial<IntegrationResult> = {}): IntegrationResult => {
		const leftover = restore(top, projectPrefix, files);
		const tail = leftover.length ? `\n\nThe restore could not return these paths to HEAD; ask the user before touching them: ${listed(leftover)}.` : "\n\nThe working tree was restored to HEAD.";
		return { outcome, message: message + tail, files, ...extra, ...(leftover.length ? { leftover } : {}) };
	};

	const applied = git(top, ["apply", "--3way", "--index", "--whitespace=nowarn", patchFile]);
	if (!applied.ok) {
		const conflicts = git(top, ["diff", "--name-only", "-z", "--diff-filter=U"]).stdout.split("\0").filter(Boolean);
		const detail = conflicts.length ? `Conflicting paths: ${listed(conflicts)}.` : applied.stderr;
		return undo("conflict", `The patch does not apply on top of the current branch. ${detail}`);
	}

	let checkRun: TaskCheckRun | undefined;
	if (options.checks?.length) {
		checkRun = await runTaskChecks(options.cwd, options.checks, { signal: options.signal });
		if (!checkRun.passed) return undo("checks_failed", `The patch applied, but a check failed on the result.\n\n${formatCheckFailure(checkRun)}`, { checkRun });
	}

	const committed = git(top, ["commit", "-q", "-m", options.commitMessage]);
	if (!committed.ok) return undo("commit_failed", `The patch applied${checkRun ? " and its checks passed" : ""}, but the commit failed: ${committed.stderr}`, { checkRun });
	const commit = git(top, ["rev-parse", "HEAD"]).stdout.trim();
	return { outcome: "integrated", message: `Integrated as ${commit.slice(0, 12)}: ${listed(files)}.`, commit, files, ...(checkRun ? { checkRun } : {}) };
}
