# Worker patch integration

## Outcome

Work done by an isolated worker lands in the goal's branch only after it applies on top of the current branch and the task's checks pass there. Tasks whose work arrives this way can run in parallel, and each is reviewed against only its own integrated changes.

## Evidence

Implementation workers already default to `worktree: true` (spec `2026-09-17-project-orchestration-check`). pi-subagents captures each worker's changes as a machine-applicable patch against the base commit, records it in a handoff manifest, and removes the worktree. Applying that patch was left to the agent: nothing re-checked the work on the newer base, and a conflicting or broken patch could land. Because every code task shared one worktree review scope, code tasks also had to run one at a time.

pi-orchestrator settles each worker, rebases the candidate, re-runs every check directly, and integrates only by fast-forward. This spec brings the same order to goal-x: apply on top → check → commit, or leave the branch untouched.

## Behaviour

### Integrating a patch

`update_goal_task({ task_id, status: "integrate", patch_path, commit_message })` (single-task form only; the goal tool surface stays at five tools):

1. Requires an active focused goal, a pending task that has been started, a git repository on an attached branch, and a clean working tree (ignoring goal and subagent runtime state, as pi-subagents does).
2. Requires `patch_path` to be a non-empty patch file, such as the `patch.path` of a child in a pi-subagents handoff manifest.
3. Applies the patch to the index and working tree with a three-way merge, so a patch made against an older base applies on top of the current branch the way a rebase would.
4. Runs the task's checks (from `2026-09-19-executed-task-checks`) on the result.
5. Commits the applied changes with `commit_message`. Git hooks run.

If any step after the patch starts to apply fails, goal-x restores exactly the paths the patch touched and reports why: the conflicting paths, the failing check, or the commit error. The branch and every other file are left as they were. When the restore itself cannot make the tree clean again, the result names the remaining paths so the agent asks the user.

Every attempt is recorded in the ledger as a `task_integration` event with its outcome: `integrated` (with the commit), `conflict`, `checks_failed`, `commit_failed`, or `rejected` (a precondition failed). Check results are recorded as `task_checks` events.

### Isolated tasks

- `set_goal_tasks` accepts `isolated: true` on a code task: its changes arrive only through `status: "integrate"`.
- Two started isolated tasks may be open at the same time. A started task that edits the shared worktree still conflicts with every other open code task, isolated or not, because its review would include their integrated commits.
- An isolated task's code review sees the combined diff of its integration commits, not the working tree since its start.
- Completing an isolated task with no integration is rejected: integrate a worker patch, or skip the task with a reason.
- Completion still runs the task's checks again, because other tasks may have been integrated since.

### Prompt

The active-goal prompt tells the agent to integrate worker patches with `update_goal_task` status `integrate` instead of applying them by hand, and to mark tasks delegated to isolated workers `isolated: true`.

## Non-goals

- No pushing, pull requests, or branch management beyond one local commit per integration.
- goal-x does not launch workers or read handoff manifests itself; the agent passes the patch path.
- No automatic retry or conflict resolution. A conflict is reported and the agent decides what to do next.
