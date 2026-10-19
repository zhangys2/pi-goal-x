import { execFileSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalCore } from "./goal-state.ts";
import { formatCheckFailure, runTaskChecks, type TaskCheckRun } from "./goal-task-checks.ts";
import { nowIso, type GoalTask, type GoalWorkBaseline } from "./goal-record.ts";
import type { GoalLedgerEvent } from "./goal-ledger.ts";

export const BASELINE_STASH_MESSAGE = "goal-work-baseline";
export const RUNTIME_STATE_PATHSPECS = [".", ":(exclude).pi/goals", ":(exclude).pi/.goals-pool-snapshot.json", ":(exclude).pi-subagents"];

function git(cwd: string, args: string[], input?: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] });
}
function outputLines(output: string): string[] { return output.split(/\r?\n/).filter(Boolean); }

function untrackedFileHashes(cwd: string): Record<string, string> {
	const files = outputLines(git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ...RUNTIME_STATE_PATHSPECS]));
	if (!files.length) return {};
	const hashes = outputLines(git(cwd, ["hash-object", "--stdin-paths"], files.join("\n")));
	return Object.fromEntries(files.map((file, index) => [file, hashes[index]!]));
}

/** Capture repository state independently of any per-task review workflow. */
export function gitBaseline(cwd: string): GoalWorkBaseline | undefined {
	try {
		const revision = git(cwd, ["stash", "create", BASELINE_STASH_MESSAGE]).trim() || git(cwd, ["rev-parse", "HEAD"]).trim();
		return { revision, untracked: untrackedFileHashes(cwd) };
	} catch { return undefined; }
}

function changedAtBaseline(cwd: string, baseline: GoalWorkBaseline): { tracked: string[]; untracked: string[] } {
	const tracked = outputLines(git(cwd, ["diff", "--name-only", baseline.revision, "--", ...RUNTIME_STATE_PATHSPECS]));
	const trackedSet = new Set(tracked);
	const untracked = Object.entries(untrackedFileHashes(cwd)).filter(([file, hash]) => baseline.untracked[file] !== hash && !trackedSet.has(file)).map(([file]) => file);
	return { tracked, untracked };
}
export function gitTaskChangedFiles(cwd: string, baseline: GoalWorkBaseline | undefined): string[] | undefined {
	if (!baseline) return undefined;
	try { const changes = changedAtBaseline(cwd, baseline); return [...changes.tracked, ...changes.untracked]; } catch { return undefined; }
}

function flatten(tasks: readonly GoalTask[]): GoalTask[] { return tasks.flatMap(task => [task, ...flatten(task.subtasks ?? [])]); }
/** Prevent shared-worktree code tasks from contaminating each other's changes. */
export function openCodeTaskConflict(tasks: readonly GoalTask[], taskId: string): GoalTask | undefined {
	const all = flatten(tasks), target = all.find(task => task.id === taskId);
	if (!target || target.codeChange === false) return undefined;
	const related = (task: GoalTask, id: string) => flatten(task.subtasks ?? []).some(child => child.id === id);
	return all.find(task => task.id !== taskId && task.status === "pending" && task.workBaseline && task.codeChange !== false
		&& !(target.isolated && task.isolated) && !related(task, taskId) && !related(target, task.id));
}
export function openCodeTaskConflictMessage(open: GoalTask, taskId: string): string {
	return `Task "${taskId}" cannot start while code task "${open.id}" is started and unresolved: both would share one worktree and mix their changes. Complete "${open.id}" first, or ask the user whether to skip it.`;
}

/** Execute declared checks before task completion; no LLM review is performed. */
export async function checkTaskBeforeCompletion(core: GoalCore, ctx: ExtensionContext, task: GoalTask, signal?: AbortSignal): Promise<{ failure?: string; run?: TaskCheckRun; event?: GoalLedgerEvent }> {
	const goal = core.state.goal;
	if (!goal || !task.checks?.length) return {};
	const run = await runTaskChecks(ctx.cwd, task.checks, { signal });
	const event: GoalLedgerEvent = { type: "task_checks", goalId: goal.id, taskId: task.id, passed: run.passed, trigger: "completion", results: run.results, at: nowIso() };
	if (run.passed) return { run, event };
	core.goalService.appendEvents(ctx, [event]);
	return { failure: `Task ${task.id} remains pending because one of its checks failed.\n\n${formatCheckFailure(run)}\n\nFix the cause and complete the task again. If the failure comes from the environment (missing toolchain, credentials, network) rather than the code, block the goal and tell the user what to fix.` };
}
