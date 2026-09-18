/**
 * Project orchestration setup: detect existing Pi project config and whether
 * goal/subagent runtime state is git-ignored, propose missing ignore rules with
 * the reason, and write them only after the user picks a destination. Also
 * defaults implementation-worker subagent launches to managed worktrees.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { GoalCore } from "./goal-state.ts";

/** Runtime state paths, each with a sample path that `git check-ignore` can match. */
const RUNTIME_STATE = [
	{ pattern: ".pi/goals/", sample: ".pi/goals/goal_events.jsonl" },
	{ pattern: ".pi/.goals-pool-snapshot.json", sample: ".pi/.goals-pool-snapshot.json" },
	{ pattern: ".pi-subagents/", sample: ".pi-subagents/artifacts/output.md" },
] as const;

export interface ProjectOrchestration {
	/** Path prefix of cwd inside the repository, e.g. `packages/app/`. */
	prefix: string;
	subagentSettings: boolean;
	projectAgents: string[];
	unignored: string[];
}

function git(cwd: string, args: string[], input?: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"] });
}

function readSubagentSettings(cwd: string): boolean {
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf8"));
		return typeof settings === "object" && settings !== null && "subagents" in settings;
	} catch {
		return false;
	}
}

function listProjectAgents(cwd: string): string[] {
	try {
		return fs.readdirSync(path.join(cwd, ".pi", "agents")).filter((name) => name.endsWith(".md")).sort();
	} catch {
		return [];
	}
}

function ignoredSamples(cwd: string, samples: readonly string[]): Set<string> {
	try {
		return new Set(git(cwd, ["check-ignore", "--no-index", "--stdin"], samples.join("\n")).split(/\r?\n/).filter(Boolean));
	} catch {
		// check-ignore exits 1 when nothing is ignored.
		return new Set();
	}
}

/** Undefined outside a git repository, where ignore rules do not apply. */
export function detectProjectOrchestration(cwd: string): ProjectOrchestration | undefined {
	let prefix: string;
	try {
		prefix = git(cwd, ["rev-parse", "--show-prefix"]).trim();
	} catch {
		return undefined;
	}
	const ignored = ignoredSamples(cwd, RUNTIME_STATE.map((entry) => entry.sample));
	return {
		prefix,
		subagentSettings: readSubagentSettings(cwd),
		projectAgents: listProjectAgents(cwd),
		unignored: RUNTIME_STATE.filter((entry) => !ignored.has(entry.sample)).map((entry) => entry.pattern),
	};
}

export function describeProjectOrchestration(found: ProjectOrchestration): string {
	const existing = [
		found.subagentSettings ? ".pi/settings.json (subagents settings)" : undefined,
		found.projectAgents.length ? `.pi/agents/ (${found.projectAgents.join(", ")})` : undefined,
	].filter(Boolean);
	return [
		`Existing project orchestration config: ${existing.length ? existing.join("; ") : "none (goal-x does not need any)"}.`,
		`Goal runtime state not ignored by git: ${found.unignored.join(", ")}.`,
		"Why: these files change during every goal. While they are untracked, subagent worktree isolation refuses to start (it needs a clean working tree), task reviews and `git status` show them, and cleanup commands such as `git clean` can delete the active goal.",
	].join("\n");
}

export type IgnoreDestination = "exclude" | "gitignore";

export function ignoreFilePath(cwd: string, destination: IgnoreDestination): string {
	const topLevel = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
	if (destination === "gitignore") return path.join(topLevel, ".gitignore");
	return path.resolve(topLevel, git(cwd, ["rev-parse", "--git-path", "info/exclude"]).trim());
}

export function writeIgnoreRules(cwd: string, found: ProjectOrchestration, destination: IgnoreDestination): string {
	const file = ignoreFilePath(cwd, destination);
	let current = "";
	try { current = fs.readFileSync(file, "utf8"); } catch { /* created below */ }
	const rules = found.unignored.map((pattern) => `/${found.prefix}${pattern}`);
	const separator = current && !current.endsWith("\n") ? "\n" : "";
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${separator}# pi-goal-x runtime state\n${rules.join("\n")}\n`, "utf8");
	return file;
}

