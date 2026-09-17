# Milestones

## 2026-09-17 — Design

The request came from a barter-rs session recommendation. Checked pi-subagents 0.45.0: agent frontmatter and `agentOverrides` have no worktree field, so a project `worker.md` cannot supply the default. Managed worktrees require `git status --porcelain -- :!.pi-subagents` to be empty, so unignored `.pi/goals/` made isolation impossible in that session.

User decisions: propose ignore rules and report existing config, never scaffold agent or settings files; let the user choose `.git/info/exclude`, `.gitignore`, or skip each time.

## 2026-09-17 — Implementation

Added `goal-project-config.ts`, wired the offer before goal creation and the worktree default into the `tool_call` hook, and added one active-goal prompt line.

Setback: `npm run test:selfcheck` failed on the new unit test file until the test manifest was refreshed with `--write-manifest`.

Validation: `npm run test:all` passed 1021 tests with 9 skipped. `check`, `lint`, `test:selfcheck`, `test:real-api`, and `bench:gate:naf` all pass.
