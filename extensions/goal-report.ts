/**
 * Goal report rendering and writing. The model is derived in
 * goal-report-model.ts; this module turns it into Markdown (with Mermaid for
 * the two graphs) and writes it atomically under .pi/goals/reports/.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { displayObjectiveTitle, formatDuration, formatTokenValue, truncateText } from "./goal-core.ts";
import { atomicWriteGoalFile, GOALS_DIR } from "./storage/goal-files.ts";
import type { GoalReportModel, ReportTaskNode, ReportTaskState } from "./goal-report-model.ts";

export const REPORTS_DIR = `${GOALS_DIR}/reports`;
const MAX_LABEL = 60;
const MAX_FINDINGS = 600;
const MAX_ARTIFACTS = 50;

const STATE_LABEL: Record<ReportTaskState, string> = {
	complete: "complete",
	in_progress: "in progress",
	pending: "pending",
	skipped: "skipped",
	retrying: "rejected, retrying",
};

/** Mermaid node ids must be identifier-safe; task ids are user-chosen slugs. */
function nodeId(id: string): string {
	return `t_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function label(node: ReportTaskNode, withAttempts: boolean): string {
	const attempts = withAttempts && node.attempts > 0 ? ` (${node.attempts}x rejected)` : "";
	const text = truncateText(`${node.id}: ${node.title}`, MAX_LABEL).replace(/["[\]{}|<>]/g, " ").replace(/\s+/g, " ").trim();
	return `${text}${attempts}`;
}

function mermaidGraph(nodes: readonly ReportTaskNode[], options: { styled: boolean; ordered: boolean }): string {
	if (nodes.length === 0) return "";
	const lines = ["```mermaid", "flowchart TD"];
	for (const node of nodes) lines.push(`\t${nodeId(node.id)}["${label(node, options.styled)}"]`);
	for (const node of nodes) {
		if (node.parentId) lines.push(`\t${nodeId(node.parentId)} --> ${nodeId(node.id)}`);
	}
	if (options.ordered) {
		// Declared order between siblings, so an ordered plan reads top to bottom.
		const byParent = new Map<string, ReportTaskNode[]>();
		for (const node of nodes) {
			const key = node.parentId ?? "";
			byParent.set(key, [...(byParent.get(key) ?? []), node]);
		}
		for (const siblings of byParent.values()) {
			const ordered = [...siblings].sort((a, b) => a.order - b.order);
			for (let i = 1; i < ordered.length; i++) lines.push(`\t${nodeId(ordered[i - 1]!.id)} -.-> ${nodeId(ordered[i]!.id)}`);
		}
	}
	if (options.styled) {
		lines.push(
			"\tclassDef complete fill:#1f6f3f,stroke:#0d3b22,color:#fff",
			"\tclassDef in_progress fill:#1f4f8f,stroke:#0d2a4f,color:#fff",
			"\tclassDef retrying fill:#8f5a1f,stroke:#4f300d,color:#fff",
			"\tclassDef skipped fill:#555,stroke:#333,color:#fff",
			"\tclassDef pending fill:#eee,stroke:#999,color:#333",
		);
		for (const node of nodes) lines.push(`\tclass ${nodeId(node.id)} ${node.state}`);
	}
	lines.push("```");
	return lines.join("\n");
}

