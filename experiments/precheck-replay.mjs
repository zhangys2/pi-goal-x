// Replays archived goal completion claims through the evidence pre-check
// (specs/2026-09-23-jev-pre-audit-gate) and compares with the auditor's verdicts.
// Usage: TYPESAFE_API_KEY=... node --experimental-strip-types experiments/precheck-replay.mjs <.pi/goals dir> <out.json>
import fs from "node:fs";
import path from "node:path";
import { buildPrecheckRequest } from "../extensions/goal-precheck.ts";

const [goalsDir, outFile] = process.argv.slice(2);
const MODEL = process.env.PRECHECK_MODEL ?? "jev-1.13.0";
const key = process.env.TYPESAFE_API_KEY;
if (!key) throw new Error("TYPESAFE_API_KEY not set");

const events = fs.readFileSync(path.join(goalsDir, "goal_events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const archived = new Map();
for (const f of fs.readdirSync(path.join(goalsDir, "archived"))) {
	const text = fs.readFileSync(path.join(goalsDir, "archived", f), "utf8");
	const goal = JSON.parse(text.slice(0, text.indexOf("\n}\n") + 2));
	archived.set(goal.id, goal);
}
const flat = (ts) => ts.flatMap((t) => [t, ...flat(t.subtasks ?? [])]);

// Same request the extension sends, restricted to the tasks complete at the claim.
function buildRequest(goal, tasks) {
	const done = new Map(tasks.map((t) => [t.id, t]));
	const prune = (ts) => ts.map((t) => ({ ...(done.get(t.id) ?? { ...t, status: "pending" }), subtasks: prune(t.subtasks ?? []) }));
	return buildPrecheckRequest({ ...goal, taskList: { ...goal.taskList, tasks: prune(goal.taskList?.tasks ?? []) } }, undefined) ?? { state: null, questions: {} };
}

const failures = [];
async function ask(req) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await askOnce(req);
		} catch (err) {
			failures.push(String(err.message).slice(0, 60));
			if (attempt >= 7) throw err;
			await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
		}
	}
}

async function askOnce(req) {
	const started = Date.now();
	const res = await fetch("https://api.typesafe.ai/v1/systemone", {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify({ model: MODEL, ...req }),
		signal: AbortSignal.timeout(15000),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
	return { ms: Date.now() - started, model: body.model, usage: body.usage, p: Object.fromEntries(Object.entries(body.answers).map(([k, a]) => [k, a.noul])) };
}

// Real claims: task state = archived task list, restricted to tasks completed before the claim.
const rows = [];
const seen = new Map();
for (const [i, e] of events.entries()) {
	if (e.type !== "completion_requested") continue;
	const goal = archived.get(e.goalId);
	const verdict = events.slice(i).find((x) => x.type === "audit_result" && x.goalId === e.goalId)?.verdict;
	const done = new Set(events.slice(0, i).filter((x) => x.type === "task_complete" && x.goalId === e.goalId).map((x) => x.taskId));
	const tasks = flat(goal.taskList?.tasks ?? []).filter((t) => done.has(t.id));
	const req = buildRequest(goal, tasks);
	if (Object.keys(req.questions).length === 0) { rows.push({ kind: "real", goalId: e.goalId, at: e.at, verdict, skipped: "nothing_to_check" }); continue; }
	const sig = JSON.stringify(req);
	if (!seen.has(sig)) seen.set(sig, await ask(req));
	rows.push({ kind: "real", goalId: e.goalId, at: e.at, verdict, ...seen.get(sig) });
}

// Synthetic negatives: one task's evidence replaced, all others real. Expected answer for that task: "no".
const variants = {
	empty: () => "",
	borrowed: (t, others) => others.find((o) => o.id !== t.id)?.evidence ?? "",
	planned: () => "Next I will implement this and run the tests.",
	partial: (t) => `Started on this; ${t.evidence?.split(/[.;]/)[0] ?? ""} but the remaining items are not done yet.`,
};
for (const goal of archived.values()) {
	const tasks = flat(goal.taskList?.tasks ?? []).filter((t) => t.status === "complete");
	for (const target of tasks.filter((t) => t.verificationContract)) {
		for (const [name, make] of Object.entries(variants)) {
			const mutated = tasks.map((t) => (t.id === target.id ? { ...t, evidence: make(t, tasks) } : t));
			const r = await ask(buildRequest(goal, mutated));
			rows.push({ kind: "synthetic", goalId: goal.id, variant: name, target: target.id, ...r });
		}
	}
}

fs.writeFileSync(outFile, JSON.stringify(rows, null, 2));
console.log(`transient failures before success: ${failures.length}`, [...new Set(failures)]);

// Report
const real = rows.filter((r) => r.kind === "real" && r.p);
console.log("REAL CLAIMS (distinct inputs):");
for (const r of real) console.log(` ${r.goalId} ${r.at} auditor=${r.verdict} ${r.ms}ms min=${Math.min(...Object.values(r.p)).toFixed(3)}`, JSON.stringify(Object.fromEntries(Object.entries(r.p).map(([k, v]) => [k, +v.toFixed(3)]))));
console.log("skipped:", rows.filter((r) => r.skipped).length);
const syn = rows.filter((r) => r.kind === "synthetic");
console.log("\nSYNTHETIC (p of mutated task / min p of untouched tasks):");
for (const r of syn) {
	const target = r.p[`t:${r.target}`];
	const others = Object.entries(r.p).filter(([k]) => k !== `t:${r.target}` && k !== "goal").map(([, v]) => v);
	console.log(` ${r.goalId.slice(0, 8)} ${r.target.padEnd(15)} ${r.variant.padEnd(9)} target=${target.toFixed(3)} othersMin=${others.length ? Math.min(...others).toFixed(3) : "-"}${r.p.goal !== undefined ? ` goal=${r.p.goal.toFixed(3)}` : ""}`);
}
console.log("\nTHRESHOLD SWEEP");
const realPs = real.flatMap((r) => Object.values(r.p));
for (const th of [0.05, 0.1, 0.15, 0.2, 0.3, 0.5]) {
	const falseRejectClaims = real.filter((r) => Object.values(r.p).some((v) => v < th)).length;
	const caught = {};
	for (const r of syn) caught[r.variant] = (caught[r.variant] ?? 0) + (r.p[`t:${r.target}`] < th ? 1 : 0);
	const collateral = syn.filter((r) => Object.entries(r.p).some(([k, v]) => k !== `t:${r.target}` && k !== "goal" && v < th)).length;
	console.log(` th=${th}: real false-reject inputs ${falseRejectClaims}/${real.length} (lowest real p=${Math.min(...realPs).toFixed(3)}); caught ${JSON.stringify(caught)} of ${syn.length / 4} each; untouched-task false flags ${collateral}/${syn.length}`);
}
