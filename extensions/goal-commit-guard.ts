/**
 * Pre-existing work guard: a goal may commit what it changed, but not sweep
 * changes that were already in the working tree when the goal started into a
 * commit of its own. Such attempts are blocked so the agent asks the user; the
 * next user-initiated run opens the gate for the rest of the goal.
 */

import { execFileSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { GoalCore } from "./goal-state.ts";
import { BASELINE_STASH_MESSAGE, RUNTIME_STATE_PATHSPECS } from "./goal-task-review.ts";
import type { ReviewBaseline } from "./goal-record.ts";

const MAX_LISTED_PATHS = 12;

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function lines(output: string): string[] {
	return output.split(/\r?\n/).filter(Boolean);
}

/**
 * True when the command stages or commits everything rather than named paths,
 * which is how pre-existing work gets swept into a goal's commit.
 */
export function commandCommitsEverything(command: string): boolean {
	if (!/\bgit\b[^\n;&|]*\bcommit\b/.test(command)) return false;
	if (/\bgit\b[^\n;&|]*\bcommit\b[^\n;&|]*(?:-a\b|--all\b|-[a-zA-Z]*a[a-zA-Z]*\b)/.test(command)) return true;
	return /\bgit\b[^\n;&|]*\badd\b[^\n;&|]*(?:-A\b|--all\b|\.(?:\s|$)|:\/)/.test(command);
}

/**
 * Tracked paths that were dirty when the baseline was taken. A `git stash create`
 * baseline carries that state against its first parent, the HEAD of the time; a
 * plain HEAD baseline means the tracked tree was clean.
 */
function dirtyAtBaseline(cwd: string, baseline: ReviewBaseline): string[] {
	const [parents = "", subject = ""] = git(cwd, ["log", "-1", "--format=%P%n%s", baseline.revision]).split(/\r?\n/);
	if (parents.split(" ").length !== 2 || !subject.endsWith(`: ${BASELINE_STASH_MESSAGE}`)) return [];
	return lines(git(cwd, ["diff", "--name-only", `${baseline.revision}^1`, baseline.revision, "--", ...RUNTIME_STATE_PATHSPECS]));
}

/** Paths that were already modified or untracked when the baseline was taken and still are. */
export function preexistingDirtyPaths(cwd: string, baseline: ReviewBaseline): string[] {
	try {
		const atBaseline = new Set([...dirtyAtBaseline(cwd, baseline), ...Object.keys(baseline.untracked)]);
		if (atBaseline.size === 0) return [];
		const current = lines(git(cwd, ["status", "--porcelain", "--", ...RUNTIME_STATE_PATHSPECS])).map((line) => line.slice(3).replace(/^"|"$/g, ""));
		return current.filter((file) => atBaseline.has(file)).sort();
	} catch {
		return [];
	}
}

const askedGoalIds = new Set<string>();
const answeredGoalIds = new Set<string>();

/** A user-initiated run answers a pending ask, so an approved commit goes through on retry. */
export function clearCommitGuardAsk(goalId: string | null | undefined): void {
	for (const asked of goalId ? [goalId] : [...askedGoalIds]) {
		if (askedGoalIds.delete(asked)) answeredGoalIds.add(asked);
	}
}

export function commitGuardBlockReason(core: GoalCore, ctx: ExtensionContext, command: string): string | undefined {
	const goal = core.state.goal;
	if (!goal || goal.status !== "active" || answeredGoalIds.has(goal.id)) return undefined;
	if (!commandCommitsEverything(command)) return undefined;
	const baseline = goal.taskList?.reviewBaseline;
	if (!baseline) return undefined;
	const preexisting = preexistingDirtyPaths(ctx.cwd, baseline);
	if (preexisting.length === 0) return undefined;
	askedGoalIds.add(goal.id);
	const listed = preexisting.slice(0, MAX_LISTED_PATHS);
	const more = preexisting.length - listed.length;
	return [
		`This command would commit ${preexisting.length} path(s) that were already changed before this goal started, which is the user's work, not this goal's:`,
		...listed.map((file) => `- ${file}`),
		...(more > 0 ? [`- …and ${more} more`] : []),
		"Ask the user what to do with them and stop this turn. Commit only the paths this goal changed by naming them, or continue after the user answers.",
	].join("\n");
}
