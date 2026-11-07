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
