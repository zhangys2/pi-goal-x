# Milestones

## 2026-09-17 — Diagnosis

Compared every stop transition: paused, stalled, budget and wait-deadline all notify; blocked notified nothing. Found `suggested_action` wired for paused only and `attempted_actions` reaching just the Oracle, while the record field and dashboard row for a suggested action already existed.

## 2026-09-17 — Implementation

Added the attention notification, the required `suggested_action` for blocked, persisted attempts, the dashboard `Tried` row and the session-start restatement. Deferred wait visibility and desktop notifications.

Setbacks:
- Normalizing `blockedAttempts` unconditionally added `blockedAttempts: undefined` to every record and broke the pinned v3 golden; the normalizer now omits the key when empty.
- Five existing tests called `update_goal(blocked)` without `suggested_action` and were updated.
- The first e2e assertion used the expanded dashboard, but blocked details render only in the compact one; and a second harness over the same directory has no focus entry, so the restart check now re-runs `session_start` on the focused goal.

Validation: `npm run test:all` passed 1031 tests with 9 skipped. `check`, `lint` and `test:selfcheck` pass.