const EXCLUDE_CHOICE = "Add to .git/info/exclude (this machine only, not committed)";
const GITIGNORE_CHOICE = "Add to .gitignore (shared with the repository)";
const SKIP_CHOICE = "Skip (change nothing)";

const offeredRepos = new Set<string>();

/** Asks at most once per session per repository, and never writes without an explicit choice. */
export async function offerProjectOrchestrationSetup(core: GoalCore, ctx: ExtensionContext): Promise<void> {
	const found = detectProjectOrchestration(ctx.cwd);
	if (!found || found.unignored.length === 0) return;
	const repoKey = `${ignoreFilePath(ctx.cwd, "gitignore")}|${found.prefix}`;
	if (offeredRepos.has(repoKey)) return;
	offeredRepos.add(repoKey);
	const description = describeProjectOrchestration(found);
	if (!ctx.hasUI) {
		ctx.ui.notify(`${description}\nNo changes were made.`, "info");
		return;
	}
	core.enterGoalModal();
	let choice: string | undefined;
	try {
		choice = await ctx.ui.select(`${description}\n\nAdd ignore rules for the missing paths?`, [EXCLUDE_CHOICE, GITIGNORE_CHOICE, SKIP_CHOICE]);
	} finally {
		core.exitGoalModal();
	}
	const destination: IgnoreDestination | undefined = choice === EXCLUDE_CHOICE ? "exclude" : choice === GITIGNORE_CHOICE ? "gitignore" : undefined;
	if (!destination) {
		ctx.ui.notify("Project config unchanged.", "info");
		return;
	}
	try {
		ctx.ui.notify(`Added ignore rules to ${writeIgnoreRules(ctx.cwd, found, destination)}.`, "info");
	} catch (error) {
		ctx.ui.notify(`Could not add ignore rules: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}
}

/** pi-subagents' builtin implementation agent and its aliases. */
const IMPLEMENTATION_AGENTS = new Set(["worker", "developer", "coder", "implementer", "develop"]);

function launchesImplementationWorker(input: Record<string, unknown>): boolean {
	if (typeof input.workflowScript === "string") {
		for (const match of input.workflowScript.matchAll(/\bagent\s*:\s*["'`]([\w-]+)["'`]/g)) {
			if (IMPLEMENTATION_AGENTS.has(match[1]!)) return true;
		}
	}
	return Array.isArray(input.tasks) && input.tasks.some((task) => IMPLEMENTATION_AGENTS.has((task as { agent?: unknown })?.agent as string));
}

function workingTreeClean(cwd: string): boolean {
	try {
		const topLevel = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
		// Mirrors pi-subagents' own precondition for managed worktrees.
		return git(topLevel, ["status", "--porcelain", "--", ":!.pi-subagents"]).trim() === "";
	} catch {
		return false;
	}
}

/**
 * Sets `worktree: true` on a subagent launch that runs an implementation worker
 * and leaves isolation unspecified. An explicit `worktree` is kept. A dirty tree
 * is left alone because pi-subagents would refuse the isolated launch.
 */
export function defaultWorkerWorktree(input: Record<string, unknown>, cwd: string): boolean {
	if (input.worktree !== undefined || input.action !== undefined) return false;
	if (!launchesImplementationWorker(input) || !workingTreeClean(cwd)) return false;
	input.worktree = true;
	return true;
}

function requestsWorktree(input: Record<string, unknown>): boolean {
	return input.worktree === true || (typeof input.workflowScript === "string" && /\bworktree\s*:\s*true\b/.test(input.workflowScript));
}

/**
 * Runs an isolated implementation-worker launch in the foreground when `async`
 * is unspecified. Async runs lose their worktree: the forked child runs with the
 * parent repo as its cwd, so its edits and commits land in the main checkout
 * (nicobailon/pi-subagents#2316). Foreground runs isolate correctly, and also
 * surface a dirty-tree refusal immediately instead of after a receipt (#2311).
 * Remove once #2316 is fixed. An explicit `async` is kept.
 */
export function keepIsolatedWorkersForeground(input: Record<string, unknown>): boolean {
	if (input.async !== undefined || input.action !== undefined) return false;
	if (!launchesImplementationWorker(input) || !requestsWorktree(input)) return false;
	input.async = false;
	return true;
}
