/**
 * Evidence pre-check (specs/2026-09-23-jev-pre-audit-gate): asks TypeSafe's
 * Jev whether each complete task's recorded evidence claims its requirement
 * was met. Log-only for now — the outcome is recorded, never acted on.
 */
import type { GoalRecord, GoalTask } from "./goal-record.ts";

export interface PrecheckSettings {
	enabled: boolean;
	model: string;
	rejectBelow: number;
}

export interface PrecheckOutcome {
	verdict: "passed" | "rejected" | "skipped" | "error";
	model?: string;
	reason?: string;
	items: { taskId: string; pYes: number }[];
	ms: number;
}

const EVIDENCE_MAX_CHARS = 2_000;
// Jev takes 32k tokens of state plus the longest question; stay well under.
const STATE_MAX_CHARS = 80_000;
const TIMEOUT_MS = 10_000;

// Wording validated by the replay in MILESTONES.md; re-run it before changing.
const TASK_QUESTION = "Does the recorded `evidence` of the task in `tasks` whose id is `task_id` state that its `requirement` was met?";
const TASK_CRITERIA = {
	true: "The evidence describes work or results that address the requirement.",
	false: "The evidence is missing, unrelated, or describes only partial or planned work.",
};

function flatten(tasks: readonly GoalTask[]): GoalTask[] {
	return tasks.flatMap((task) => [task, ...flatten(task.subtasks ?? [])]);
}

export function buildPrecheckRequest(goal: GoalRecord, completionSummary: string | undefined): { state: unknown; questions: Record<string, unknown> } | null {
	const complete = flatten(goal.taskList?.tasks ?? []).filter((task) => task.status === "complete");
	const asked = complete.filter((task) => task.verificationContract?.trim() && !task.checkRun?.passed);
	if (asked.length === 0) return null;
	const questions = Object.fromEntries(asked.map((task) => [`t:${task.id}`, {
		type: "noul",
		instructions: { task_id: task.id, question: TASK_QUESTION },
		criteria: TASK_CRITERIA,
	}]));
	const state = {
		objective: goal.objective,
		goal_verification_contract: goal.verificationContract ?? null,
		completion_summary: completionSummary ?? null,
		tasks: complete.map((task) => ({
			id: task.id,
			title: task.title,
			requirement: task.verificationContract ?? null,
			evidence: task.evidence ? task.evidence.slice(0, EVIDENCE_MAX_CHARS) : null,
		})),
	};
	return { state, questions };
}

export async function runEvidencePrecheck(args: {
	goal: GoalRecord;
	completionSummary?: string;
	settings: PrecheckSettings;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	fetch?: typeof fetch;
}): Promise<PrecheckOutcome> {
	const started = Date.now();
	const done = (outcome: Omit<PrecheckOutcome, "ms" | "items"> & { items?: PrecheckOutcome["items"] }): PrecheckOutcome =>
		({ items: [], ...outcome, ms: Date.now() - started });
	const env = args.env ?? process.env;
	const request = buildPrecheckRequest(args.goal, args.completionSummary);
	if (!request) return done({ verdict: "skipped", reason: "nothing_to_check" });
	const apiKey = env.TYPESAFE_API_KEY?.trim();
	if (!apiKey) return done({ verdict: "skipped", reason: "no_api_key" });
	const body = JSON.stringify({ model: args.settings.model, ...request });
	if (body.length > STATE_MAX_CHARS) return done({ verdict: "skipped", reason: "oversize" });

	const baseUrl = (env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai").replace(/\/+$/, "");
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
	let response: Response;
	let payload: unknown;
	try {
		response = await (args.fetch ?? fetch)(`${baseUrl}/v1/systemone`, {
			method: "POST",
			headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			body,
			signal,
		});
		if (!response.ok) return done({ verdict: "error", reason: `http_${response.status}` });
		payload = await response.json();
	} catch {
		if (timeout.aborted) return done({ verdict: "error", reason: "timeout" });
		if (args.signal?.aborted) return done({ verdict: "error", reason: "aborted" });
		return done({ verdict: "error", reason: "network" });
	}

	const { model, answers } = (payload ?? {}) as { model?: unknown; answers?: Record<string, { noul?: unknown }> };
	const items: PrecheckOutcome["items"] = [];
	for (const key of Object.keys(request.questions)) {
		const pYes = answers?.[key]?.noul;
		if (typeof pYes !== "number" || !Number.isFinite(pYes) || pYes < 0 || pYes > 1) return done({ verdict: "error", reason: "malformed" });
		items.push({ taskId: key.slice(2), pYes });
	}
	return done({
		verdict: items.some((item) => item.pYes < args.settings.rejectBelow) ? "rejected" : "passed",
		...(typeof model === "string" ? { model } : {}),
		items,
	});
}
