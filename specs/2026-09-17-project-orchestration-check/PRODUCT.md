# Project orchestration check

## Outcome

goal-x never silently adds Pi-specific configuration to a repository. It tells the user what orchestration config exists, proposes only what is missing with the reason, and writes nothing without approval. Implementation workers run in isolated worktrees by default without any persistent project files.

## Evidence

In the barter-rs session (`01a0aacc`), `.pi/` was not git-ignored. goal-x's own state files kept the working tree dirty. pi-subagents refuses `worktree: true` on a dirty tree (it ignores only `.pi-subagents/`), and workers ran with `worktree: false` in the shared worktree. A session review then recommended that goal-x detect project orchestration config, propose missing files with reasons, ask before writing, and default workers to worktrees without persistent files.

## Behaviour

### Detection and proposal

- Runs when a goal is created through drafting confirmation or `/goal-direct` / `/sisyphus-direct`, before the goal starts.
- Outside a git repository, nothing happens.
- Reports existing `.pi/settings.json` with a `subagents` key and `.pi/agents/*.md` files. goal-x does not need either and never creates them.
- Checks whether `.pi/goals/`, `.pi/.goals-pool-snapshot.json`, and `.pi-subagents/` are git-ignored. When all are, nothing is shown.
- When some are not, a dialog lists existing config and the unignored paths, explains why ignoring them matters, and offers: add to `.git/info/exclude` (this machine only), add to `.gitignore` (shared), or skip. Dismissing the dialog counts as skip.
- Rules are anchored to the project directory inside the repository (`/<prefix>.pi/goals/`).
- Asked at most once per repository and project directory per session.
- Without a UI, it reports and writes nothing.
- Skipping never blocks goal creation.

### Worker worktree default

- Applies only while the focused goal is active.
- A `subagent` call without `action` or `worktree` that launches `worker`, `developer`, `coder`, `implementer`, or `develop` (in `workflowScript` or `tasks`) gets `worktree: true`.
- Only when the working tree is clean by pi-subagents' own rule (`git status --porcelain -- :!.pi-subagents`). Otherwise the call is left unchanged.
- An explicit `worktree` value, including child-level `worktree: false` inside a script, is kept.
- The active-goal prompt says implementation subagents default to worktrees, that finished task work should be committed before launching one, and not to pass `worktree: false`.

## Steered requirements

- Scope: ignore rules plus a report of existing config. Never generate `.pi/settings.json` or agent files.
- Destination: the user picks each time between `.git/info/exclude`, `.gitignore`, and skip.
