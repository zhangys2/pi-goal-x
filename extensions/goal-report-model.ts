/**
 * Pure goal-report model: everything the report shows, derived from the goal
 * record and its ledger. No I/O, no clock, no git — the renderer and the write
 * policy live in goal-report.ts, so every derivation here is unit-testable.
 */

import type { GoalLedgerEvent } from "./goal-ledger.ts";
import type { GoalRecord, GoalTask } from "./goal-record.ts";

/** Only three rejections is a tuned number; every other rule is a plain condition. */
export const REPORT_REJECTION_THRESHOLD = 3;

export type ReportTaskState = "complete" | "in_progress" | "pending" | "skipped" | "retrying";

export interface ReportTaskNode {
	id: string;
	title: string;
	parentId?: string;
	/** Declared sibling order within the parent, for ordered plans. */
	order: number;
	state: ReportTaskState;
	attempts: number;
}

export interface ReportTaskRow {
	id: string;
	title: string;
	state: ReportTaskState;
	attempts: number;
	startedAt?: string;
	finishedAt?: string;
	durationSeconds?: number;
	evidence?: string;
	skipReason?: string;
	codeChange?: boolean;
	contract?: string;
}

export interface ReportReviewEntry {
	taskId: string;
	verdict: "approved" | "disapproved" | "error" | "skipped";
	at: string;
	report?: string;
}

export interface ReportAuditEntry {
	verdict: "approved" | "disapproved" | "error" | "skipped";
	at: string;
	report?: string;
}

/** A span the goal spent not working, with what was said about it. */
export interface ReportAttentionSpan {
	kind: "blocked" | "paused" | "stalled" | "budget" | "wait";
	at: string;
	endedAt?: string;
	seconds?: number;
	reason: string;
	suggestedAction?: string;
	attempts?: readonly string[];
	/** True while the goal is still in this state. */
	open: boolean;
}

export interface ReportRecommendation {
	rule: "repeat_rejection" | "overlapping_tasks" | "scope_drift" | "wait_expired" | "unverified_completion";
	taskId?: string;
	text: string;
	evidence: string;
}

export interface GoalReportModel {
	goalId: string;
	objective: string;
	status: GoalRecord["status"];
	statusSince?: string;
	autoContinue: boolean;
	sisyphus: boolean;
	auditorEnabled: boolean;
	contract?: string;
	createdAt: string;
	updatedAt: string;
	tokensUsed: number;
	activeSeconds: number;
	plan: ReportTaskNode[];
	current: ReportTaskNode[];
	tasks: ReportTaskRow[];
	reviews: ReportReviewEntry[];
	audits: ReportAuditEntry[];
	attention: ReportAttentionSpan[];
	timeline: Array<{ at: string; text: string }>;
	recommendations: ReportRecommendation[];
}

function flatten(tasks: readonly GoalTask[] | undefined, parentId?: string): Array<{ task: GoalTask; parentId?: string; order: number }> {
	if (!tasks) return [];
	return tasks.flatMap((task, index) => [{ task, parentId, order: index }, ...flatten(task.subtasks, task.id)]);
}

function goalEvents(events: readonly GoalLedgerEvent[], goalId: string): GoalLedgerEvent[] {
	return events.filter((event) => "goalId" in event && event.goalId === goalId);
}

function taskState(task: GoalTask, attempts: number): ReportTaskState {
	if (task.status === "complete") return "complete";
	if (task.status === "skipped") return "skipped";
	if (attempts > 0) return "retrying";
	// A started task keeps its review baseline, which is how "in progress" is observable.
	return task.reviewBaseline ? "in_progress" : "pending";
}

function seconds(from: string, to: string): number {
	return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
}

/**
 * Attention spans: each stop event opens a span, and the next resume or goal
 * activity closes it. The open span is the one the user is looking at now.
 */
