/**
 * Per-task code review gate: git review baselines, task-scoped changed files
 * and diff, classification, skip rules, and the reviewer call.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { GoalCore } from "./goal-state.ts";
import { truncateText } from "./goal-core.ts";
import { loadGoalSettings } from "./goal-settings.ts";
import { runGoalCompletionAuditor } from "./goal-auditor.ts";
import { notifyGoalNeedsUser } from "./widgets/goal-notifications.ts";
import { readGoalLedger, type GoalLedgerEvent } from "./goal-ledger.ts";
import { nowIso, type GoalRecord, type GoalTask, type ReviewBaseline } from "./goal-record.ts";
import { formatCheckFailure, formatCheckResults, runTaskChecks, type TaskCheckRun } from "./goal-task-checks.ts";

const MAX_TASK_DIFF_CHARS = 120000;
const MAX_TASK_REVIEW_REJECTIONS = 3;

// Goal and subagent runtime state changes during every task. Reviewers that saw it
// rejected tasks as out of scope, and agents then deleted it with `git clean`.
export const RUNTIME_STATE_PATHSPECS = [".", ":(exclude).pi/goals", ":(exclude).pi/.goals-pool-snapshot.json", ":(exclude).pi-subagents"];

function git(cwd: string, args: string[], input?: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] });
}

function outputLines(output: string): string[] {
	return output.split(/\r?\n/).filter(Boolean);
}

function untrackedFileHashes(cwd: string): Record<string, string> {
	const files = outputLines(git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ...RUNTIME_STATE_PATHSPECS]));
	if (!files.length) return {};
	// Paths go through stdin: a large untracked set would exceed the Windows command-line limit.
	const hashes = outputLines(git(cwd, ["hash-object", "--stdin-paths"], files.join("\n")));
	return Object.fromEntries(files.map((file, index) => [file, hashes[index]!]));
}

export const BASELINE_STASH_MESSAGE = "per-task-review";

export function gitBaseline(cwd: string): ReviewBaseline | undefined {
	try {
		const revision = git(cwd, ["stash", "create", BASELINE_STASH_MESSAGE]).trim() || git(cwd, ["rev-parse", "HEAD"]).trim();
		return { revision, untracked: untrackedFileHashes(cwd) };
	} catch {
		return undefined;
	}
}

function gitTaskChanges(cwd: string, baseline: ReviewBaseline): { tracked: string[]; untracked: string[] } {
	const tracked = outputLines(git(cwd, ["diff", "--name-only", baseline.revision, "--", ...RUNTIME_STATE_PATHSPECS]));
	const trackedSet = new Set(tracked);
	const untracked = Object.entries(untrackedFileHashes(cwd))
		.filter(([file, hash]) => baseline.untracked[file] !== hash && !trackedSet.has(file))
		.map(([file]) => file);
	return { tracked, untracked };
}

export function gitTaskChangedFiles(cwd: string, baseline: ReviewBaseline | undefined): string[] | undefined {
	if (!baseline) return undefined;
	try {
		const { tracked, untracked } = gitTaskChanges(cwd, baseline);
		return [...tracked, ...untracked];
	} catch {
		return undefined;
	}
}

function boundedDiff(full: string, files: readonly string[], empty: string): string {
	if (full.length <= MAX_TASK_DIFF_CHARS) return full || empty;
	return `${full.slice(0, MAX_TASK_DIFF_CHARS)}\n\n[Diff truncated: showing ${MAX_TASK_DIFF_CHARS} of ${full.length} characters. Inspect these changed files in the workspace before approving:\n${files.join("\n")}]`;
}

export function gitTaskDiff(cwd: string, baseline: ReviewBaseline | undefined): string {
	if (!baseline) return "(no git baseline available)";
	try {
		const { tracked, untracked } = gitTaskChanges(cwd, baseline);
		const trackedDiff = git(cwd, ["diff", "--binary", baseline.revision, "--", ...RUNTIME_STATE_PATHSPECS]);
		const untrackedContent = untracked.map((file) => {
			try { return `\n--- untracked: ${file} ---\n${readFileSync(`${cwd}/${file}`, "utf8")}`; } catch { return `\n--- untracked: ${file} (unreadable) ---`; }
		}).join("\n");
		return boundedDiff(trackedDiff + untrackedContent, [...tracked, ...untracked], "(no changes since baseline)");
	} catch {
		return "(could not read git diff for baseline)";
	}
}

/** Files changed by an isolated task's integration commits. */
export function gitIntegrationChangedFiles(cwd: string, commits: readonly string[]): string[] | undefined {
	try {
		return [...new Set(commits.flatMap((commit) => outputLines(git(cwd, ["show", "--name-only", "--format=", "--no-renames", commit]))))];
	} catch {
		return undefined;
	}
}

