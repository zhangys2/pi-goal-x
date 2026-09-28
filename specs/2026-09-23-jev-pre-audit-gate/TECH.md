# Technical plan (log-only release)

## Shape

- `extensions/goal-precheck.ts` has no goal state and no pi imports.
  - `buildPrecheckRequest(goal, completionSummary)` returns `{ state, questions }`, or `null` when there is nothing to ask.
  - `runEvidencePrecheck({ goal, completionSummary, settings, env, signal, fetch? })` returns a `PrecheckOutcome`: `{ verdict, model?, reason?, items: { taskId, pYes }[], ms }`. It never throws.
- `goal-completion.ts`, right before the auditor call: when `settings.precheck.enabled`, start the pre-check promise with the audit's abort signal. Right after the auditor returns, and before any of the post-audit branches (focus cancel, Escape dialog, verdicts), await it and append a `precheck_result` event. Placing it there means it only runs where an audit runs, and every audited path records exactly one event.
- `GoalCore.dependencies.runEvidencePrecheck?` is a test seam beside `runCompletionAuditor`.

## Request

`POST ${TYPESAFE_BASE_URL ?? "https://api.typesafe.ai"}/v1/systemone` with `Authorization: Bearer $TYPESAFE_API_KEY`. The call uses global `fetch` and `AbortSignal.any([signal, AbortSignal.timeout(10000)])`, and is not retried.

State is one object, so every question refers to named fields:

```json
{
  "objective": "<goal objective>",
  "goal_verification_contract": "<text or null>",
  "completion_summary": "<executor claim or null>",
  "tasks": [{ "id": "export", "title": "…", "requirement": "…", "evidence": "…" }]
}
```

`tasks` holds every complete task, including subtasks, with evidence truncated to 2,000 characters. One question is sent per complete task that has a requirement and no passing `checkRun`, keyed `t:<taskId>`:

```json
{ "type": "noul",
  "instructions": { "task_id": "export",
    "question": "Does the recorded `evidence` of the task in `tasks` whose id is `task_id` state that its `requirement` was met?" },
  "criteria": { "true": "The evidence describes work or results that address the requirement.",
                "false": "The evidence is missing, unrelated, or describes only partial or planned work." } }
```

This is the wording the replay validated; change it only with another replay run. The goal contract stays in `state` as context but gets no question of its own.

Outcomes:

| Condition | Verdict | Reason |
| --- | --- | --- |
| No question to ask | `skipped` | `nothing_to_check` |
| `TYPESAFE_API_KEY` unset | `skipped` | `no_api_key` |
| Serialized state over 80,000 characters | `skipped` | `oversize` |
| Non-2xx response | `error` | `http_<status>` |
| Every `answers[key].noul` a finite number in [0, 1] | `rejected` if any is below `rejectBelow`, else `passed` | — |
| Otherwise | `error` | `malformed`, `timeout`, `aborted`, or `network` |

## Settings

`precheck?: { enabled?, model?, rejectBelow? }` is parsed, layered (project over global over default), resolved, and persisted like `oracle` in `goal-settings.ts`. Defaults are `false`, `"jev-1.13.0"`, and `0.15`. `rejectBelow` must be a number in [0.01, 0.5]. Only `enabled` gets a settings-menu row (`goal-commands.ts`, section "Evidence pre-check"); `model` and `rejectBelow` are set in the settings file.

## Ledger

`{ type: "precheck_result"; goalId; verdict: "passed" | "rejected" | "skipped" | "error"; enforced: boolean; model?: string; reason?: string; items: { taskId: string; pYes: number }[]; ms: number; at }`

It gets a validation case in `goal-ledger.ts` and is a no-op in reconstruction. It isn't shown in the activity feed or the report in this release.

## Tests

`tests/goal-precheck.test.ts`: unit tests with a stubbed `fetch`, plus completion-flow tests using the core-tools harness and a stubbed `runEvidencePrecheck`.

1. The request contains only the right tasks. Complete tasks with a contract are asked about. Tasks with passing checks, skipped tasks, and tasks without a contract are not. Subtasks are included. Evidence is truncated. The model and auth header are set.
2. Verdicts: all above the threshold gives `passed`; one below gives `rejected`.
3. Each failure maps to its verdict and reason without throwing: no key, nothing to check, oversize, 500, fetch throws, abort, a missing answer key, a value that isn't a number.
4. Flow, disabled (the default): the pre-check isn't called and no `precheck_result` is written.
5. Flow, enabled with an approving auditor: exactly one `precheck_result` with `enforced: false`, appended before `audit_result`. The completion result and auditor arguments match the disabled run.
6. Flow, enabled, pre-check `rejected` while the auditor approves: the goal still completes, so the pre-check result never changes the outcome.
7. Flow, auditor disabled in settings: the pre-check isn't called.
8. Settings: parse, layering, defaults, invalid `rejectBelow`, and an unknown key.

## Replay harness

`experiments/precheck-replay.mjs` is not shipped. It reads archived goals and the ledger under a given `.pi/goals` directory. For each `completion_requested`, it rebuilds the task state as of that claim, sends the same request as `buildPrecheckRequest` to Jev, and pairs each result with the next `audit_result`. It reports:
- **false rejects:** approved claims that would have been rejected. This must be 0.
- **caught:** rejected claims that would have been rejected.

Real histories rarely contain claims with no evidence behind them, so it also sends made-up bad claims: each task's real evidence is replaced in turn with an empty string, another task's evidence, a statement of planned work, or a statement that the work is partly done. It reports how many are caught and how often an untouched task drops below the threshold. It needs `TYPESAFE_API_KEY`.

Once real `precheck_result` events accumulate, the same comparison can be made from the ledger directly, without a replay.

## Risks

- **Evidence is untrusted text.** Jev only returns a probability, and in log-only mode nothing acts on it.
- **Latency:** the pre-check runs concurrently with the auditor. It adds time only when the audit finishes in under 10 seconds and the pre-check is still running.
- **Privacy:** goal text goes to a third party. The feature is off by default, and the settings label says so.
- **Model drift:** the model is pinned. Moving the pin should be re-validated with the replay script.
