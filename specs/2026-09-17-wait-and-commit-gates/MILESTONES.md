# Milestones

## 2026-09-17 — Session review

Reviewed session `01a0b0d2`. Confirmed the two earlier merges were live: the drafting change produced a toolchain-first task-0, and the project setup check wrote the runtime-state block into `.git/info/exclude` at the moment the goal was created (dialog text does not appear in transcripts). The remaining gaps were a wait that stood in for a blocker and a sweeping checkpoint commit of the user's work.

## 2026-09-17 — Implementation

Added the `depends_on` requirement for new waits and the pre-existing work commit guard.

Setbacks: existing wait fixtures and the SDK worker declared waits without `depends_on` and had to be updated to `producer`; a scheduler test calls the `tool_call` hook with no `input`, so the guard reads `command` defensively.

Validation: `npm run test:all` passed 1026 tests with 9 skipped after the manifest refresh. `check`, `lint`, `test:selfcheck`, and `test:real-api` pass.

## 2026-09-22 — Review fixes

A code review of the fork found the guard inverted and over-eager:

- The asked set disabled the guard after the first block, so the agent could commit by retrying, and the user's reply re-armed it, blocking the commit they had just approved. The set now records an open question; a user run moves it to an answered set that disables the guard for the rest of the goal. The test that asserted "a fresh goal turn guards again" encoded the inverted behaviour and was rewritten to the spec.
- Pre-existing paths were computed as `diff HEAD <baseline>`, which includes every file the goal committed after the baseline, so a goal that started clean was blocked after its own commits. The dirty set is now the stash commit against its own first parent.

Validation: `npm run test:all` passed 1115 tests with 9 skipped; `check` and `lint` pass.
