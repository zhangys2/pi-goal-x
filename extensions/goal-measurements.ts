import * as fs from "node:fs";
import { atomicWriteGoalFile } from "./storage/goal-files.ts";
import { goalStoragePath } from "./storage/goal-root.ts";
import { loadSettingsSnapshot } from "./goal-settings.ts";
import type { GoalLedgerEvent } from "./goal-ledger.ts";

const RELATIVE_FILE = ".pi/goals/goal_measurements.json";
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const COUNTERS = ["goals_started", "goals_completed", "goals_abandoned", "goals_blocked", "goals_resumed", "checks_passed", "checks_failed", "audits_approved", "audits_rejected"] as const;
export type MeasurementCounter = typeof COUNTERS[number];
type Bucket = { day: string; counts: Partial<Record<MeasurementCounter, number>> };
interface Store { version: 1; buckets: Bucket[] }

function countsFor(event: GoalLedgerEvent): MeasurementCounter[] {
	switch (event.type) {
		case "goal_created": return ["goals_started"];
		case "goal_completed": return ["goals_completed"];
		case "goal_aborted": return ["goals_abandoned"];
		case "goal_blocked": return ["goals_blocked"];
		case "goal_resumed": return ["goals_resumed"];
		case "task_checks": return [event.passed ? "checks_passed" : "checks_failed"];
		case "audit_result": return event.verdict === "approved" ? ["audits_approved"] : event.verdict === "disapproved" ? ["audits_rejected"] : [];
		default: return [];
	}
}
function filePath(cwd: string): string { return goalStoragePath({ cwd }, RELATIVE_FILE); }
function readStore(cwd: string): Store {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath(cwd), "utf8")) as Store;
		if (parsed.version === 1 && Array.isArray(parsed.buckets)) return parsed;
	} catch { /* missing or malformed data starts a fresh aggregate */ }
	return { version: 1, buckets: [] };
}
function prune(store: Store, now: number): void {
	const cutoff = now - MAX_AGE_MS;
	store.buckets = store.buckets.filter((bucket) => {
		const at = Date.parse(`${bucket.day}T00:00:00Z`);
		return Number.isFinite(at) && at >= cutoff && !!bucket.counts && typeof bucket.counts === "object";
	});
}
function write(cwd: string, store: Store): void {
	atomicWriteGoalFile({ cwd }, ".pi/goals", RELATIVE_FILE, JSON.stringify(store, null, 2) + "\n");
}

/** Record only allowlisted aggregate counters; event identity and text are discarded. */
export function recordGoalMeasurements(cwd: string, events: readonly GoalLedgerEvent[], now = Date.now()): void {
	if (loadSettingsSnapshot(cwd).project.layer.measureOutcomes !== true) return;
	const increments = events.flatMap(countsFor);
	if (!increments.length) return;
	const store = readStore(cwd);
	prune(store, now);
	const day = new Date(now).toISOString().slice(0, 10);
	let bucket = store.buckets.find((item) => item.day === day);
	if (!bucket) { bucket = { day, counts: {} }; store.buckets.push(bucket); }
	for (const counter of increments) bucket.counts[counter] = (bucket.counts[counter] ?? 0) + 1;
	store.buckets.sort((a, b) => a.day.localeCompare(b.day));
	write(cwd, store);
}

export function readGoalMeasurements(cwd: string, now = Date.now()): Store {
	const store = readStore(cwd);
	const before = store.buckets.length;
	prune(store, now);
	if (store.buckets.length !== before) write(cwd, store);
	return store;
}

export function resetGoalMeasurements(cwd: string): void {
	try { fs.unlinkSync(filePath(cwd)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function formatGoalMeasurements(store: Store): string {
	const totals = Object.fromEntries(COUNTERS.map((key) => [key, 0])) as Record<MeasurementCounter, number>;
	for (const bucket of store.buckets) for (const key of COUNTERS) totals[key] += bucket.counts[key] ?? 0;
	return `Local outcome measurements (last 90 days)\n${COUNTERS.map((key) => `- ${key.replace(/_/g, " ")}: ${totals[key]}`).join("\n")}\nStored locally as daily aggregate counts only; no goal text or identifiers.`;
}
