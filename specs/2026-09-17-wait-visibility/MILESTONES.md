# Milestones

## 2026-09-17 — Implementation

Completed the follow-up left open by `2026-09-17-wait-and-commit-gates`: waits now announce themselves, remind while waiting, and explain an expiry.

The design question was where the reminder timer lives. Adding a second timer would have meant tracking another handle across `cancelTimer`, `shutdown`, `pause` and `restore`. Capping each sleep at the heartbeat interval instead reuses the existing single timer, and the callback re-enters `schedule`, which already recomputes everything from persisted state.

Deliberately skipped: a configurable interval and a maximum wait deadline. Reminders address the visibility problem without new settings.

Validation: `npm run test:all` passed 1034 tests with 9 skipped; `check`, `lint` and `test:selfcheck` pass. The new scheduler test asserts the reminder dispatches nothing (`sent.length === 0`) and spends nothing (`scheduler.used === 0`).
