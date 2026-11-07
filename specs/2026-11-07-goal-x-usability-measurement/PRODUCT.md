# Goal-x usability and measurement improvements

## Objective
Make pi-goal-x easier to start, recover, understand, configure, and distinguish from host goal commands, while adding privacy-preserving local evidence about whether its workflow is helping. Deliver five improvements incrementally: first-goal onboarding, lifecycle recovery, actionable reports, per-project process presets, and opt-in outcome measurement.

## Users and problem
Pi developers who have not used goal-x need a quick way to understand and try its existing guided flow. Existing users need a clear return path after interrupted work, a report summary that points to attention-worthy items, simpler choices for configuring workflow rigor, and a distinct command namespace. Maintainers need a way to learn from outcomes without sending goal data off-device.

## Approved product decisions

1. **Onboarding:** Add a short inline walkthrough using a sample goal. Do not duplicate the README. The walkthrough should orient a new user to draft → confirm → work and be dismissible/reachable again.
2. **Recovery:** Add one view that lists open goals needing attention across blocked/awaiting-user-action, paused, persisted waiting, and interrupted-checkpoint states. Call a goal stale only when durable checkpoint state supports that label; do not infer staleness from age or inactivity. Include a suggested next action. Recommendations are informational; selecting a goal or resuming it must remain an explicit user action. This is separate from the existing `/gx recovery` storage-integrity diagnostic/repair flow.
3. **Goal report:** Put a concise attention/next-action summary before the existing detailed report. Preserve the current plan, evidence, audit/check history, timeline, and recommendation sections. Recommendations remain informational and do not execute commands or mutate goals.
4. **Presets:** Add named, per-project profiles based on existing settings. They remain editable after application and only change settings owned by that preset. `lightweight` disables tasks and contracts; `structured` enables tasks and contracts; `audited` enables tasks, contracts, and the completion auditor. All presets keep evidence precheck disabled. Applying a preset must not silently alter global settings or unrelated settings.
5. **Measurement:** Add opt-in, per-project, local-only aggregate counters with no goal text. Make measurement status/data inspectable and resettable in settings. Retain data for a rolling 90 days. No network transmission, external analytics, new service, or goal-text collection.
6. **Command namespace:** Put goal-x commands under `/gx` by default. `/gx` starts a guided regular goal; Sisyphus, direct creation, lifecycle, recovery, settings, onboarding, and report actions use `/gx <subcommand>`. Do not register legacy goal-x command paths by default. Preserve the independent `/loop` command and explicit user-configured aliases.

## Acceptance criteria

### Onboarding
- A first-time user can understand and enter the existing `/gx` draft-and-confirm workflow through the inline walkthrough without needing the README.
- The walkthrough uses an illustrative sample, does not create a goal or start work without explicit confirmation, and can be dismissed and reopened.
- It does not introduce a second goal-creation path or duplicate detailed documentation.

### Recovery
- A single recovery view lists eligible open goals and clearly identifies their blocked/awaiting-user-action, paused, persisted waiting, or interrupted-checkpoint condition and suggested next action. It never infers stale state from age or inactivity.
- The view works with one or many goals and in headless mode (useful text, no mutation).
- Choosing a goal or resuming work is an explicit user action; merely viewing recommendations changes no persisted state.
- Existing `/gx recovery` integrity reporting and confirmed repair behavior remain unchanged.

### Reports
- The report begins with a concise attention/next-action section derived only from existing goal and ledger facts.
- Existing detailed sections and evidence wording remain intact; no claims are fabricated and no checks are rerun merely to render the summary.
- Recommendations are advisory only.

### Presets
- Three named project-scoped presets apply the approved setting combinations above.
- Preset application preserves unrelated project settings, does not change global settings, and can be customized afterward through normal settings controls.
- Preset state is clear and inspectable; reapplying a preset is explicit, not automatic.
- Precheck stays disabled regardless of preset.

### Measurement
- Measurement is disabled until the user explicitly opts in for the current project.
- Stored data contains aggregate counters only, no objectives, task text, paths, prompts, or other goal content; data never leaves the machine.
- Users can inspect and reset stored measurements from settings. Entries older than 90 days are excluded/removed during normal reads or writes.
- No measurement is written when disabled, and reset/disable behavior is tested.

### Command namespace
- `/gx` starts the guided regular-goal draft; `/gx sisyphus` starts an ordered-goal draft.
- Every goal-x action is reachable beneath `/gx` by default, with valid arguments preserved (for example `/gx status verbose`, `/gx recovery repair`, and `/gx list recovery`). If trailing text does not form valid arguments for a matched subcommand, it becomes the guided objective instead of invoking that subcommand; free-form `/gx tweak <change>` text stays with the tweak action. Prefix an objective with `--` (`/gx -- <objective>`) when it matches a valid subcommand form.
- Partial command settings retain `/gx` defaults for unconfigured actions. A recognized built-in form whose action was remapped does not fall through to guided drafting.
- Legacy goal-x roots (`/goal`, `/goal-*`, `/sisyphus*`) are not registered by default. On the first interactive session per extension instance, show a short migration notice that former roots are no longer registered by default and points to `/gx`. Explicit user-configured aliases, including former roots, remain valid; `/loop` remains independent.

## Implementation clarification
Repository inspection found that goal-x has no project setting for the default auditor choice: auditing is enabled by default per goal, with a per-goal bypass. User approved adding a project-level default auditor setting for newly created goals so the audited preset can control this behavior. Existing goals and their saved per-goal auditor choice remain unchanged.

## Constraints and non-goals
- Preserve goal lifecycle invariants, human-owned focus, confirmation for state-changing actions, storage safety, and existing user settings.
- Do not add cloud telemetry, accounts, external APIs, or dependencies.
- Do not change README layout or add a new workflow explanation there; put detailed usage in `docs/` if needed.
- Do not expand goal lifecycle states or add more model-facing gates.
- Keep existing `/gx recovery` storage-integrity diagnostic/repair semantics; lifecycle recovery remains a separate user-facing view.
- Deliver independently testable increments; avoid an all-at-once release coupling unrelated features.

## Success evidence
- Regression tests prove onboarding is non-mutating until explicit user confirmation, recovery suggestions are read-only, report summaries derive from persisted facts, presets preserve unrelated/global settings, and opt-in measurement is local/aggregate/retention-bounded.
- Regression tests prove every default goal-x command is rooted under `/gx`, legacy roots are absent by default, valid arguments reach the intended action, ambiguous objectives fall back to drafting, the `--` escape works, explicit former-root aliases remain valid, and command-reference rewriting leaves path/non-command text untouched.
- Manual UI walkthroughs cover onboarding, multi-goal recovery, settings preset application/customization, and measurement inspect/reset.
- No external telemetry request occurs in any test or manual validation.
