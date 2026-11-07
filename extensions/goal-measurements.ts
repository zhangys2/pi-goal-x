import * as fs from "node:fs";
import { atomicWriteGoalFile } from "./storage/goal-files.ts";
import { goalStoragePath } from "./storage/goal-root.ts";
import { acquireGoalLock } from "./storage/goal-lock.ts";
import { goalSettingsPath, readSettingsLayer } from "./goal-settings.ts";
import type { GoalLedgerEvent } from "./goal-ledger.ts";

const RELATIVE_FILE = ".pi/goals/goal_measurements.json";
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MEASUREMENTS_LOCK_ID = "__pi_goal_x_measurements__";
const MEASUREMENTS_LOCK_OPTIONS = { attempts: 25, retryMs: 2 };
const COUNTERS = ["goals_started", "goals_completed", "goals_abandoned", "goals_blocked", "goals_resumed", "checks_passed", "checks_failed", "audits_approved", "audits_rejected"] as const;
const COUNTER_SET = new Set<string>(COUNTERS);
export type MeasurementCounter = typeof COUNTERS[number];
type Bucket = { day: string; counts: Partial<Record<MeasurementCounter, number>> };
interface Store { version: 1; buckets: Bucket[] }

// Settings-layer objects are stable cache values. Invalidating settings on a
// project edit replaces the object, so the opt-in decision is recomputed then.
const optInCache = new WeakMap<object, boolean>();
function measurementsEnabled(cwd: string): boolean {
	const project = readSettingsLayer(goalSettingsPath(cwd), "project");
	let enabled = optInCache.get(project);
	if (enabled === undefined) {
		enabled = project.layer.measureOutcomes === true;
		optInCache.set(project, enabled);
	}
	return enabled;
}

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
function validDay(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00Z`);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function emptyStore(): Store { return { version: 1, buckets: [] }; }
function readStore(cwd: string): { store: Store; dirty: boolean } {
	let parsed: unknown;
	try { parsed = JSON.parse(fs.readFileSync(filePath(cwd), "utf8")) as unknown; }
	catch (error) {
		return { store: emptyStore(), dirty: (error as NodeJS.ErrnoException).code !== "ENOENT" };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { store: emptyStore(), dirty: true };
	const raw = parsed as { version?: unknown; buckets?: unknown };
	if (raw.version !== 1 || !Array.isArray(raw.buckets)) return { store: emptyStore(), dirty: true };
	let dirty = false;
	const buckets: Bucket[] = [];
	for (const item of raw.buckets) {
		if (!item || typeof item !== "object" || Array.isArray(item)) { dirty = true; continue; }
		const candidate = item as { day?: unknown; counts?: unknown };
		if (!validDay(candidate.day) || !candidate.counts || typeof candidate.counts !== "object" || Array.isArray(candidate.counts)) { dirty = true; continue; }
		const counts: Partial<Record<MeasurementCounter, number>> = {};
		for (const [key, value] of Object.entries(candidate.counts as Record<string, unknown>)) {
			if (!COUNTER_SET.has(key) || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) { dirty = true; continue; }
			counts[key as MeasurementCounter] = value;
		}
		buckets.push({ day: candidate.day, counts });
	}
	const store: Store = { version: 1, buckets };
	if (JSON.stringify(parsed) !== JSON.stringify(store)) dirty = true;
	return { store, dirty };
}
function prune(store: Store, now: number): boolean {
	const cutoff = now - MAX_AGE_MS;
	const before = store.buckets.length;
	store.buckets = store.buckets.filter((bucket) => Date.parse(`${bucket.day}T00:00:00Z`) >= cutoff);
	return store.buckets.length !== before;
}
function write(cwd: string, store: Store): void {
	atomicWriteGoalFile({ cwd }, ".pi/goals", RELATIVE_FILE, JSON.stringify(store, null, 2) + "\n");
}
function withMeasurementsLock<T>(cwd: string, operation: () => T): T {
	const lock = acquireGoalLock({ cwd }, MEASUREMENTS_LOCK_ID, MEASUREMENTS_LOCK_OPTIONS);
	try { return operation(); }
	finally { lock.release(); }
}

/** Record allowlisted daily aggregate counters; event identity and text are discarded. */
export function recordGoalMeasurements(cwd: string, events: readonly GoalLedgerEvent[], now = Date.now()): void {
	if (!measurementsEnabled(cwd)) return;
	const increments = events.flatMap(countsFor);
	if (!increments.length) return;
	withMeasurementsLock(cwd, () => {
		const { store } = readStore(cwd);
		prune(store, now);
		const day = new Date(now).toISOString().slice(0, 10);
		let bucket = store.buckets.find((item) => item.day === day);
		if (!bucket) { bucket = { day, counts: {} }; store.buckets.push(bucket); }
		for (const counter of increments) bucket.counts[counter] = (bucket.counts[counter] ?? 0) + 1;
		store.buckets.sort((a, b) => a.day.localeCompare(b.day));
		write(cwd, store);
	});
}

export function readGoalMeasurements(cwd: string, now = Date.now()): Store {
	return withMeasurementsLock(cwd, () => {
		const { store, dirty } = readStore(cwd);
		const expired = prune(store, now);
		if (dirty || expired) write(cwd, store);
		return store;
	});
}

export function resetGoalMeasurements(cwd: string): void {
	withMeasurementsLock(cwd, () => {
		try { fs.unlinkSync(filePath(cwd)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	});
}

export function formatGoalMeasurements(store: Store): string {
	const totals = Object.fromEntries(COUNTERS.map((key) => [key, 0])) as Record<MeasurementCounter, number>;
	for (const bucket of store.buckets) for (const key of COUNTERS) totals[key] += bucket.counts[key] ?? 0;
	return `Local outcome measurements (last 90 days)\n${COUNTERS.map((key) => `- ${key.replace(/_/g, " ")}: ${totals[key]}`).join("\n")}\nStored locally as daily aggregate counts only; no goal text or identifiers.`;
}