function deriveAttention(events: readonly GoalLedgerEvent[], goal: GoalRecord, nowIso: string): ReportAttentionSpan[] {
	const spans: ReportAttentionSpan[] = [];
	const close = (at: string) => {
		const open = spans.find((span) => span.open);
		if (!open) return;
		open.open = false;
		open.endedAt = at;
		open.seconds = seconds(open.at, at);
	};
	for (const event of events) {
		switch (event.type) {
			case "goal_blocked":
				close(event.at);
				spans.push({ kind: "blocked", at: event.at, reason: event.reason, open: true });
				break;
			case "goal_paused":
				close(event.at);
				spans.push({ kind: "paused", at: event.at, reason: event.reason, suggestedAction: event.suggestedAction, open: true });
				break;
			case "goal_stalled":
				close(event.at);
				spans.push({ kind: "stalled", at: event.at, reason: event.reason, open: true });
				break;
			case "goal_budget_limited":
				close(event.at);
				spans.push({ kind: "budget", at: event.at, reason: `Token budget reached (${event.tokensUsed}/${event.budget}).`, open: true });
				break;
			case "goal_resumed":
				close(event.at);
				break;
			default:
				break;
		}
	}
	const last = spans.find((span) => span.open);
	if (last) {
		// A still-open span is measured to now; a goal that moved on closed it already.
		if (goal.status === "active" || goal.status === "complete") {
			last.open = false;
			last.endedAt = goal.updatedAt;
			last.seconds = seconds(last.at, goal.updatedAt);
		} else {
			last.seconds = seconds(last.at, nowIso);
			if (goal.pauseSuggestedAction && !last.suggestedAction) last.suggestedAction = goal.pauseSuggestedAction;
			if (goal.blockedAttempts?.length) last.attempts = goal.blockedAttempts;
		}
	}
	const wait = goal.scheduler?.wait;
	if (wait) {
		// A wait carries no start time, so the goal's last update is the best
		// available approximation of when it was declared.
		spans.push({
			kind: "wait",
			at: goal.updatedAt,
			seconds: seconds(goal.updatedAt, nowIso),
			reason: `${wait.reason} (deadline ${new Date(wait.deadline).toISOString()})`,
			suggestedAction: "/goal-resume to continue now, /goal-pause to stop waiting.",
			open: true,
		});
	}
	return spans;
}

export function buildGoalReportModel(args: {
	goal: GoalRecord;
	events: readonly GoalLedgerEvent[];
	now: number;
	/** Files changed since each task's baseline, when git could report them. */
	changedFiles?: Readonly<Record<string, readonly string[]>>;
}): GoalReportModel {
	const { goal } = args;
	const nowIso = new Date(args.now).toISOString();
	const events = goalEvents(args.events, goal.id);
	const nodes = flatten(goal.taskList?.tasks);

	const rejectionsByTask = new Map<string, number>();
	const reviews: ReportReviewEntry[] = [];
	const audits: ReportAuditEntry[] = [];
	const startedAt = new Map<string, string>();
	const finishedAt = new Map<string, string>();
	for (const event of events) {
		if (event.type === "task_review") {
			reviews.push({ taskId: event.taskId, verdict: event.verdict, at: event.at, report: event.report });
			if (event.verdict === "disapproved") rejectionsByTask.set(event.taskId, (rejectionsByTask.get(event.taskId) ?? 0) + 1);
			if (event.verdict === "approved") rejectionsByTask.delete(event.taskId);
		} else if (event.type === "audit_result") {
			audits.push({ verdict: event.verdict, at: event.at, report: event.report });
		} else if (event.type === "audit_skipped") {
			audits.push({ verdict: "skipped", at: event.at, report: `Audit skipped: ${event.reason}` });
		} else if (event.type === "task_started") {
			if (!startedAt.has(event.taskId)) startedAt.set(event.taskId, event.at);
		} else if (event.type === "task_complete" || event.type === "task_skipped") {
			finishedAt.set(event.taskId, event.at);
		}
	}

	const plan: ReportTaskNode[] = nodes.map(({ task, parentId, order }) => ({
		id: task.id,
		title: task.title,
		...(parentId ? { parentId } : {}),
		order,
		state: "pending" as ReportTaskState,
		attempts: 0,
	}));
	const current: ReportTaskNode[] = nodes.map(({ task, parentId, order }) => {
		const attempts = rejectionsByTask.get(task.id) ?? 0;
		return { id: task.id, title: task.title, ...(parentId ? { parentId } : {}), order, state: taskState(task, attempts), attempts };
	});

	const tasks: ReportTaskRow[] = nodes.map(({ task }) => {
		const attempts = rejectionsByTask.get(task.id) ?? 0;
		const started = startedAt.get(task.id);
		const finished = finishedAt.get(task.id) ?? task.completedAt ?? task.skippedAt;
		return {
			id: task.id,
			title: task.title,
			state: taskState(task, attempts),
			attempts,
			...(started ? { startedAt: started } : {}),
			...(finished ? { finishedAt: finished } : {}),
			...(started && finished ? { durationSeconds: seconds(started, finished) } : {}),
			...(task.evidence ? { evidence: task.evidence } : {}),
			...(task.skipReason ? { skipReason: task.skipReason } : {}),
			...(task.codeChange !== undefined ? { codeChange: task.codeChange } : {}),
			...(task.verificationContract ? { contract: task.verificationContract } : {}),
		};
	});

	return {
		goalId: goal.id,
		objective: goal.objective,
		status: goal.status,
		statusSince: goal.updatedAt,
		autoContinue: goal.autoContinue,
		sisyphus: goal.sisyphus,
		auditorEnabled: goal.skipAuditor !== true,
		...(goal.verificationContract ? { contract: goal.verificationContract } : {}),
		createdAt: goal.createdAt,
		updatedAt: goal.updatedAt,
		tokensUsed: goal.usage.tokensUsed,
		activeSeconds: goal.usage.activeSeconds,
		plan,
		current,
		tasks,
		reviews,
		audits,
		attention: deriveAttention(events, goal, nowIso),
		timeline: events.map((event) => ({ at: event.at, text: timelineText(event) })),
		recommendations: deriveRecommendations({ tasks, events, goal, changedFiles: args.changedFiles }),
	};
}

