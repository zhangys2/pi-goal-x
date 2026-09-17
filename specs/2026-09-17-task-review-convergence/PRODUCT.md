# Task review convergence

## Outcome

A goal with several code tasks finishes each task through a small number of reviews, or stops and asks the user. Reviews judge one task's own changes against the contract confirmed before coding, and never flag the extension's own runtime files.

## Evidence

A barter-rs goal session (2026-09-16, `01a0aacc`) implemented a seven-task roadmap over about ten hours without completing it:

- The first goal's review rejected the task for four untracked `.pi/` files. Later reviews kept flagging `.pi/` and `.pi-subagents/`. The agent then ran `git clean`, deleting the active goal and all subagent handoffs; `get_goal` returned "No goal is set".
- Tasks w2, w7, w6, w3, w4, and w5 were started without completing the previous one, and workers ran with `worktree:false`. Every later review saw the other tasks' changes and rejected for scope.
- w5 had 11 rejected completions and w4 had 8. Each retry review found new gaps, and several rejections were `ring`/MinGW build failures in the reviewer's environment.

## Behaviour

### Runtime state

- Task review changed files and diffs leave out `.pi/goals/`, `.pi/.goals-pool-snapshot.json`, and `.pi-subagents/`. Other `.pi/` files are still project changes.

### One code task at a time

- A code task (any task not labelled `code_change: false`) cannot start while a different code task is started and still pending.
- Restarting the open task, starting its ancestor or descendant, and starting a non-code task are allowed.
- In a batch, completing the open task before starting the next one is allowed.
- The refusal names the open task and says to complete it or ask the user whether to skip it.

### Review convergence

- A retry review receives the task's latest rejection since the user last resumed the goal, and states whether each finding is fixed.
- The review treats the verification contract as the checklist. Gaps outside it are non-blocking notes unless they make the contracted work incorrect.
- A verification command that fails because of the environment is reported as an environment blocker, not a code defect.

### Rejection cap

- The third consecutive rejection of the same task since the last `/goal-resume` blocks the goal (`goal_blocked`, source `system`) with the latest findings as the reason, and stops the turn.
- A blocked goal accepts no task updates. `/goal-resume` resets the count.
- Failed reviews (provider errors) do not count.

### Drafting

- Code tasks are sized as independently reviewable changes. Their verification contract lists the tests to add, the exact verification commands, and files or areas out of scope.
- A goal whose verification depends on a build or test command checks that the command runs before confirmation, or makes fixing the toolchain its first task.
- Completion evidence names the exact verification commands, including environment overrides.

## Out of scope

- Subagent worktree isolation belongs to pi-subagents; this extension only refuses overlapping code tasks.
- Unrelated questions asked inside a goal session are the user's choice.
