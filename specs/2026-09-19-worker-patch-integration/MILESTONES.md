# Milestones

## 2026-09-19 — Spec and implementation

Follows `2026-09-19-executed-task-checks`, which supplies the checks run after a patch applies.

Decisions:

- **A status on `update_goal_task`, not a sixth tool**, to keep the consolidated five-tool surface.
- **Three-way apply of the pi-subagents patch instead of a rebase.** pi-subagents removes the worker's worktree and branch after capturing the patch, so the patch is the only artifact; `git apply --3way` against the recorded blob ids gives rebase semantics.
- **Integrate in place, not in a temporary worktree.** A fresh worktree has no installed dependencies, so most checks would fail there. The clean-tree precondition makes a precise restore possible instead.
- **Restore by path, never `reset --hard`**, so nothing outside the patch can be lost.
- **Isolated tasks are reviewed as their integration commits**, which is what lets two of them be open at once. A shared-worktree code task still conflicts with every open code task.

Setbacks:

- `git apply --numstat` lists only the destination of a rename, so a failed rename integration would have left the source deleted. `rename from` lines in the patch now add the source; covered by a test.
- Several scripted edits missed on tab indentation and were reapplied; no behaviour impact.

Validation: real-repository tests for clean apply on an advanced base, conflict, failing check, rejecting pre-commit hook, dirty tree, detached HEAD, empty and missing patches, runtime-state exclusion, and renames; tool-level tests for parallel isolated tasks, per-task review scope, failure recording, and parameter validation. `npm run test:all` 1079 pass.
