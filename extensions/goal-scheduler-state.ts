import { commandHint, commandInstructions, type GoalCommands } from "./goal-controls.ts";
import { randomUUID } from "node:crypto";

export type GoalDispatchKind = "ready" | "check" | "wake" | "repair" | "kickoff" | "recovery";
export interface GoalWait {
	id: string;
	token: string;
	reason: string;
	deadline: number;
	intervalMs?: number;
	remainingChecks?: number;
	nextCheckAt?: number;
	signalled?: boolean;
}
export interface GoalSchedulerState {
	version: 1;
	owner: string;
	generation: string;
	used: number;
	phase: "idle" | "ready" | "waiting" | "claimed" | "running" | "interrupted";
	decision?: { kind: "ready"; purpose: GoalDispatchKind } | { kind: "wait" };
	wait?: GoalWait;
	dispatch?: { id: string; kind: GoalDispatchKind; claimedAt: number };
	repairUsed: boolean;
	/** Optional idle pacing, effective only with idleContinuationBackoff=true. */
	idle?: { runs: number; nextAt: number };
}
export type GoalContinuation =
	| { kind: "ready" }
	| { kind: "wait"; reason: string; deadline: string; depends_on?: "producer" | "user"; wait_id?: string; polling?: { interval_seconds: number; max_checks: number } };

export function newGoalScheduler(owner: string): GoalSchedulerState {
	return { version: 1, owner, generation: randomUUID(), used: 0, phase: "idle", repairUsed: false };
}

/** Corrupt scheduling data must not silently reset spent allowance. */
export function normalizeGoalScheduler(raw: unknown): GoalSchedulerState | undefined {
	if (raw === undefined) return undefined;
	const invalid = (): GoalSchedulerState => ({ ...newGoalScheduler("invalid"), phase: "interrupted", used: Number.MAX_SAFE_INTEGER });
	if (!raw || typeof raw !== "object") return invalid();
	const s = raw as GoalSchedulerState;
	const integer = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
	const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 2000;
	if (s.version !== 1 || !text(s.owner) || !text(s.generation) || !integer(s.used) || typeof s.repairUsed !== "boolean" || !["idle", "ready", "waiting", "claimed", "running", "interrupted"].includes(s.phase)) return invalid();
	if (s.idle !== undefined && (!s.idle || typeof s.idle !== "object" || !integer(s.idle.runs) || s.idle.runs < 1 || s.idle.runs > 6 || !integer(s.idle.nextAt) || s.idle.nextAt > 8_640_000_000_000_000)) return invalid();
	// Goals saved before next actions were removed still carry decision.nextAction.
	// The field is stripped after validation and never makes a goal invalid:
	// rejecting one would strand it as interrupted with spent allowance.
	if (s.decision && (s.decision.kind !== "wait" && (s.decision.kind !== "ready" || !["ready", "repair", "kickoff", "recovery"].includes(s.decision.purpose)))) return invalid();
	if (s.wait) {
		const w = s.wait;
		if (!text(w.id) || !text(w.token) || !text(w.reason) || (!integer(w.deadline) || w.deadline > 8_640_000_000_000_000)) return invalid();
		if (w.intervalMs !== undefined && (!integer(w.intervalMs) || w.intervalMs < 1000 || !integer(w.remainingChecks) || !integer(w.nextCheckAt))) return invalid();
		if (w.intervalMs === undefined && (w.remainingChecks !== undefined || w.nextCheckAt !== undefined)) return invalid();
		if (w.signalled !== undefined && typeof w.signalled !== "boolean") return invalid();
	}
	if (s.dispatch && (!text(s.dispatch.id) || !integer(s.dispatch.claimedAt) || !["ready", "check", "wake", "repair", "kickoff", "recovery"].includes(s.dispatch.kind))) return invalid();
	if ((s.phase === "claimed" || s.phase === "running") && !s.dispatch) return invalid();
	if (s.phase === "ready" && s.decision?.kind !== "ready") return invalid();
	if (s.phase === "waiting" && (!s.wait || s.decision?.kind !== "wait")) return invalid();
	const normalized = structuredClone(s) as GoalSchedulerState;
	if (normalized.decision && "nextAction" in normalized.decision) delete (normalized.decision as Record<string, unknown>).nextAction;
	return normalized;
}

/** Rounded "2h 5m" / "45s" for wait notices; the exact deadline is printed beside it. */
export function formatWaitRemaining(ms: number): string {
	if (ms <= 0) return "now";
	const minutes = Math.round(ms / 60_000);
	if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * The user-facing wait announcement. A wait used to be invisible until its
 * deadline, so a goal could sleep for hours with nothing said.
 */

export function buildWaitNotice(wait: GoalWait, kind: "declared" | "heartbeat", now = Date.now()): string {
	const head = kind === "declared" ? "⏳ Goal waiting" : "⏳ Goal still waiting";
	const lines = [`${head}: ${wait.reason}`, `Deadline ${new Date(wait.deadline).toISOString()} (in ${formatWaitRemaining(wait.deadline - now)}).`];
	if (wait.nextCheckAt !== undefined) lines.push(`Next check in ${formatWaitRemaining(wait.nextCheckAt - now)}; ${wait.remainingChecks} left.`);
	lines.push("/goal-resume to continue now, /goal-pause to stop waiting.");
	return lines.join("\n");
}

export function schedulerSummaryParts(s: GoalSchedulerState | undefined, limit?: number, showRuns = true, idleBackoff = false, commands?: GoalCommands): { runs: string; instructions: string; idlePacing?: string } {
	// An unlimited allowance has no limit to report, so the runs line is left
	// empty rather than rendered as "used/unlimited". A finite allowance is
	// reported unless showAutonomousRuns is off. Enforcement reads the limit
	// elsewhere; this is display only.
	const runs = limit !== undefined && showRuns ? `Autonomous runs: ${s?.used ?? 0}/${limit}${limit === 0 ? " (automatic continuation disabled)" : ""}.` : "";
	const lines: string[] = [];
	let idlePacing: string | undefined;
	if (s) {
		if (idleBackoff && s.phase === "ready" && s.decision?.kind === "ready" && s.decision.purpose === "ready" && s.idle && s.idle.nextAt > Date.now()) {
			const seconds = Math.ceil((s.idle.nextAt - Date.now()) / 1000);
			const time = new Date(s.idle.nextAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
			idlePacing = `Next automatic attempt in ${seconds}s (${time} local). ${commandHint("goal-resume", commands)} now.`;
			lines.push(idlePacing);
		}
		if (s.wait) {
			lines.push(`Waiting: ${s.wait.reason}; wait_id=${s.wait.id}; deadline=${new Date(s.wait.deadline).toISOString()}.`);
			if (s.wait.nextCheckAt !== undefined) lines.push(`Next check: ${new Date(s.wait.nextCheckAt).toISOString()}; ${s.wait.remainingChecks} checks remaining.`);
		}
		if (s.phase === "interrupted") lines.push("Turn stopped. Resume or send a message to continue.");
		if (s.phase === "claimed") lines.push(commandInstructions("Execution requires dispatch admission or explicit /goal-resume after interruption.", commands));
	}
	return { runs, instructions: lines.join("\n"), idlePacing };
}

export function schedulerSummary(s: GoalSchedulerState | undefined, limit?: number, showRuns = true, idleBackoff = false, commands?: GoalCommands): string {
	const { runs, instructions } = schedulerSummaryParts(s, limit, showRuns, idleBackoff, commands);
	return [runs, instructions].filter(Boolean).join("\n");
}
