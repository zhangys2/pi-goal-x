import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Fail-fast repository-wide integration lock; unknown/stale ownership needs explicit recovery. */
export function acquireIntegrationLock(commonGitDir: string): () => void {
	const lock = path.join(commonGitDir, "goal-x-integration.lock");
	try { mkdirSync(lock); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		throw new Error(`Another integration is running or its lock needs inspection: ${lock}`);
	}
	try { writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { flag: "wx" }); }
	catch (error) { rmSync(lock, { recursive: true }); throw error; }
	let released = false;
	return () => {
		if (released) return;
		released = true;
		rmSync(lock, { recursive: true });
	};
}
