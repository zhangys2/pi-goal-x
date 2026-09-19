/**
 * Executed task checks: commands a task declares, run by goal-x without a
 * shell, whose results replace the executor's claim as completion evidence.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

export const MAX_TASK_CHECKS = 8;
export const DEFAULT_CHECK_TIMEOUT_SECONDS = 600;
export const MAX_CHECK_TIMEOUT_SECONDS = 3600;
const MAX_CHECK_OUTPUT_CHARS = 4000;

export interface TaskCheck {
	command: string;
	args: string[];
	timeoutSeconds?: number;
}

export interface TaskCheckResult {
	command: string;
	args: string[];
	exitCode: number | null;
	durationMs: number;
	signal?: string;
	timedOut?: true;
	aborted?: true;
	/** Why the process could not start. */
	error?: string;
	/** Tail of combined stdout and stderr; kept only for the failing check. */
	output?: string;
}

export interface TaskCheckRun {
	passed: boolean;
	at: string;
	results: TaskCheckResult[];
}

export interface TaskCheckInput {
	command: string;
	args?: string[];
	timeout_seconds?: number;
}

/** Validates tool input; returns the stored form or a message naming the problem. */
export function parseTaskChecks(taskId: string, raw: unknown): { ok: true; checks?: TaskCheck[] } | { ok: false; message: string } {
	if (raw === undefined) return { ok: true };
	if (!Array.isArray(raw)) return { ok: false, message: `Task "${taskId}" checks must be an array.` };
	if (raw.length > MAX_TASK_CHECKS) return { ok: false, message: `Task "${taskId}" has ${raw.length} checks; at most ${MAX_TASK_CHECKS} are allowed.` };
	const checks: TaskCheck[] = [];
	for (const item of raw as TaskCheckInput[]) {
		const command = typeof item?.command === "string" ? item.command.trim() : "";
		if (!command) return { ok: false, message: `Task "${taskId}" has a check without a command.` };
		if (item.args !== undefined && (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string"))) return { ok: false, message: `Task "${taskId}" check "${command}" args must be an array of strings.` };
		const timeout = item.timeout_seconds;
		if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_CHECK_TIMEOUT_SECONDS)) {
			return { ok: false, message: `Task "${taskId}" check "${command}" timeout_seconds must be between 1 and ${MAX_CHECK_TIMEOUT_SECONDS}.` };
		}
		checks.push({ command, args: item.args ?? [], ...(timeout !== undefined ? { timeoutSeconds: Math.ceil(timeout) } : {}) });
	}
	return { ok: true, checks: checks.length ? checks : undefined };
}

/** Restores checks from persisted goal JSON, dropping malformed entries. */
export function normalizeTaskChecks(raw: unknown): TaskCheck[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const checks = raw.flatMap((item): TaskCheck[] => {
		if (!item || typeof item !== "object" || typeof item.command !== "string" || !item.command) return [];
		const args = Array.isArray(item.args) ? item.args.filter((arg: unknown): arg is string => typeof arg === "string") : [];
		const timeoutSeconds = typeof item.timeoutSeconds === "number" && item.timeoutSeconds > 0 ? Math.min(item.timeoutSeconds, MAX_CHECK_TIMEOUT_SECONDS) : undefined;
		return [{ command: item.command, args, ...(timeoutSeconds ? { timeoutSeconds } : {}) }];
	});
	return checks.length ? checks : undefined;
}

export function normalizeTaskCheckRun(raw: unknown): TaskCheckRun | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const run = raw as Record<string, unknown>;
	if (typeof run.passed !== "boolean" || typeof run.at !== "string" || !Array.isArray(run.results)) return undefined;
	const results = run.results.filter((r): r is TaskCheckResult => !!r && typeof r === "object" && typeof r.command === "string" && Array.isArray(r.args) && typeof r.durationMs === "number");
	return { passed: run.passed, at: run.at, results };
}

// ── Windows command resolution ─────────────────────────────────────────────
// Node refuses to spawn .cmd/.bat without a shell, and npm, npx and most
// node_modules/.bin tools are .cmd shims. They run through cmd.exe with every
// argument escaped the way cross-spawn does, so no argument is ever parsed as
// cmd syntax.

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdArgument(arg: string, doubleEscape: boolean): string {
	let escaped = arg.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"").replace(/(?=(\\+?)?)\1$/, "$1$1");
	escaped = `"${escaped}"`.replace(CMD_META, "^$1");
	return doubleEscape ? escaped.replace(CMD_META, "^$1") : escaped;
}

function isFile(file: string): boolean {
	try { return statSync(file).isFile(); } catch { return false; }
}

