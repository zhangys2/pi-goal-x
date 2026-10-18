import { spawn, spawnSync } from "node:child_process";

export interface IntegrationGitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	aborted?: boolean;
	timedOut?: boolean;
}

/** Bounded Git execution; cancellation also stops hooks and their descendants. */
export function runIntegrationGit(cwd: string, args: string[], input?: string | Buffer, signal?: AbortSignal, timeoutMs = 60_000): Promise<IntegrationGitResult> {
	if (signal?.aborted) return Promise.resolve({ ok: false, stdout: "", stderr: "Integration cancelled.", aborted: true });
	return new Promise((resolve) => {
		const child = spawn("git", args, { cwd, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let bytes = 0;
		let error = "";
		let aborted = false;
		let timedOut = false;
		let settled = false;
		const kill = () => {
			if (!child.pid || child.exitCode !== null) return;
			if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
			else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
		};
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ ok: code === 0 && !error && !aborted && !timedOut, stdout: Buffer.concat(stdout).toString("utf8"), stderr: error || Buffer.concat(stderr).toString("utf8").trim(), ...(aborted ? { aborted } : {}), ...(timedOut ? { timedOut } : {}) });
		};
		const timer = setTimeout(() => { timedOut = true; error = "Git command timed out."; kill(); }, timeoutMs);
		const onAbort = () => { aborted = true; error = "Integration cancelled."; kill(); };
		signal?.addEventListener("abort", onAbort, { once: true });
		const append = (target: Buffer[], chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes <= 64 * 1024 * 1024) target.push(chunk);
			else { error = "Git output exceeded 64 MiB."; kill(); }
		};
		child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk));
		child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk));
		child.stdin?.on("error", () => {}); // A failed/aborted Git command may close its input early.
		child.on("error", (err) => { error = err.message; finish(null); });
		child.on("close", finish);
		if (signal?.aborted) onAbort();
		if (input !== undefined) child.stdin?.end(input);
	});
}
