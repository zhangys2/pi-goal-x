# Milestones

## 2026-09-17 — Session review

Reviewed session `01a0b0d2`. Confirmed the two earlier merges were live: the drafting change produced a toolchain-first task-0, and the project setup check wrote the runtime-state block into `.git/info/exclude` at the moment the goal was created (dialog text does not appear in transcripts). The remaining gaps were a wait that stood in for a blocker and a sweeping checkpoint commit of the user's work.

## 2026-09-17 — Implementation

Added the `depends_on` requirement for new waits and the pre-existing work commit guard.

Setbacks: existing wait fixtures and the SDK worker declared waits without `depends_on` and had to be updated to `producer`; a scheduler test calls the `tool_call` hook with no `input`, so the guard reads `command` defensively.

Validation: `npm run test:all` passed 1026 tests with 9 skipped after the manifest refresh. `check`, `lint`, `test:selfcheck`, and `test:real-api` pass.