/** An isolated task's review scope: its integration commits, not the shared worktree. */
export function gitIntegrationDiff(cwd: string, commits: readonly string[]): string {
	if (!commits.length) return "(no integrated worker patches)";
	try {
		const full = commits.map((commit) => git(cwd, ["show", "--binary", "--no-color", "--format=--- integration commit %H ---%n%B", commit])).join("\n");
		return boundedDiff(full, gitIntegrationChangedFiles(cwd, commits) ?? [], "(integration commits changed nothing)");
	} catch {
		return "(could not read the integration commits)";
	}
}

export function taskReviewSkipReason(task: Pick<GoalTask, "reviewType">, options: { disableTaskReviews?: boolean; auditorDisabled?: boolean; excludedTypes?: readonly string[] }): string | undefined {
	if (options.disableTaskReviews) return "Per-task reviews disabled in settings.";
	if (options.auditorDisabled) return "Auditor disabled.";
	if (task.reviewType && options.excludedTypes?.some((type) => type.toLowerCase() === task.reviewType!.toLowerCase())) return `Review type '${task.reviewType}' excluded by settings.`;
	return undefined;
}

export function taskNeedsCodeReview(task: Pick<GoalTask, "title" | "verificationContract" | "codeChange"> & { evidence?: string; changedFiles?: string }): boolean {
	// The agent's label is authoritative: task prose and completion evidence are not a reliable classifier.
	if (typeof task.codeChange === "boolean") return task.codeChange;
	if (task.changedFiles !== undefined) return task.changedFiles.split(/\r?\n/).some((file) => /\.(?:ts|tsx|js|mjs|py|cpp|hpp|c|h|rs|go|java|cs|sql)$/i.test(file.trim()));
	// Without a label or observable changes the task cannot be classified;
	// fail closed into a review rather than guessing from prose.
	return true;
}

function flattenTasks(tasks: readonly GoalTask[]): GoalTask[] {
	return tasks.flatMap((task) => [task, ...flattenTasks(task.subtasks ?? [])]);
}

/**
 * A started, unresolved code task other than `taskId` or its ancestors and
 * descendants. Starting a second one in the same worktree mixes both tasks'
 * changes into each review diff.
 */
export function openCodeTaskConflict(tasks: readonly GoalTask[], taskId: string): GoalTask | undefined {
	const all = flattenTasks(tasks);
	const target = all.find((task) => task.id === taskId);
	if (!target || target.codeChange === false) return undefined;
	const related = (a: GoalTask, id: string) => flattenTasks(a.subtasks ?? []).some((task) => task.id === id);
	return all.find((task) => task.id !== taskId
		&& task.status === "pending" && task.reviewBaseline && task.codeChange !== false
		// Isolated tasks are reviewed as their own commits, so they cannot see each other's changes.
		&& !(target.isolated && task.isolated)
		&& !related(task, taskId) && !related(target, task.id));
}

export function openCodeTaskConflictMessage(open: GoalTask, taskId: string): string {
	return `Task "${taskId}" cannot start while code task "${open.id}" is started and unresolved: both would share one worktree and each review would include the other's changes. Complete "${open.id}" first, or ask the user whether to skip it.`;
}

type TaskReviewEvent = Extract<GoalLedgerEvent, { type: "task_review" }>;

