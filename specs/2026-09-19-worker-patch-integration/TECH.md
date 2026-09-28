# Technical plan

## Why a status, not a tool

The goal tool surface was deliberately consolidated to five tools (`goal-tool-names.ts`, the runtime/token campaign). Integration is task progress, so it is `update_goal_task` status `integrate`, allowed only in the single-task form. `patch_path` and `commit_message` are rejected with any other status and in batches.

## Shape

- `extensions/goal-worker-integration.ts` — git only, no goal state. `integratePatch({ cwd, patchPath, commitMessage, checks, signal })` returns `{ outcome, message, commit?, files?, checkRun?, leftover? }`.
- `integrateWorkerPatch` in `goal-task-tools.ts` — validates the task (exists, pending, started), calls `integratePatch`, and writes `task_checks` (when checks ran) plus `task_integration`. On success the same `updateTask` call appends `{ commit, patchPath, at }` to `task.integrations`.

## Git sequence

All git commands run at the repository top level, because pi-subagents patches use top-relative paths (`--no-relative`).

1. Preconditions: `rev-parse --show-toplevel`, `symbolic-ref -q HEAD` (attached), `rev-parse --verify HEAD`, non-empty patch file, and an empty `status --porcelain=v1 -z --untracked-files=all` after excluding `<prefix>.pi/goals`, `<prefix>.pi/.goals-pool-snapshot.json`, and `.pi-subagents`.
2. `apply --numstat -z` lists the paths the patch touches; `rename from` lines add rename sources, which numstat omits. A patch git cannot parse is rejected before anything changes.
3. `apply --3way --index --whitespace=nowarn`. Patches carry full blob ids (`--binary`), and worker worktrees share the object database, so the three-way fallback has the base blobs it needs.
4. Checks run in the project directory.
5. `commit -q -m <message>`; hooks run.

## Restore

A clean tree is a precondition, so undoing an integration means returning the patch's own paths to `HEAD`, not resetting the repository:

- paths present in `HEAD`: `checkout HEAD --pathspec-from-file=- --pathspec-file-nul` (also clears unmerged index entries);
- paths absent from `HEAD`: `rm --cached --pathspec-from-file=-`, then delete the file.

Both use `--literal-pathspecs` and stdin, for special characters and the Windows command-line limit. Afterwards, any of those paths still uncommitted is returned as `leftover` for the agent to raise with the user. Known limit: an edit the user makes to one of the patch's own paths while checks run is discarded by the restore; edits to every other path are untouched.

## Isolated tasks

- `GoalTask.isolated?: boolean` (structural) and `integrations?: TaskIntegration[]` (progress, kept by `mergeTasksWithExisting`).
- `openCodeTaskConflict` skips a candidate when both it and the target are isolated.
- `reviewTaskBeforeCompletion` uses `gitIntegrationDiff` / `gitIntegrationChangedFiles` (`git show` per integration commit) for isolated tasks instead of the baseline diff.
- `isolatedCompletionGate` rejects completing an isolated code task with no integrations, in both the single and batch validation paths.

## Ledger

`task_integration { goalId, taskId, outcome, patchPath, commit?, files? (≤50), message? (failures, ≤1000 chars), at }`, shown in the activity feed and the report timeline.
