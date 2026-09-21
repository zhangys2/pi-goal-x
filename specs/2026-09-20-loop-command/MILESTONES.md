# Milestones

## 2026-09-20 — /loop lands in the goal extension

Started from a standalone draft (`extensions/index.ts` + `extensions/loop.ts`, a separate extension entry point). Merged into one module, `extensions/goal-loop.ts`, registered from `goal.ts`, because the package ships a single extension (`pi.extensions: ["extensions/goal.ts"]`) and every other module there is a goal-prefixed installer.

Decisions:

- **Schedule from settle, not from send.** `agent_settled` is the first point where pi guarantees no automatic work remains (the same reason goal continuations moved off `agent_end`), so the interval is the gap between runs, never a source of overlapping runs.
- **The controller takes clock, timer, idle, and send seams.** The schedule is then testable without waiting on real time; the command wires the seams to pi.
- **`registerLoopCommand(pi)` runs before `registerGoalEvents(core)`.** In real pi, handlers for one event are a list and order is irrelevant here. The repo's test harnesses keep one handler per event, so registering the loop first leaves the goal lifecycle handlers as the ones those harnesses resolve.
- **Argument errors are notifications, not throws**, matching the rest of the palette.

Setbacks:

- `constructor(private readonly options: …)` failed under `node --experimental-strip-types` (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`: parameter properties). Replaced with an explicit field assignment.
- A heredoc write of the module was rejected by the shell wrapper; written with the editor tool instead. No behaviour impact.

Surface change: the pinned palette grows from 17 to 18 commands (`tests/goal-surface-baseline.test.ts`, `tests/goal-command-palette.test.ts` updated deliberately).

Validation: `tests/goal-loop.test.ts` (18 tests) covers duration and argument parsing, immediate send, settle-then-interval pacing, busy-session deferral, deadline clamping and stop, timer cancellation, send failure, status text, last-prompt reuse, replacement, shutdown, and argument completions. `npm run check`, `npm run lint`, and `npm test` (1036 pass, 5 skipped) are green.