/** Disapprovals of a task since the user last resumed the goal, oldest first. */
function taskRejectionsSinceResume(ctx: ExtensionContext, goalId: string, taskId: string): TaskReviewEvent[] {
	let rejections: TaskReviewEvent[] = [];
	for (const event of readGoalLedger(ctx).events) {
		if (!("goalId" in event) || event.goalId !== goalId) continue;
		if (event.type === "goal_resumed") rejections = [];
		else if (event.type === "task_review" && event.taskId === taskId && event.verdict === "disapproved") rejections.push(event);
	}
	return rejections;
}

function blockGoalForRejectedTask(core: GoalCore, ctx: ExtensionContext, task: GoalTask, report: string): boolean {
	const reason = `Task ${task.id} was rejected by ${MAX_TASK_REVIEW_REJECTIONS} consecutive code reviews. Latest findings:\n${truncateText(report, 1500)}`;
	const result = core.goalService.apply(ctx, {
		reconcile: false,
		refreshFromDisk: true,
		mutate: (g) => ({
			...g,
			status: "blocked" as const,
			stopReason: "agent" as const,
			pauseReason: reason,
			pauseSuggestedAction: `Decide how to proceed on task ${task.id}: narrow it, fix the verification environment, revise its contract with /goal-tweak, or accept the findings. Then /goal-resume.`,
			blockedAttempts: undefined,
			updatedAt: nowIso(),
		}),
		ledger: (written) => [{ type: "goal_blocked", goalId: written.id, reason, source: "system", at: written.updatedAt }],
	});
	if (!result.ok) return false;
	core.clearContinuationState();
	core.clearActiveAccounting();
	if (result.goal) core.runtime.markTurnStopped(result.goal.id);
	core.updateUI(ctx);
	notifyGoalNeedsUser(ctx, result.goal ?? core.state.goal);
	return true;
}

/**
 * Runs the task's declared checks. A failure is recorded now; a pass is
 * returned so the caller writes it together with the completion.
 */
export async function checkTaskBeforeCompletion(core: GoalCore, ctx: ExtensionContext, task: GoalTask, signal?: AbortSignal): Promise<{ failure?: string; run?: TaskCheckRun; event?: GoalLedgerEvent }> {
	const goal = core.state.goal;
	if (!goal || !task.checks?.length) return {};
	const run = await runTaskChecks(ctx.cwd, task.checks, { signal });
	const event: GoalLedgerEvent = { type: "task_checks", goalId: goal.id, taskId: task.id, passed: run.passed, trigger: "completion", results: run.results, at: nowIso() };
	if (run.passed) return { run, event };
	core.goalService.appendEvents(ctx, [event]);
	return { failure: `Task ${task.id} remains pending because one of its checks failed.\n\n${formatCheckFailure(run)}\n\nFix the cause and complete the task again. If the failure comes from the environment (missing toolchain, credentials, network) rather than the code, block the goal and tell the user what to fix.` };
}