function timelineText(event: GoalLedgerEvent): string {
	switch (event.type) {
		case "task_started": return `task ${event.taskId} started`;
		case "task_complete": return `task ${event.taskId} complete${event.evidence ? ` — ${event.evidence}` : ""}`;
		case "task_skipped": return `task ${event.taskId} skipped — ${event.reason}`;
		case "task_reopened": return `task ${event.taskId} reopened`;
		case "task_review": return `task ${event.taskId} review ${event.verdict}`;
		case "task_list_set": return `task list set (${event.taskCount} tasks)`;
		case "audit_result": return `audit ${event.verdict}`;
		case "audit_skipped": return `audit skipped (${event.reason})`;
		case "goal_blocked": return `blocked — ${event.reason}`;
		case "goal_paused": return `paused — ${event.reason}`;
		case "goal_resumed": return `resumed (${event.reason})`;
		case "goal_stalled": return `stalled — ${event.reason}`;
		case "goal_completed": return "goal complete";
		case "goal_created": return "goal created";
		default: return event.type.replace(/_/g, " ");
	}
}

function deriveRecommendations(args: {
	tasks: readonly ReportTaskRow[];
	events: readonly GoalLedgerEvent[];
	goal: GoalRecord;
	changedFiles?: Readonly<Record<string, readonly string[]>>;
}): ReportRecommendation[] {
	const out: ReportRecommendation[] = [];

	for (const task of args.tasks) {
		if (task.attempts >= REPORT_REJECTION_THRESHOLD) {
			out.push({
				rule: "repeat_rejection",
				taskId: task.id,
				text: `Split or renegotiate "${task.id}": its review rejected it ${task.attempts} times, which means the contract, the scope or the environment is wrong, not the effort.`,
				evidence: `${task.attempts} disapproved task_review events`,
			});
		}
		if (task.state === "complete" && task.codeChange !== false && !/\b(test|cargo|npm|pytest|go test|make|verify)\b/i.test(task.evidence ?? "")) {
			out.push({
				rule: "unverified_completion",
				taskId: task.id,
				text: `Record the verification command in "${task.id}"'s evidence: a reviewer cannot reproduce a claim that names no command.`,
				evidence: task.evidence ? `evidence: ${task.evidence}` : "no evidence recorded",
			});
		}
		const changed = args.changedFiles?.[task.id];
		if (changed?.length && task.contract) {
			const forbidden = changed.filter((file) => new RegExp(`(?:^|[\\s"'\`])${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(task.contract!) && /\b(do not|never|not|without|outside)\b/i.test(task.contract!));
			if (forbidden.length) {
				out.push({
					rule: "scope_drift",
					taskId: task.id,
					text: `"${task.id}" changed ${forbidden.join(", ")}, which its contract put out of scope.`,
					evidence: `contract: ${task.contract}`,
				});
			}
		}
	}

	// Two code tasks started without the first resolving: their diffs overlap.
	const openWindows: Array<{ id: string; at: string }> = [];
	for (const event of args.events) {
		if (event.type === "task_started") {
			const other = openWindows.find((entry) => entry.id !== event.taskId);
			if (other) {
				out.push({
					rule: "overlapping_tasks",
					taskId: event.taskId,
					text: `Run one code task at a time: "${event.taskId}" started while "${other.id}" was still open, so each review saw the other's changes.`,
					evidence: `${other.id} started ${other.at}, ${event.taskId} started ${event.at}`,
				});
			}
			openWindows.push({ id: event.taskId, at: event.at });
		} else if (event.type === "task_complete" || event.type === "task_skipped") {
			const index = openWindows.findIndex((entry) => entry.id === event.taskId);
			if (index >= 0) openWindows.splice(index, 1);
		}
	}

	for (const event of args.events) {
		if (event.type === "goal_paused" && /deadline reached/i.test(event.reason)) {
			out.push({
				rule: "wait_expired",
				text: "A wait expired without its signal. Either the producer never registered a wake token, or the condition was one only the user could clear, which belongs in a block.",
				evidence: `${event.at}: ${event.reason}`,
			});
		}
	}

	return out;
}
