# Milestones

## 2026-09-19 — Spec and implementation

Motivated by a comparison with pi-orchestrator (HenryQW/pi-harness, ADR 019), which treats directly executed checks as authoritative and reserves model judgment for criteria commands cannot decide. goal-x's reviewer and auditor only ever saw the executor's evidence.

Decisions:

- **No shell.** Matches pi-orchestrator and keeps the recorded command exact. `bash -lc` remains available when a task needs one.
- **Windows batch files through escaped `cmd.exe`**, ported from cross-spawn's escaping rather than adding a runtime dependency. A real `.cmd` test passes `a b`, `x&y` and `q%PATH%` through unchanged.
- **Checks run before the review and regardless of review settings**: a failure costs no model call, and deterministic checks have no reason to follow the reviewer's on/off switches.
- **No retry cap** for failing checks; the autonomous run allowance bounds retries, and the failure message steers environment problems to a block.

Setbacks:

- The first real-`.cmd` test failed because the fixture batch file itself expanded `%PATH%`; the fixture needed `%%PATH%%`. The escaping was correct.

Context cost: the first schema wording added about 1,580 characters to every active request with tasks (measured with `context:measure`); trimming descriptions brought the combined cost of both specs to about 1,000 characters (~250 tokens). `context:gate` already failed on `main` before this change (stale `baseline-main.json`), so the baseline was not rewritten here.

Validation: `npm run test:all` 1079 pass; `check`, `lint`, `test:selfcheck`, `bench:gate` pass.
