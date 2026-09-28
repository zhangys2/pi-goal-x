# Milestones

## 2026-09-17 — Design

The request came from a barter-rs session recommendation. Checked pi-subagents 0.45.0: agent frontmatter and `agentOverrides` have no worktree field, so a project `worker.md` cannot supply the default. Managed worktrees require `git status --porcelain -- :!.pi-subagents` to be empty, so unignored `.pi/goals/` made isolation impossible in that session.

User decisions: propose ignore rules and report existing config, never scaffold agent or settings files; let the user choose `.git/info/exclude`, `.gitignore`, or skip each time.

## 2026-09-17 — Implementation

Added `goal-project-config.ts`, wired the offer before goal creation and the worktree default into the `tool_call` hook, and added one active-goal prompt line.

Setback: `npm run test:selfcheck` failed on the new unit test file until the test manifest was refreshed with `--write-manifest`.

Validation: `npm run test:all` passed 1021 tests with 9 skipped. `check`, `lint`, `test:selfcheck`, `test:real-api`, and `bench:gate:naf` all pass.

## 2026-09-18 — Isolated workers forced to the foreground

In a live barter-rs session, two async `worker` runs with `worktree: true` got managed worktrees that stayed untouched: each child session's header recorded the parent repo as its `cwd`, so relative-path edits and one `git commit` landed in the main checkout. Six earlier foreground runs with the same scripts isolated correctly. Filed as nicobailon/pi-subagents#2316.

`keepIsolatedWorkersForeground` now sets `async: false` on implementation-worker launches that request a worktree (top-level or inside the script) and leave `async` unspecified. Explicit `async` is kept, read-only agents stay async, and management actions are untouched. The active-goal prompt says why. This trades concurrency for correctness and should be removed once #2316 is fixed.

## 2026-09-19 — Foreground workaround removed

nicobailon/pi-subagents#2316 was fixed upstream by `4b30e4b` (released in 0.69.0). The local pi-subagents checkout that pi loads was updated to 0.69.0, and the fix's regression test ("aligns initial and resumed background forked sessions with an explicit child cwd") passes on this Windows machine. `keepIsolatedWorkersForeground` is removed, so goal-x no longer touches `async`; the e2e test now asserts that. The worktree default stays. The README and CHANGELOG state the pi-subagents 0.69.0 requirement.
