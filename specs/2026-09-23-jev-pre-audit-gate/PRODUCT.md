# Evidence pre-check before the completion auditor

## Outcome

The eventual goal: when the executor calls `update_goal({status:"complete"})` before its own recorded evidence addresses every requirement, goal-x rejects the claim in a few seconds, names the requirements that lack evidence, and does not start the auditor. Claims whose evidence covers every requirement go to the auditor exactly as today.

**This release is log-only.** The pre-check runs alongside the auditor and records what it would have decided, but it never changes the outcome. The first replay (MILESTONES.md) found no false rejects, but also no real claim it would have caught. Enforcement waits until logs from real goals show it would have caught something without rejecting good claims.

Even when enforced, the pre-check can only reject. It never approves, never replaces the auditor, and never blocks a goal.

## Evidence

- Every completion claim starts a full auditor agent session: a separate model, read-only tools, and often several minutes. A rejected audit costs all of that and one more executor turn.
- A common rejection is a claim made before the evidence exists: a task marked complete with evidence that does not mention its requirement. Reading the executor's own evidence is enough to catch it. The workspace doesn't need to be inspected.
- TypeSafe's Jev model answers yes/no questions about supplied text with a probability, at $0.042 per million input tokens. Its SDE Cascade cookbook uses the same shape: narrow per-field "is this wrong?" questions decide whether an expensive model runs.

## Behaviour (this release: log-only)

### Enabling

Off by default. Settings:

- `precheck.enabled` (default false): a row in `/goal-settings → Evidence pre-check`. Its label says it sends goal text to TypeSafe.
- `precheck.model` (default `jev-1.13.0`), settings file only. Pinned to a version rather than `jev-latest`, because the threshold is tuned against one model and an alias moves on release.
- `precheck.rejectBelow` (default 0.15, range 0.01–0.5), settings file only: the probability under which a requirement counts as having no evidence.

The API key is read only from the `TYPESAFE_API_KEY` environment variable (`TYPESAFE_BASE_URL` optionally overrides the endpoint). It is never stored in a settings file, because project settings files may be committed. If the pre-check is enabled but no key is set, each completion records a `skipped` result with reason `no_api_key`.

Enabling it sends the goal objective, task titles, requirements, evidence text, and the completion summary to `api.typesafe.ai`.

### When it runs

On `update_goal({status:"complete"})`, at the moment the auditor starts. It runs only when the auditor would run: not when the auditor is disabled in settings, and not for goals with the legacy `skipAuditor` flag. It runs concurrently with the auditor, so it adds no time to a completion unless it is still running when the audit finishes. That wait is capped by its 10-second timeout.

### What it asks

One yes/no question per requirement, all in one request:

- Each **complete** task with a `verification_contract` and no passing goal-x checks. Passing checks are already facts, so those tasks aren't asked about. Question: does this task's recorded evidence state that its requirement was met?
- The goal-level verification contract is **not** asked about. In the replay it scored 0.09–0.19 regardless of the evidence, including 0.17 on a goal the auditor approved, so it cannot separate good claims from bad ones (see MILESTONES.md).

Skipped tasks and tasks without a requirement aren't asked about. If nothing is left to ask, the result is `skipped` with reason `nothing_to_check`.

The question is whether the executor *claims* the requirement is met, not whether it is true. Establishing truth stays the auditor's job. So the pre-check only catches claims made before any evidence was recorded.

### Recording

Each run appends one `precheck_result` ledger event after the auditor returns, just before the `audit_result`, so the two can be compared. The event carries:
- the verdict: `passed`, `rejected` (at least one requirement below `rejectBelow`), `skipped`, or `error`
- `enforced: false`
- the model that answered
- each task's probability
- the request time
- the reason for a skip or error.

A failure never affects the completion. Failures include a missing key, a network error, a timeout, a non-2xx response, a malformed answer, and an oversized state; each is recorded as `error` or `skipped` with its reason.

Nothing is shown in the conversation, the dashboard, or the tool result. The auditor never sees the pre-check's result.

## Later: enforcement

Turned on by a future setting once logs justify it:

- **Reject** when any requirement's probability is below `rejectBelow`. Completion returns a tool result naming each such task and its requirement, and tells the executor to do the work or record evidence with `update_goal_task`, then claim completion again. The pre-check runs before the auditor, and the auditor does not start.
- **Rejection limit:** after two consecutive pre-check rejections of one goal, the next claim skips the pre-check with reason `rejection_limit`. The count, derived from the ledger, resets on any audit result.
- **Visibility:** "Evidence pre-check rejected completion (auditor not run)" in the audit stream, and a count of audits avoided in the goal report.

## Non-goals

- No approval path. A confident "yes" never skips the auditor.
- No check of the workspace, files, or command output. That is the auditor's and the task checks' job.
- No other Jev uses (blocker matching, drafting triage). Separate specs.
- No runtime dependency on `@typesafe-ai/sdk`. One `fetch` to one endpoint is enough, and the package ships with no runtime dependencies today.

## Success criteria

- Log-only: when enabled, every audited completion has exactly one `precheck_result` event, and completion results, auditor inputs, and tool results are identical with the pre-check on and off.
- With the pre-check off, no request is made and behaviour, prompts, and tool schemas are unchanged.
- Before enforcement: across logged real goals, no `rejected` pre-check on a claim the auditor approved, and at least one on a claim the auditor rejected.
