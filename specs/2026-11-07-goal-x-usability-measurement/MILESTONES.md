# Milestones

- Inspected existing runtime and settings architecture; confirmed lifecycle recovery must remain distinct from `/goal-recovery`'s storage repair, and that auditor choice is per-goal by default. User approved a project-level default auditor setting for newly created goals.
- Implemented first-goal onboarding with an example option, project dismissal, and `/goal-onboarding` to reopen. Added a read-only `/goal-list recovery` view for blocked, paused, waiting, and interrupted-checkpoint goals; it does not infer staleness from age/inactivity or mutate goal state.
- Added an attention/next-actions section to generated goal reports, preserving detailed evidence and recommendations.
- Added project-scoped lightweight/structured/audited settings presets. Presets preserve unrelated/global settings and do not enable evidence precheck. The auditor default applies only to newly created goals; existing per-goal settings remain intact.
- Added opt-in local daily aggregate measurements, an allowlist of counters, 90-day pruning, and settings controls to inspect/disable/reset. Measurements contain no goal IDs or text and are never transmitted. Follow-up hardening validates/sanitizes persisted buckets, serializes updates with the goal storage lock, caches the project opt-in layer, and isolates measurement failures from goal/ledger writes.
- Consolidated the new-goal auditor default decision in one helper and made it project-only; global settings cannot silently override it. Added a test that applies a preset and then creates a goal.
- Added user documentation to `docs/advanced-usage.md`; README was left unchanged.

## Validation

- Review hardening: measurement reads validate/sanitize every bucket and counter, updates/reads/resets serialize through the goal-storage lock, and opt-in lookup uses the cached project settings layer. Measurement failures remain best-effort and cannot roll back goal/ledger state. The new-goal auditor helper is shared by direct/guided creation; the default is project-only and ignores global-layer values.
- Focused feature/regression tests passed: onboarding, recovery, report, settings, presets, measurements, and service failure isolation. Coverage includes corrupt bucket sanitation, unusable measurement storage, project-only auditor defaults, preset-to-new-goal behavior, and preserving goal/ledger success when measurement recording throws.
- `npm run check`, `npm run lint`, `npm run test:selfcheck`, `git diff --check`, and `npm pack --dry-run --ignore-scripts` passed. Final `npm run test:all`: 1,360 passed, 1 skipped, 0 failed (1,361 total).
- Earlier PR CI failures were traced to a new test writing global settings into the CI home directory; the test now uses an isolated global settings path.

## 2026-11-07 — Renamed the command tree to /gx

- Migrated the public goal command and its subcommands to the /gx root; /loop remains separate. Legacy goal roots are not registered by default. Stable action IDs and configurable aliases remain unchanged.
- Updated command guidance, worker prompts, tests, documentation, README command table, changelog, and active experiment assets. Added route tests for nested subcommands and argument preservation.

### Validation

- Focused command/lifecycle checks passed: 491 tests, 491 passed.
- `npm run check`, `npm run lint`, `npm run test:selfcheck` (93 unit, 1 integration, 9 e2e manifest entries), and `npm pack --dry-run --ignore-scripts` passed.
- Full suite passed: 1,356 passed, 1 skipped (1,357 total). Run with an isolated `HOME` and `PI_GOAL_GLOBAL_SETTINGS_FILE` unset so tests do not read or inherit the user settings file. An earlier run passed a global-settings override into child Pi processes, disabling the recovery E2E's per-agent auto-focus; rerunning with isolated `HOME` and no override passed the real Pi recovery scenarios.
- `git diff --check` passed after the milestone update.


## 2026-11-08 — Addressed PR #39 review

- Keep subcommand-like objectives on guided drafting when their trailing text is not a valid action argument; preserve recognized status/list/recovery/settings arguments, free-form tweak text, and the explicit `/gx -- <objective>` escape.
- Preserve `/goal/` paths and ordinary `/goal.` prose in command-reference rewriting. Add a one-time interactive notice that former roots require explicit aliases; test former report/onboarding roots as configured aliases.
- Documented the routing and escape syntax. Confirmed surface contracts remain covered by the exact command-palette test and the tool-name/visibility suites. The deleted characterization test's registration-order and duplicate-registration assertions were not retained because they test internal wiring rather than consumer behavior.

### Validation

- Focused routing and drafting tests: 105 passed.
- `npm run check` and `npm run lint` passed.
- Headless extension smoke: `/gx status page redesign` started guided drafting.
- Full `npm run test:all`: 1,364 passed, 1 skipped, 0 failed (1,365 total; 103 test files discovered).


## 2026-11-08 — Restored CI after the /gx command rename

- Moved active controls, lifecycle, and continuation workflows from removed legacy command roots to `/gx`; retained `/goal edit` only as explicit-alias coverage.
- CI exposed partial command settings resolving unconfigured actions to legacy roots. Unset actions now keep canonical `/gx` paths, with regression coverage that a partial override still exposes `/gx direct`.
- A full-suite regression showed that a recognized default subcommand whose action was remapped could fall through to goal drafting. Such forms now show configured command choices; invalid trailing objective text remains draftable.
- Updated the product/technical contract and changelog for partial command overrides and remapped subcommands.

### Validation

- `node scripts/ci-checks.mjs` passed: manifest self-check, controls CLI, live Pi lifecycle, tests (1,365 passed, 1 skipped), and installed-package smoke.
- `npm run check`, `npm run lint`, and both focused command-control regressions passed.
- `git diff --check` passed after this entry.