export async function reviewTaskBeforeCompletion(core: GoalCore, ctx: ExtensionContext, task: GoalTask, evidence?: string, checkRun?: TaskCheckRun): Promise<{ failure?: string; approval?: GoalLedgerEvent; blocked?: boolean }> {
	const goal = core.state.goal;
	if (!goal) return { failure: "Task review could not start because no goal is focused." };
	const reviewBaseline = task.reviewBaseline ?? goal.taskList?.reviewBaseline;
	const settings = loadGoalSettings(ctx.cwd);
	const skip = (report: string) => {
		core.goalService.appendEvents(ctx, [{ type: "task_review", goalId: goal.id, taskId: task.id, verdict: "skipped", report, baseline: reviewBaseline?.revision, at: nowIso() }]);
		return {};
	};
	const reason = taskReviewSkipReason(task, { disableTaskReviews: settings.disableTaskReviews, auditorDisabled: settings.disabled || goal.skipAuditor, excludedTypes: settings.taskReviewExcludedTypes });
	if (reason) return skip(reason);
	const integrationCommits = task.isolated ? (task.integrations ?? []).map((integration) => integration.commit) : undefined;
	const changedFiles = task.codeChange === undefined
		? (integrationCommits ? gitIntegrationChangedFiles(ctx.cwd, integrationCommits) : gitTaskChangedFiles(ctx.cwd, reviewBaseline))?.join("\n")
		: undefined;
	if (!taskNeedsCodeReview({ ...task, evidence, changedFiles })) return skip("Task does not change code.");
	const taskDiff = integrationCommits ? gitIntegrationDiff(ctx.cwd, integrationCommits) : gitTaskDiff(ctx.cwd, reviewBaseline);
	const checkFacts = checkRun ? `\n\nChecks goal-x ran on this workspace just now, all passing (facts, not claims; no need to re-run them):\n${formatCheckResults(checkRun)}` : "";
	// A retry re-checks the previous findings, so reviews converge instead of each deriving new gaps.
	const previousReview = taskRejectionsSinceResume(ctx, goal.id, task.id).at(-1)?.report;
	const reviewGoal: GoalRecord = {
		...goal,
		objective: `Review the code and test changes for task ${task.id}: ${task.title}`,
		taskList: { tasks: [{ ...task, status: "pending" }], blockCompletion: true, proposedAt: new Date().toISOString() },
	};
	// Completion-auditor injections are intentionally not reused here: task
	// completion must always receive an independent review implementation.
	const reviewer = core.dependencies.runTaskReview ?? runGoalCompletionAuditor;
	const result = await reviewer({
		ctx,
		goal: reviewGoal,
		detailedSummary: `Task under review: ${task.id}\nTitle: ${task.title}\nCode change label: ${task.codeChange === undefined ? "legacy/inferred" : String(task.codeChange)}\nReview baseline: ${reviewBaseline?.revision ?? "(unavailable)"}\nTask diff summary:\n${taskDiff}\nVerification contract: ${task.verificationContract ?? "(none)"}\nExecutor evidence: ${evidence ?? "(none)"}${checkFacts}`,
		completionSummary: `This task is proposed for completion. Review only this task's complete diff since the baseline, including untracked files, and its associated tests before allowing completion. The task's verification contract is the checklist: report gaps outside it as non-blocking notes unless they make the contracted work incorrect. When a verification command fails because of the environment (toolchain, linker, credentials, network) rather than the code, name it as an environment blocker, not a code defect.${checkFacts}\n\nTASK DIFF:\n${taskDiff}`,
		previousAuditReport: previousReview,
		settings,
	});
	const event: GoalLedgerEvent = {
		type: "task_review",
		goalId: goal.id,
		taskId: task.id,
		verdict: result.approved ? "approved" : result.error ? "error" : "disapproved",
		report: truncateText(result.error ?? (result.output.trim() || "The independent code review did not approve this task."), 4000),
		baseline: reviewBaseline?.revision,
		at: nowIso(),
	};
	// Callers write an approval together with the completion, so a completion that never commits leaves no approval behind.
	if (result.approved) return { approval: event };
	// Counted before the append: inside a turn, appendEvents buffers into the
	// transaction, so a read-back would not see this rejection and the cap would
	// always be one short.
	const rejections = event.verdict === "disapproved" ? taskRejectionsSinceResume(ctx, goal.id, task.id).length + 1 : 0;
	core.goalService.appendEvents(ctx, [event]);
	const detail = result.error ? `Task review failed: ${result.error}` : result.output.trim() || "The independent code review did not approve this task.";
	if (rejections >= MAX_TASK_REVIEW_REJECTIONS && blockGoalForRejectedTask(core, ctx, task, detail)) {
		return { blocked: true, failure: `Task ${task.id} was rejected by ${MAX_TASK_REVIEW_REJECTIONS} consecutive code reviews, so the goal is now blocked until the user resumes it (for example after narrowing the task, fixing the environment, or revising the contract). Stop now; do not edit files or start another tool call.\n\n${detail}` };
	}
	return { failure: `Task ${task.id} remains pending because its code review did not approve completion. Resolve the findings and retry; ${MAX_TASK_REVIEW_REJECTIONS} consecutive rejections block the goal.\n\n${detail}` };
}
