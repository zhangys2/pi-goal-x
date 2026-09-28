# Technical plan

## Shape

- `extensions/goal-task-checks.ts` — the runner and its formatting. No goal state: `runTaskChecks(cwd, checks, { signal, env })` returns a `TaskCheckRun` (`passed`, `at`, one `TaskCheckResult` per check that ran). Input parsing (`parseTaskChecks`) and persisted-state normalisation (`normalizeTaskChecks`, `normalizeTaskCheckRun`) live here too, so the record module does not import the tool schema library.
- `checkTaskBeforeCompletion` in `goal-task-review.ts` — the goal-aware step: runs the task's checks, appends a failing `task_checks` event immediately, and returns a passing event for the caller to write with the completion (the same pattern as review approvals).
- `update_goal_task` (single and batch) calls it after completion validation and before `reviewTaskBeforeCompletion`, then stores `checkRun` on the task in the same update.

## Process handling

- `spawn` with `stdio: ["ignore", "pipe", "pipe"]`, `windowsHide`, and `detached` on POSIX so a timeout can kill the process group (`kill(-pid)`). Windows kills the tree with `taskkill /T /F`.
- Output is kept as a rolling tail (at most 8,000 characters in memory, 4,000 stored) and only for a failing check, so passing runs add nothing to the ledger but the command and exit code.
- Windows resolution walks `PATH` × `PATHEXT`. A `.cmd`/`.bat` target is run as `cmd.exe /d /s /c "<escaped line>"` with `windowsVerbatimArguments`, escaping every argument the way cross-spawn does (quote, caret-escape `()[]%!^"`<>&|;, *?`, and double-escape `node_modules/.bin` shims). Node refuses to spawn batch files without a shell since CVE-2024-27980, and every npm tool is one.

## Data

- `GoalTask.checks?: TaskCheck[]` — structural, replaced or cleared by `set_goal_tasks` like `verificationContract`.
- `GoalTask.checkRun?: TaskCheckRun` — progress, kept by `mergeTasksWithExisting` like `evidence`.
- Ledger `task_checks { goalId, taskId, passed, trigger: "completion" | "integration", results, at }`.

## Surfaces

- Reviewer: `detailedSummary` and `completionSummary` gain the passing results, labelled as facts that need no re-run.
- Auditor: `renderAuditorTaskTree` adds a "checks run by goal-x, all passed" line per task.
- Activity feed and report: a `task_checks` case in each; the report lists checks per task and the `unverified_completion` rule ignores tasks whose checks passed.
- Tool schemas: `checks` on `set_goal_tasks` and `propose_goal_draft` task items, kept short because every active request carries them.