export function resolveWindowsCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): string | undefined {
	const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
	const names = path.extname(command) ? [command, ...extensions.map((ext) => command + ext)] : extensions.map((ext) => command + ext);
	const dirs = /[\\/]/.test(command) ? [cwd] : (env.PATH ?? "").split(";").filter(Boolean);
	for (const dir of dirs) {
		for (const name of names) {
			const candidate = path.resolve(dir, name);
			if (isFile(candidate)) return candidate;
		}
	}
	return undefined;
}

export function spawnPlan(check: TaskCheck, cwd: string, env: NodeJS.ProcessEnv, platform = process.platform): { file: string; args: string[]; verbatim: boolean } {
	if (platform !== "win32") return { file: check.command, args: check.args, verbatim: false };
	const resolved = resolveWindowsCommand(check.command, cwd, env) ?? check.command;
	if (!/\.(?:cmd|bat)$/i.test(resolved)) return { file: resolved, args: check.args, verbatim: false };
	const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
	const line = [resolved.replace(CMD_META, "^$1"), ...check.args.map((arg) => escapeCmdArgument(arg, doubleEscape))].join(" ");
	return { file: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

function killTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
		return;
	}
	try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

function runOne(check: TaskCheck, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<TaskCheckResult> {
	const started = Date.now();
	const base = { command: check.command, args: check.args };
	if (signal?.aborted) return Promise.resolve({ ...base, exitCode: null, durationMs: 0, aborted: true });
	return new Promise((resolve) => {
		const plan = spawnPlan(check, cwd, env);
		let output = "";
		const append = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > MAX_CHECK_OUTPUT_CHARS * 2) output = output.slice(-MAX_CHECK_OUTPUT_CHARS);
		};
		let timedOut = false;
		let aborted = false;
		let settled = false;
		let child: ChildProcess;
		try {
			child = spawn(plan.file, plan.args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: plan.verbatim, detached: process.platform !== "win32" });
		} catch (err) {
			resolve({ ...base, exitCode: null, durationMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const finish = (result: Omit<TaskCheckResult, "command" | "args" | "durationMs">) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ ...base, ...result, durationMs: Date.now() - started });
		};
		const timer = setTimeout(() => { timedOut = true; killTree(child); }, (check.timeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS) * 1000);
		const onAbort = () => { aborted = true; killTree(child); };
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", (err) => finish({ exitCode: null, error: err.message, output: output.slice(-MAX_CHECK_OUTPUT_CHARS) }));
		child.on("close", (code, killSignal) => {
			const failed = code !== 0 || timedOut || aborted;
			finish({
				exitCode: code,
				...(killSignal ? { signal: killSignal } : {}),
				...(timedOut ? { timedOut: true as const } : {}),
				...(aborted ? { aborted: true as const } : {}),
				...(failed && output ? { output: output.slice(-MAX_CHECK_OUTPUT_CHARS) } : {}),
			});
		});
	});
}

function resultPassed(result: TaskCheckResult): boolean {
	return result.exitCode === 0 && !result.timedOut && !result.aborted && !result.error;
}

/** Runs checks in order and stops at the first failure. */
export async function runTaskChecks(cwd: string, checks: readonly TaskCheck[], options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {}): Promise<TaskCheckRun> {
	const at = new Date().toISOString();
	const results: TaskCheckResult[] = [];
	for (const check of checks) {
		const result = await runOne(check, cwd, options.env ?? process.env, options.signal);
		results.push(result);
		if (!resultPassed(result)) return { passed: false, at, results };
	}
	return { passed: true, at, results };
}

export function formatCheckCommand(check: Pick<TaskCheck, "command" | "args">): string {
	return [check.command, ...check.args].map((part) => /[\s"]/.test(part) || part === "" ? JSON.stringify(part) : part).join(" ");
}

function outcome(result: TaskCheckResult): string {
	if (result.aborted) return "aborted";
	if (result.timedOut) return "timed out";
	if (result.error) return `could not start: ${result.error}`;
	if (result.signal) return `killed by ${result.signal}`;
	return `exit ${result.exitCode}`;
}

/** One line per check, for reviewers, the auditor and the report. */
export function formatCheckResults(run: TaskCheckRun): string {
	return run.results.map((result) => `${formatCheckCommand(result)} → ${outcome(result)} (${(result.durationMs / 1000).toFixed(1)}s)`).join("\n");
}

export function formatCheckFailure(run: TaskCheckRun): string {
	const failed = run.results.find((result) => !resultPassed(result));
	if (!failed) return "";
	return [
		`Check failed: ${formatCheckCommand(failed)} (${outcome(failed)}).`,
		failed.output ? `Output (last ${MAX_CHECK_OUTPUT_CHARS} characters):\n${failed.output.trimEnd()}` : "No output.",
	].join("\n");
}
