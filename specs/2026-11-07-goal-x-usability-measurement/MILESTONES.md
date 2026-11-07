# Milestones

- Inspected existing runtime and settings architecture; confirmed lifecycle recovery must remain distinct from `/goal-recovery`'s storage repair, and that auditor choice is per-goal by default. User approved a project-level default auditor setting for newly created goals.
- Implemented first-goal onboarding with an example option, project dismissal, and `/goal-onboarding` to reopen. Added a read-only `/goal-list recovery` view for blocked, paused, waiting, and interrupted-checkpoint goals; it does not infer staleness from age/inactivity or mutate goal state.
- Added an attention/next-actions section to generated goal reports, preserving detailed evidence and recommendations.
- Added project-scoped lightweight/structured/audited settings presets. Presets preserve unrelated/global settings and do not enable evidence precheck. The auditor default applies only to newly created goals; existing per-goal settings remain intact.
- Added opt-in local daily aggregate measurements, an allowlist of counters, 90-day pruning, and settings controls to inspect/disable/reset. Measurements contain no goal IDs or text and are never transmitted.
- Added user documentation to `docs/advanced-usage.md`; README was left unchanged.

## Validation

- Focused feature/regression tests passed: report, command palette, settings, recovery, presets, measurements, and the restored legacy enhancement tests. The new `goal-improvements.test.ts` covers preset scope/preservation, opt-in and text-free aggregates, 90-day pruning, and reset.
- `npm run check`, `npm run lint`, `npm run test:selfcheck`, `git diff --check`, and `npm pack --dry-run --ignore-scripts` passed.
- `npm run test:all` on the preceding implementation snapshot: 1,356 passed, 1 skipped, 1 failed out of 1,358. The failure was `tests/goal-optimization.test.ts`'s `invalid batches reject all changes` byte-for-byte assertion; isolated runs pass, so it is parallel-suite-sensitive and not attributed to these changes.
- Subsequent small changes made preset writes atomic and counted explicit user abandonment. Their focused settings, integration, and measurement tests, plus typecheck/lint/selfcheck, passed; the full suite was not rerun after those final changes.
- `npm run test:serial` also exposed a timing-sensitive assertion in `tests/goal-task-tools.test.ts` that passes in isolation. A mixed integration/settings test invocation once failed a global-settings expectation, while the integration file passed alone. No claim that either full suite mode is green; failures are recorded for follow-up.
