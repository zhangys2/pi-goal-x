/** Worker patch integration with cancellable Git, exclusive ownership, and conservative rollback. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import path from "node:path";
import { formatCheckFailure, runTaskChecks, type TaskCheck, type TaskCheckRun } from "./goal-task-checks.ts";
import { runIntegrationGit, type IntegrationGitResult } from "./goal-integration-git.ts";
import { acquireIntegrationLock } from "./storage/goal-integration-lock.ts";

export type IntegrationOutcome = "integrated" | "conflict" | "checks_failed" | "commit_failed" | "rejected" | "cancelled";
export interface IntegrationResult {
	outcome: IntegrationOutcome;
	message: string;
	commit?: string;
	files?: string[];
	checkRun?: TaskCheckRun;
	/** Paths deliberately preserved or not restored; ask the user before touching them. */
	leftover?: string[];
}
const MAX_LISTED_PATHS = 20;

// Synchronous inspection helpers remain compatible with existing callers. Mutating integration uses async Git.
function git(cwd: string, args: string[]): IntegrationGitResult {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
	return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: (result.stderr ?? "").trim() || (result.error?.message ?? "") };
}
function listed(paths: readonly string[]): string {
	const shown = paths.slice(0, MAX_LISTED_PATHS).join(", ");
	return paths.length > MAX_LISTED_PATHS ? `${shown}, and ${paths.length - MAX_LISTED_PATHS} more` : shown;
}
function statusArgs(projectPrefix: string): string[] {
	const exclude = [".pi/goals", ".pi/.goals-pool-snapshot.json", ".pi-subagents"].map((p) => `:(top,exclude)${projectPrefix}${p}`);
	return ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ":(top)", ...exclude, ":(top,exclude).pi-subagents"];
}
function statusPaths(status: IntegrationGitResult): string[] {
	if (!status.ok) return ["(git status failed)"];
	const entries = status.stdout.split("\0").filter(Boolean);
	const paths: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		paths.push(entry.slice(3));
		if (entry[0] === "R" || entry[0] === "C") paths.push(entries[++i]!);
	}
	return paths;
}
export function uncommittedPaths(top: string, projectPrefix: string): string[] {
	return statusPaths(git(top, statusArgs(projectPrefix)));
}
function numstatPaths(stdout: string, patch: string): string[] {
	const tokens = stdout.split("\0");
	const paths: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		const firstTab = token.indexOf("\t");
		const secondTab = token.indexOf("\t", firstTab + 1);
		if (firstTab < 0 || secondTab < 0) continue;
		const file = token.slice(secondTab + 1);
		if (file) paths.push(file);
		else { paths.push(tokens[i + 1]!, tokens[i + 2]!); i += 2; }
	}
	for (const match of patch.matchAll(/^rename from (.+)$/gm)) paths.push(unquoteGitPath(match[1]!));
	return [...new Set(paths.filter(Boolean))];
}
export function patchPaths(top: string, patchFile: string): { ok: true; paths: string[] } | { ok: false; message: string } {
	const numstat = git(top, ["apply", "--numstat", "-z", patchFile]);
	return numstat.ok ? { ok: true, paths: numstatPaths(numstat.stdout, readFileSync(patchFile, "utf8")) } : { ok: false, message: numstat.stderr || "git apply could not read the patch" };
}
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
function fingerprint(file: string): string {
	try {
		const stat = lstatSync(file);
		if (stat.isSymbolicLink()) return `link:${readlinkSync(file)}`;
		if (!stat.isFile()) return `other:${stat.mode}:${stat.mtimeMs}`;
		return `${stat.mode}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
		throw error;
	}
}
async function snapshot(top: string, files: readonly string[]): Promise<Map<string, string>> {
	const index = await runIntegrationGit(top, ["ls-files", "--stage", "-z"]);
	if (!index.ok) throw new Error(`Cannot inspect integration ownership: ${index.stderr}`);
	const entries = index.stdout.split("\0").filter(Boolean);
	const staged = new Map<string, string>();
	for (const entry of entries) {
		const tab = entry.indexOf("\t");
		const file = entry.slice(tab + 1);
		staged.set(file, (staged.get(file) ?? "") + entry.slice(0, tab) + "\n");
	}
	return new Map(files.map((file) => [file, `${staged.get(file) ?? ""}|${fingerprint(path.join(top, file))}`]));
}
function unsafePath(top: string, file: string): boolean {
	if (!file || path.isAbsolute(file) || file.includes("\\") || file.includes("\0") || file.split("/").some((part) => part === "." || part === ".." || part.toLowerCase() === ".git")) return true;
	if (/(^|\/)\.pi\/(?:goals(?:\/|$)|\.goals-pool-snapshot\.json$)/.test(file) || /(^|\/)\.pi-subagents(?:\/|$)/.test(file)) return true;
	let parent = path.dirname(path.join(top, file));
	while (parent !== top) {
		try { if (lstatSync(parent).isSymbolicLink()) return true; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const next = path.dirname(parent);
		if (next === parent) return true;
		parent = next;
	}
	return false;
}

export async function integratePatch(options: { cwd: string; patchPath: string; commitMessage: string; checks?: readonly TaskCheck[]; signal?: AbortSignal }): Promise<IntegrationResult> {
	const reject = (message: string): IntegrationResult => ({ outcome: options.signal?.aborted ? "cancelled" : "rejected", message });
	if (options.signal?.aborted) return reject("Integration cancelled before applying the patch.");
	const inspect = (cwd: string, args: string[], input?: string | Buffer) => runIntegrationGit(cwd, args, input, options.signal);
	const topResult = await inspect(options.cwd, ["rev-parse", "--show-toplevel"]);
	if (!topResult.ok) return reject(topResult.stderr || "The project is not a git repository.");
	const top = path.resolve(topResult.stdout.trim());
	const common = await inspect(top, ["rev-parse", "--git-common-dir"]);
	if (!common.ok) return reject(common.stderr);
	let release: () => void;
	try { release = acquireIntegrationLock(path.resolve(top, common.stdout.trim())); }
	catch (error) { return reject(error instanceof Error ? error.message : String(error)); }
	let files: string[] = [];
	let owned: Map<string, string> | undefined;
	let applied = false;
	let originalHead = "";
	let originalBranch = "";
	let originalFiles = new Map<string, string>();
	let tracked = new Set<string>();
	const unchangedHead = async () => {
		const head = await runIntegrationGit(top, ["rev-parse", "HEAD"]);
		const branch = await runIntegrationGit(top, ["symbolic-ref", "-q", "HEAD"]);
		return head.ok && branch.ok && head.stdout.trim() === originalHead && branch.stdout.trim() === originalBranch;
	};
	const undo = async (outcome: IntegrationOutcome, message: string, extra: Partial<IntegrationResult> = {}): Promise<IntegrationResult> => {
		let safe: string[] = [];
		if (owned && await unchangedHead()) {
			try {
				const current = await snapshot(top, files);
				safe = files.filter((file) => current.get(file) === owned!.get(file) && !unsafePath(top, file));
			} catch { /* Unknown ownership is never destructive. */ }
		}
		const inHead = safe.filter((file) => tracked.has(file));
		const added = safe.filter((file) => !tracked.has(file));
		if (inHead.length) await runIntegrationGit(top, ["--literal-pathspecs", "checkout", originalHead, "--pathspec-from-file=-", "--pathspec-file-nul"], inHead.join("\0"));
		if (added.length) {
			const removed = await runIntegrationGit(top, ["--literal-pathspecs", "rm", "-q", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], added.join("\0"));
			if (removed.ok) for (const file of added) { try { rmSync(path.join(top, file), { force: true }); } catch { /* Report below. */ } }
		}
		let leftover = [...files];
		try { const current = await snapshot(top, files); leftover = files.filter((file) => current.get(file) !== originalFiles.get(file)); } catch { /* Preserve the warning. */ }
		const tail = leftover.length ? `\n\nPreserved paths with changed or uncertain ownership; ask the user before touching them: ${listed(leftover)}.` : "\n\nIntegration-owned paths were restored to their original state.";
		return { outcome, message: message + tail, files, ...extra, ...(leftover.length ? { leftover } : {}) };
	};
	try {
		const branch = await inspect(top, ["symbolic-ref", "-q", "HEAD"]);
		if (!branch.ok) return reject("HEAD is detached. Check out the goal's branch before integrating.");
		originalBranch = branch.stdout.trim();
		const head = await inspect(top, ["rev-parse", "--verify", "-q", "HEAD"]);
		if (!head.ok) return reject("The branch has no commit yet.");
		originalHead = head.stdout.trim();
		if (!options.commitMessage.trim()) return reject("commit_message is required.");
		const patchFile = path.resolve(options.cwd, options.patchPath);
		let patch: Buffer;
		try { patch = readFileSync(patchFile); } catch { return reject(`Patch file not found: ${patchFile}`); }
		if (!patch.length) return reject("The patch is empty: the worker made no changes.");
		if (patch.length > 64 * 1024 * 1024) return reject("The patch exceeds 64 MiB.");
		const prefix = await inspect(options.cwd, ["rev-parse", "--show-prefix"]);
		if (!prefix.ok) return reject(prefix.stderr);
		const projectPrefix = prefix.stdout.trim();
		const dirty = statusPaths(await inspect(top, statusArgs(projectPrefix)));
		if (dirty.length) return reject(`The working tree has uncommitted changes, so a failed integration could not be undone cleanly: ${listed(dirty)}. Commit or set them aside first.`);
		const numstat = await inspect(top, ["apply", "--numstat", "-z", "-"], patch);
		if (!numstat.ok) return reject(`The file is not a valid patch: ${numstat.stderr}`);
		files = numstatPaths(numstat.stdout, patch.toString("utf8"));
		if (!files.length || files.some((file) => unsafePath(top, file))) return reject("The patch contains unsafe paths or protected goal/subagent runtime state.");
		const tree = await inspect(top, ["ls-tree", "-r", "--name-only", "-z", originalHead]);
		if (!tree.ok) return reject(tree.stderr);
		tracked = new Set(tree.stdout.split("\0").filter(Boolean));
		const existing = files.filter((file) => !tracked.has(file) && fingerprint(path.join(top, file)) !== "missing");
		if (existing.length) return reject(`The patch would overwrite existing untracked or ignored paths: ${listed(existing)}.`);
		originalFiles = await snapshot(top, files);
		if (options.signal?.aborted) return reject("Integration cancelled before applying the patch.");
		if (!await unchangedHead()) return reject("HEAD or the branch changed before application. Nothing was applied.");
		applied = true;
		const apply = await inspect(top, ["apply", "--3way", "--index", "--whitespace=nowarn", "-"], patch);
		owned = await snapshot(top, files);
		if (!apply.ok) return await undo(apply.aborted ? "cancelled" : "conflict", `The patch did not apply: ${apply.stderr}`);
		let checkRun: TaskCheckRun | undefined;
		if (options.checks?.length) {
			checkRun = await runTaskChecks(options.cwd, options.checks, { signal: options.signal });
			if (!checkRun.passed) return await undo(options.signal?.aborted ? "cancelled" : "checks_failed", `The patch applied, but a check failed on the result.\n\n${formatCheckFailure(checkRun)}`, { checkRun });
		}
		if (options.signal?.aborted) return await undo("cancelled", "Integration cancelled before committing.", { checkRun });
		const current = await snapshot(top, files);
		if (!await unchangedHead() || files.some((file) => current.get(file) !== owned!.get(file) || unsafePath(top, file))) return await undo("rejected", "The branch, index, or patch paths changed during verification; no integration commit was requested.", { checkRun });
		if (options.signal?.aborted) return await undo("cancelled", "Integration cancelled before committing.", { checkRun });
		// Commit only patch paths, never unrelated changes staged during verification.
		const committed = await inspect(top, ["--literal-pathspecs", "commit", "--only", "-q", "-m", options.commitMessage, "--pathspec-from-file=-", "--pathspec-file-nul"], files.join("\0"));
		if (!committed.ok) return await undo(committed.aborted ? "cancelled" : "commit_failed", `The integration commit did not finish successfully: ${committed.stderr}. If HEAD moved, inspect it before retrying.`, { checkRun });
		const commit = await runIntegrationGit(top, ["rev-parse", "HEAD"]);
		if (!commit.ok) return { outcome: "rejected", message: "Git reported a successful commit, but its identity could not be read. Inspect HEAD before retrying; no rollback was attempted.", files, leftover: files, checkRun };
		return { outcome: "integrated", message: `Integrated as ${commit.stdout.trim().slice(0, 12)}: ${listed(files)}.`, commit: commit.stdout.trim(), files, ...(checkRun ? { checkRun } : {}) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return applied ? await undo(options.signal?.aborted ? "cancelled" : "rejected", message) : reject(message);
	} finally { release(); }
}