function cell(value: string | undefined): string {
	return (value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function shortTime(iso: string | undefined): string {
	return iso ? iso.replace("T", " ").replace(/\.\d+Z$/, "Z") : "";
}

function section(title: string, body: string): string {
	return body.trim() ? `## ${title}\n\n${body.trim()}\n` : "";
}

/** Entries observed in the subagent artifact directory; not tracked runs. */
export function goalSubagentArtifacts(cwd: string, window: { from: string; to: string }): string[] {
	const dir = path.join(cwd, ".pi-subagents", "artifacts");
	let names: string[];
	try { names = fs.readdirSync(dir); } catch { return []; }
	const from = Date.parse(window.from);
	const to = Date.parse(window.to);
	const within: Array<{ name: string; at: number }> = [];
	for (const name of names) {
		try {
			const stat = fs.statSync(path.join(dir, name));
			const at = stat.mtimeMs;
			if (at >= from && at <= to) within.push({ name, at });
		} catch { /* a vanished entry is not a report failure */ }
	}
	return within.sort((a, b) => b.at - a.at).slice(0, MAX_ARTIFACTS).map((entry) => entry.name);
}

export function renderGoalReport(model: GoalReportModel, options: { now: number; artifacts?: readonly string[] } ): string {
	const header = [
		`# Goal report: ${displayObjectiveTitle(model.objective)}`,
		"",
		`- Goal: \`${model.goalId}\``,
		`- Status: ${model.status}${model.statusSince ? ` since ${shortTime(model.statusSince)}` : ""}`,
		`- Auto-continue: ${model.autoContinue ? "on" : "off"} · Mode: ${model.sisyphus ? "Sisyphus" : "regular"} · Auditor: ${model.auditorEnabled ? "on" : "off"}`,
		`- Created ${shortTime(model.createdAt)} · Updated ${shortTime(model.updatedAt)}`,
		`- Time spent: ${formatDuration(model.activeSeconds)} · Tokens: ${formatTokenValue(model.tokensUsed)} (goal total; per-task figures below are approximate)`,
		...(model.contract ? [`- Verification contract: ${model.contract}`] : []),
		"",
		`_Generated ${shortTime(new Date(options.now).toISOString())} by pi-goal-x. Derived from the goal file and its ledger; safe to delete._`,
		"",
		"## Objective",
		"",
		model.objective.trim(),
		"",
	].join("\n");

	const tasksTable = model.tasks.length
		? [
			"| Task | Status | Attempts | Started | Finished | Duration |",
			"| --- | --- | --- | --- | --- | --- |",
			...model.tasks.map((task) => `| ${cell(task.id)}: ${cell(truncateText(task.title, 60))} | ${STATE_LABEL[task.state]} | ${task.attempts} | ${shortTime(task.startedAt)} | ${shortTime(task.finishedAt)} | ${task.durationSeconds !== undefined ? formatDuration(task.durationSeconds) : ""} |`),
			"",
			"Tokens and cost per task are not recorded yet: accounting is goal-level, so this table reports time only.",
		].join("\n")
		: "";

	const reviews = [
		...model.tasks.flatMap((task) => {
			const entries = model.reviews.filter((review) => review.taskId === task.id);
			// A task with evidence but no review still belongs here: the quoted
			// claim is the only verification record it has.
			if (!entries.length && !task.evidence) return [];
			return [
				`### ${task.id}: ${truncateText(task.title, 80)}`,
				"",
				...(task.contract ? [`- Contract: ${task.contract}`] : []),
				...(task.evidence ? [`- Evidence (quoted, not re-run): ${task.evidence}`] : []),
				...entries.map((review) => `- ${shortTime(review.at)} — **${review.verdict}**${review.report ? `: ${truncateText(review.report.replace(/\s+/g, " "), MAX_FINDINGS)}` : ""}`),
				"",
			];
		}),
		...(model.audits.length ? ["### Goal audits", "", ...model.audits.map((audit) => `- ${shortTime(audit.at)} — **${audit.verdict}**${audit.report ? `: ${truncateText(audit.report.replace(/\s+/g, " "), MAX_FINDINGS)}` : ""}`), ""] : []),
	].join("\n");

	const attention = model.attention.length
		? model.attention.map((span) => [
			`- **${span.kind}** ${shortTime(span.at)}${span.open ? " (still open)" : ""}${span.seconds !== undefined ? ` — ${formatDuration(span.seconds)}` : ""}`,
			`  - ${span.reason}`,
			...(span.attempts?.length ? [`  - Already tried: ${span.attempts.join("; ")}`] : []),
			...(span.suggestedAction ? [`  - To fix: ${span.suggestedAction}`] : []),
		].join("\n")).join("\n")
		: "";

	const recommendations = model.recommendations.length
		? model.recommendations.map((item) => `- **${item.taskId ?? "goal"}** — ${item.text}\n  - Evidence: ${item.evidence}`).join("\n")
		: "";

	const artifacts = options.artifacts?.length
		? [
			"Observed in `.pi-subagents/artifacts` during this goal's window. pi-goal-x does not track child runs, so these are files, not attributed runs.",
			"",
			...options.artifacts.map((name) => `- \`${name}\``),
		].join("\n")
		: "";

	return [
		header,
		section("Plan", mermaidGraph(model.plan, { styled: false, ordered: model.sisyphus })),
		section("Current state", mermaidGraph(model.current, { styled: true, ordered: false })),
		section("Tasks", tasksTable),
		section("Reviews and verification", reviews),
		section("Attention and lost time", attention),
		section("Subagent artifacts", artifacts),
		section("Timeline", model.timeline.map((entry) => `- ${shortTime(entry.at)} — ${entry.text}`).join("\n")),
		section("Recommendations", recommendations),
	].filter(Boolean).join("\n");
}

/** Report file name, derived from the goal's own active file name so the two are traceable. */
export function reportFileName(goalId: string, createdAt: string): string {
	const stamp = createdAt.replace(/[-:T.]/g, "").slice(0, 14);
	return `report_${stamp}_${goalId}.md`;
}

/**
 * Which tasks need a git changed-file lookup. Only the scope-drift rule uses it,
 * and only a contract that forbids something can produce a finding, so the
 * expensive git work stays proportional to that.
 */
export function tasksNeedingChangedFiles(model: GoalReportModel): string[] {
	return model.tasks
		.filter((task) => task.contract && /\b(do not|never|not|without|outside)\b/i.test(task.contract))
		.map((task) => task.id);
}

export function writeGoalReport(ctx: { cwd: string }, model: GoalReportModel, options: { now: number; artifacts?: readonly string[]; dir?: string }): string {
	const dir = options.dir ?? REPORTS_DIR;
	// resolveGoalPath resolves the file against cwd and uses the root only for
	// containment, so the third argument is the full project-relative path.
	const relPath = `${dir}/${reportFileName(model.goalId, model.createdAt)}`;
	atomicWriteGoalFile(ctx, dir, relPath, renderGoalReport(model, options));
	return relPath;
}
