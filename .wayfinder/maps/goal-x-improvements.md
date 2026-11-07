## Destination
Ship five user-facing improvements to pi-goal-x: first-goal onboarding, easier recovery, more actionable goal reports, understandable process presets, and useful outcome measurement. Resolve product decisions first, then deliver in small, reviewable increments.

## Notes
- Repository evidence: README, `docs/architecture.md`, `docs/unified-dashboard.md`, `docs/agentic-runtime-prd.md`, `package.json`, and the recent `CHANGELOG.md` were inspected. Existing reports already include derived recommendations; goal state and ledger are durable; project/global settings exist.
- Prefer extending existing flows and persisted settings over adding lifecycle machinery.
- Treat outcome measurement as local-only unless the user explicitly chooses otherwise; no external telemetry or new dependencies by default.
- Do not implement until the relevant decisions are resolved and an implementation spec is explicitly approved. Then deliver incrementally; each improvement should have its own bounded implementation spec where practical.

## Decisions so far
- [Destination and incremental delivery](#destination) — user said “go” to mapping all five improvements for incremental implementation.
- [First-goal onboarding](../tickets/onboarding.md) — short inline walkthrough with sample goal; avoid README duplication.
- [Goal recovery](../tickets/recovery.md) — read-only view covers blocked/awaiting-user-action, paused, persisted waiting, and interrupted-checkpoint goals; staleness is never inferred from age/inactivity.
- [Actionable goal report](../tickets/report.md) — attention/next-action summary before the detailed report; informational-only is the default.
- [Process presets](../tickets/presets.md) — named, customizable, per-project profiles based on existing settings.
- [Preset configuration values](../tickets/preset-values.md) — lightweight disables tasks/contracts; structured enables both; audited enables both plus auditor; precheck remains off.
- [Outcome measurement and privacy](../tickets/measurement.md) — opt-in local-only aggregate counters, no goal text.
- [Measurement consent and retention](../tickets/measurement-consent.md) — opt-in per project, inspectable/resettable in settings, rolling 90-day retention.

## Not yet specified
- Exact report recommendation set and feature-specific acceptance criteria; resolve in implementation specs unless they change product behavior materially.
- Implementation sequencing and overlap; choose during implementation planning.

## Out of scope
- A single bundled release that implements all five without separate scope and validation.
- External telemetry, accounts, or a hosted analytics service absent explicit opt-in and further design.
- Unrelated runtime/lifecycle expansion.
