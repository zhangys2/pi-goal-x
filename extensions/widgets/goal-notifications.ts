import { displayObjectiveTitle, truncateText } from "../goal-core.ts";
import type { GoalRecord } from "../goal-record.ts";

export function buildGoalRunningNotification(args: { objective: string; sisyphus: boolean; autoContinue: boolean }): string {
	const icon = args.sisyphus ? "◆" : "●";
	const mode = args.sisyphus ? "Sisyphus" : "Goal";
	const title = truncateText(displayObjectiveTitle(args.objective), 92);
	const drive = args.autoContinue ? "auto-continue on" : "manual mode";
	return [`${icon} ${mode} running`, `├─ ⟡ ${title}`, `└─ ${drive}`].join("\n");
}

/**
 * The user-facing announcement for a goal that stopped and needs the user.
 * Blocked used to be the only stop state with no notification at all, so a goal
 * could sit waiting for a decision nobody was told about.
 */
export function buildGoalAttentionNotification(args: {
	objective: string;
	status: "blocked" | "paused";
	reason?: string;
	suggestedAction?: string;
	attempts?: readonly string[];
}): string {
	const title = truncateText(displayObjectiveTitle(args.objective), 92);
	const lines = [`${args.status === "blocked" ? "⛔ Goal blocked" : "⏸ Goal paused"}: ${title}`];
	if (args.reason?.trim()) lines.push(`Why: ${truncateText(args.reason.trim(), 400)}`);
	if (args.attempts?.length) lines.push(`Already tried: ${args.attempts.map((a) => truncateText(a, 120)).join("; ")}`);
	if (args.suggestedAction?.trim()) lines.push(`To fix: ${truncateText(args.suggestedAction.trim(), 400)}`);
	lines.push("/goal-resume to continue once it is resolved, /goal-tweak to revise, /goal-clear to abandon.");
	return lines.join("\n");
}

/** Announces a goal that stopped for the user. Safe to call with any goal; only blocked and paused notify. */
export function notifyGoalNeedsUser(
	ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
	goal: GoalRecord | null | undefined,
): void {
	if (!goal || (goal.status !== "blocked" && goal.status !== "paused")) return;
	const message = buildGoalAttentionNotification({
		objective: goal.objective,
		status: goal.status,
		reason: goal.pauseReason,
		suggestedAction: goal.pauseSuggestedAction,
		attempts: goal.blockedAttempts,
	});
	try {
		ctx.ui.notify(message, goal.status === "blocked" ? "warning" : "info");
	} catch { /* a failed notification must not fail the transition */ }
}
