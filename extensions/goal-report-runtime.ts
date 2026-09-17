/**
 * When the goal report is regenerated. Keyed on the goal's persisted revision
 * counter, so one write happens per turn that actually changed goal state —
 * no call-site plumbing, and no write on turns that changed nothing.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { GoalCore } from "./goal-state.ts";
import { goalActivityEvents } from "./goal-ledger.ts";
import { loadGoalSettings } from "./goal-settings.ts";
import { gitTaskChangedFiles } from "./goal-task-review.ts";
import { findTaskInTree } from "./goal-policy.ts";
import { buildGoalReportModel } from "./goal-report-model.ts";
import { goalSubagentArtifacts, tasksNeedingChangedFiles, writeGoalReport } from "./goal-report.ts";

const reportedRevisions = new Map<string, number>();

export function forgetGoalReportRevision(goalId?: string): void {
	if (goalId) reportedRevisions.delete(goalId);
	else reportedRevisions.clear();
}

/** Regenerates unconditionally; returns the written path, or undefined when disabled or there is no goal. */
export function regenerateGoalReport(core: GoalCore, ctx: ExtensionContext): string | undefined {
	const goal = core.state.goal;
	if (!goal || loadGoalSettings(ctx.cwd).disableGoalReport) return undefined;
	const now = Date.now();
	const events = goalActivityEvents(ctx, goal.id);
	const base = buildGoalReportModel({ goal, events, now });
	const changedFiles: Record<string, readonly string[]> = {};
	for (const taskId of tasksNeedingChangedFiles(base)) {
		const task = findTaskInTree(goal.taskList?.tasks ?? [], taskId);
		const files = task?.reviewBaseline ? gitTaskChangedFiles(ctx.cwd, task.reviewBaseline) : undefined;
		if (files) changedFiles[taskId] = files;
	}
	const model = Object.keys(changedFiles).length ? buildGoalReportModel({ goal, events, now, changedFiles }) : base;
	const path = writeGoalReport(ctx, model, {
		now,
		artifacts: goalSubagentArtifacts(ctx.cwd, { from: goal.createdAt, to: new Date(now).toISOString() }),
	});
	reportedRevisions.set(goal.id, goal.revision ?? 0);
	return path;
}

/** Called at turn end: writes only when the focused goal changed since the last report. */
export function regenerateGoalReportIfChanged(core: GoalCore, ctx: ExtensionContext): void {
	const goal = core.state.goal;
	if (!goal) return;
	if (reportedRevisions.get(goal.id) === (goal.revision ?? 0)) return;
	try {
		regenerateGoalReport(core, ctx);
	} catch (error) {
		// A report is derived state; never fail goal work over it, and say so once.
		reportedRevisions.set(goal.id, goal.revision ?? 0);
		ctx.ui.notify(`Goal report not written: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}
}
