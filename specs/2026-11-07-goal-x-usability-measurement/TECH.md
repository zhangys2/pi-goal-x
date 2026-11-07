# Technical plan: goal-x usability and measurement

## Architecture constraints
- Keep the installer thin (`extensions/goal.ts`) and use existing `GoalCore`/command/widget composition.
- Goal files and the ledger remain authoritative for goal lifecycle facts. Report/recovery views are read-only projections.
- Settings use the existing layered project/global model and `mutateSettingsLayer`; presets write only the project layer and preserve unrelated fields.
- Measurement is separate from goal text and ledger data, stored only in project-local `.pi` runtime storage. Never capture or serialize objectives/tasks.
- Reuse existing UI patterns and avoid adding dependencies or global event hooks that poll.

## Work packages

### 1. Onboarding walkthrough
- Add a small focused module (likely `extensions/goal-onboarding.ts`) for copy/state transitions and register it through `goal-commands.ts` or the existing first-run/user UI entry points identified during implementation.
- Persist a project-layer dismissed/completed marker only after explicit user action; provide a command or settings action to reopen it.
- Reuse existing goal draft command rather than implementing goal creation in the walkthrough.
- Tests: reducer/view model, dismissal/reopen persistence, and no goal mutation before the user chooses the existing draft action.

### 2. Lifecycle recovery view
- Reuse `core.openGoals()` and persisted goal statuses; do not modify `goal-recovery.ts` integrity scans or its `repair` path.
- Derive attention rows for blocked/paused states from persisted state and ledger. Determine stale and awaiting-input from existing durable/runtime facts; if either condition has no reliable durable source, show it only when evidenced, never infer it from absence.
- Add an explicit `/gx list recovery` view that renders a selector in UI and a read-only summary headlessly. Selection may focus a goal only after user choice; resuming remains an explicit command/action.
- Tests: all four states, ordering, multi-goal selection, headless rendering, and byte-for-byte non-mutation on display/cancel.

### 3. Actionable report summary
- Extend the pure `GoalReportModel`/`renderGoalReport` path, building on `recommendations` and `attention` already derived in `extensions/goal-report-model.ts`.
- Add a concise top section selecting and ordering existing recommendation/attention facts. Do not add new generated claims, filesystem scans beyond the current report, or command execution.
- Preserve existing report sections and regeneration policy.
- Tests: empty summary, each supported recommendation category, precedence/order, markdown escaping/truncation, and old detailed sections remain present.

### 4. Per-project presets
- Add a typed preset identifier and application helper in `extensions/goal-settings.ts` (or a focused preset module) that edits only approved keys in the project settings layer via `mutateSettingsLayer`.
- Expose preset selection/application in the existing settings UI and show the setting changes before applying. Store no implicit profile lock: users can edit afterward; make reapplication explicit.
- Ensure `auditor.enabled` is enabled only in audited preset; precheck is not touched/enabled by any profile. Preserve all unrelated fields and global settings.
- Tests: exact mapping, project-only writes, unrelated-key preservation, reapplication, UI cancellation, and precheck remains off.

### 5. Opt-in measurement
- Add a small project-local aggregate store under goal-x runtime storage, separate from goal markdown and `goal_events.jsonl`; schema version it and use atomic safe writes/locking consistent with existing storage utilities.
- Collect only a bounded allowlist of counters that can evaluate workflow outcomes (for example goals started/completed/abandoned, blocked/resumed, checks failed/passed, and audit approved/rejected). Do not include IDs, titles, paths, prompts, or per-goal event rows.
- Gate all writes behind project opt-in. Expose an inspect/reset control in settings; render counts and data window, not raw event details.
- Prune data older than 90 days during reads/writes. Avoid external requests and do not enable the existing precheck.
- Tests: disabled-by-default, schema validation, aggregation without text leakage, 90-day pruning, reset/disable, atomic write failure, and no network calls.

### 6. `/gx` command namespace
- Keep stable command action IDs and custom command settings; change only the default paths to `/gx` and subcommands.
- Route guided goal creation at `/gx`; place Sisyphus, direct creation, lifecycle, status, list/recovery, settings, onboarding, and report actions beneath `/gx <subcommand>`.
- Move `goal-report` and `goal-onboarding` from fixed registrations into the same action router. Keep `/loop` independent.
- Make `/gx settings` the guaranteed settings/recovery entry; remove the old `/goal-settings` fallback. Register roots from the complete route table so the fallback remains available even if configurable actions are disabled.
- Ensure default route metadata drives command hints and argument completions. Explicit project/global aliases remain user-owned and continue to override defaults.
- Tests: default command surface, no legacy roots, subcommand matching and argument preservation, fixed settings/report/onboarding routing, and custom aliases.
- Update active usage docs and changelog with the new paths; do not rewrite historical design notes.

## Implementation order
1. Land focused tests/seams for report summary and settings mutation boundaries.
2. Implement presets and measurement independently, since they share settings UX but have separate storage/privacy contracts.
3. Implement onboarding and recovery as independent command/UI changes.
4. Implement report summary.
5. Implement the `/gx` route defaults and migrate all current callers, tests, and active user documentation.
6. Run affected tests, manual UI checks, full validation, and package checks as applicable; record evidence in `MILESTONES.md`.

## Risks and open implementation details
- A project-level default auditor setting is new; it must affect only newly created goals. Tweak flows preserve the target goal's current auditor choice, and direct/guided creation must use the setting consistently. Existing goal files remain unchanged.
- The repository already has `/gx recovery` for storage integrity; keep its repair path distinct from `/gx list recovery` lifecycle recommendations.
- “Awaiting input” and “stale” must be derived from existing durable evidence or made explicit in state; do not add a new lifecycle status without a separate product decision.
- Aggregate measurement taxonomy must be finalized against actual ledger event types before implementation; maintain an allowlist and tests that reject content fields.
- Onboarding’s first-run condition must not depend on unreliable global state; project-local persistence and explicit reopen path are required.
- Preset application must preserve the layered-settings precedence and avoid overwriting environment/global choices.

## Validation plan
Use the existing commands and focused tests from `docs/verification.md`. For TypeScript changes run `npm run check` and `npm run lint`; run all affected test files and then `npm run test:all`, `npm run test:selfcheck` if test entries change, `npm pack --dry-run --ignore-scripts` if package contents change, and `git diff --check`. Manually verify `/gx`, every subcommand, argument completion, command-not-found behavior for legacy roots, and existing custom aliases. Do not claim external telemetry validation without checking network behavior; default is no network path.
