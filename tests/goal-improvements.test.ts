import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyGoalPreset } from "../extensions/goal-presets.ts";
import { formatGoalMeasurements, readGoalMeasurements, recordGoalMeasurements, resetGoalMeasurements } from "../extensions/goal-measurements.ts";
import { loadGoalSettings, loadSettingsSnapshot, mutateSettingsLayer } from "../extensions/goal-settings.ts";
import type { GoalLedgerEvent } from "../extensions/goal-ledger.ts";

function temp(): string { return mkdtempSync(path.join(tmpdir(), "goal-improvements-")); }

test("presets update only project-owned settings and preserve unrelated values", () => {
	const cwd = temp();
	try {
		const env = { PI_GOAL_GLOBAL_SETTINGS_FILE: path.join(cwd, "global-settings.json") };
		mutateSettingsLayer({ scope: "project", cwd, env, mutation: { op: "set", path: ["maxAutonomousRuns"], value: 7 } });
		mutateSettingsLayer({ scope: "global", cwd, env, mutation: { op: "batch", mutations: [
			{ op: "set", path: ["disableContracts"], value: true },
			{ op: "set", path: ["defaultAuditorEnabled"], value: false },
		] } });
		applyGoalPreset(cwd, "audited");
		const snapshot = loadSettingsSnapshot(cwd, env);
		assert.equal(snapshot.project.layer.disableTasks, false);
		assert.equal(snapshot.project.layer.disableContracts, false);
		assert.equal(snapshot.project.layer.defaultAuditorEnabled, true);
		assert.equal(snapshot.project.layer.maxAutonomousRuns, 7);
		assert.equal(snapshot.global.layer.disableContracts, true);
		assert.equal(snapshot.project.layer.precheck, undefined);
		mutateSettingsLayer({ scope: "project", cwd, env, mutation: { op: "unset", path: ["defaultAuditorEnabled"] } });
		assert.equal(loadGoalSettings(cwd, env).defaultAuditorEnabled, true, "global auditor defaults do not override project-only behavior");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("measurements are opt-in, aggregate allowlisted events, and retain no goal text", () => {
	const cwd = temp();
	const now = Date.parse("2026-11-07T12:00:00Z");
	const events: GoalLedgerEvent[] = [
		{ type: "goal_created", goalId: "secret-id", objective: "secret objective", sisyphus: false, autoContinue: true, at: new Date(now).toISOString() },
		{ type: "task_checks", goalId: "secret-id", taskId: "private-task", passed: false, trigger: "completion", results: [], at: new Date(now).toISOString() },
	];
	try {
		recordGoalMeasurements(cwd, events, now);
		assert.equal(readGoalMeasurements(cwd, now).buckets.length, 0, "default is off");
		mutateSettingsLayer({ scope: "project", cwd, mutation: { op: "set", path: ["measureOutcomes"], value: true } });
		recordGoalMeasurements(cwd, events, now);
		const file = path.join(cwd, ".pi", "goals", "goal_measurements.json");
		const raw = readFileSync(file, "utf8");
		assert.doesNotMatch(raw, /secret-id|secret objective|private-task/);
		assert.match(formatGoalMeasurements(readGoalMeasurements(cwd, now)), /goals started: 1/);
		assert.match(raw, /checks_failed/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("malformed measurement buckets and counter values are sanitized before use", () => {
	const cwd = temp();
	const now = Date.parse("2026-11-07T12:00:00Z");
	try {
		mutateSettingsLayer({ scope: "project", cwd, mutation: { op: "set", path: ["measureOutcomes"], value: true } });
		const file = path.join(cwd, ".pi", "goals", "goal_measurements.json");
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ version: 1, buckets: [null,
			{ day: "bad-date", counts: { goals_started: 3 } },
			{ day: "2026-11-07", counts: { goals_started: "3", checks_failed: 4, unexpected: 7 } },
		] }));
		assert.doesNotThrow(() => readGoalMeasurements(cwd, now));
		recordGoalMeasurements(cwd, [{ type: "goal_created", goalId: "not-stored", objective: "not-stored", sisyphus: false, autoContinue: true, at: new Date(now).toISOString() }], now);
		const store = readGoalMeasurements(cwd, now);
		assert.deepEqual(store.buckets, [{ day: "2026-11-07", counts: { checks_failed: 4, goals_started: 1 } }]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("measurement write failure on an unusable store is surfaced to the non-critical caller", () => {
	const cwd = temp();
	const now = Date.parse("2026-11-07T12:00:00Z");
	try {
		mutateSettingsLayer({ scope: "project", cwd, mutation: { op: "set", path: ["measureOutcomes"], value: true } });
		const file = path.join(cwd, ".pi", "goals", "goal_measurements.json");
		mkdirSync(file, { recursive: true });
		assert.throws(() => recordGoalMeasurements(cwd, [{
			type: "goal_created", goalId: "not-stored", objective: "not-stored", sisyphus: false, autoContinue: true, at: new Date(now).toISOString(),
		}], now));
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("measurement reads prune buckets beyond 90 days and reset removes the aggregate file", () => {
	const cwd = temp();
	const now = Date.parse("2026-11-07T12:00:00Z");
	try {
		mutateSettingsLayer({ scope: "project", cwd, mutation: { op: "set", path: ["measureOutcomes"], value: true } });
		const file = path.join(cwd, ".pi", "goals", "goal_measurements.json");
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ version: 1, buckets: [
			{ day: "2026-01-01", counts: { goals_started: 1 } },
			{ day: "2026-11-07", counts: { goals_started: 2 } },
		] }));
		const recent = readGoalMeasurements(cwd, now);
		assert.deepEqual(recent.buckets.map((bucket) => bucket.day), ["2026-11-07"]);
		const persisted = JSON.parse(readFileSync(file, "utf8")) as { buckets: Array<{ day: string }> };
		assert.deepEqual(persisted.buckets.map((bucket) => bucket.day), ["2026-11-07"]);
		resetGoalMeasurements(cwd);
		assert.throws(() => readFileSync(file, "utf8"), { code: "ENOENT" });
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
