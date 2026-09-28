# Milestones

## 2026-09-23 — Spec

Motivated by TypeSafe's SDE Cascade cookbook: narrow per-field yes/no checks from a cheap model decide whether an expensive one runs. In goal-x the expensive step is the completion auditor.

Decisions:

- **Reject-only.** Jev reads the executor's claims, not the workspace, so a confident "yes" proves nothing. Only a confident "no evidence" is allowed to act.
- **Ask whether the evidence claims the requirement, not whether the requirement is true.** That keeps the question answerable from text and leaves truth to the auditor.
- **Raw `fetch` rather than `@typesafe-ai/sdk`.** The package has no runtime dependencies, and one endpoint doesn't justify the first one.
- **Key from the environment only.** Project settings files may be committed.
- **Two-rejection limit** derived from the ledger, so a confidently wrong pre-check cannot trap the executor, even across restarts.
- **Pinned model `jev-1.13.0`.** The threshold is tuned against one version.

Before implementation, run the replay harness on real archived goals to choose the default `rejectBelow` and record the false-reject and catch rates. The first replay is recorded below.

## 2026-09-23 — First replay (`jev-1.13.0`, this repo's `.pi/goals`)

Data: 3 archived goals, 12 completion claims (3 approved by the auditor, 9 rejected). The replay script ran from the session scratchpad.
- One goal has no tasks and no contract: `nothing_to_check` on both of its claims.
- In the other two goals, all task evidence was recorded before the first claim. That leaves only 2 distinct inputs, and both belong to goals the auditor eventually approved on the same evidence, so any rejection of them is a false reject.
- Stored evidence is capped at 200 characters, and completion summaries aren't in the ledger.

Real claims (task questions):
- Lowest probability was 0.67, and 0.77–0.95 otherwise.
- No false reject at any threshold up to 0.5.

Goal-contract question:
- 0.17 on the approved goal. In the synthetic runs it ranged 0.09–0.19 whatever the evidence, so it doesn't discriminate. **Dropped from v1.** With it included, the approved goal would have been rejected at any threshold above 0.17.

Synthetic negatives, 10 tasks × 4 variants, probability of the altered task:

| Variant | Range | Caught at 0.15 |
| --- | --- | --- |
| empty | 0.03 | 10/10 |
| planned | 0.03–0.04 | 10/10 |
| partial | 0.06–0.14 | 10/10 |
| borrowed (another task's evidence) | 0.08–0.31 | 7/10 |

An untouched task fell below the threshold once in 40 runs (0.15, in a "borrowed" run: two tasks carrying identical evidence). Default 0.15 kept.

What the replay did not show:
- None of the 9 real auditor rejections was evidence-free. All were substantive: a stale PR, dashboard gaps, missing baselines, legacy heuristics. The pre-check would have saved **0 audits** on this history.
- Its value on real traffic is unproven, and depends on how often executors, especially cheap ones, claim completion before recording evidence.

Latency:
- 2.5–2.8 s per request, not the 100–300 ms the docs suggest. Timeout raised from 5 s to 10 s (the SDK's default).
- The first attempt returned 529 `system_overloaded`, which confirms that falling back to the auditor is required rather than optional.

## 2026-09-23 — Log-only implementation

The user chose log-only first, because the replay showed no false rejects but also no real claim the pre-check would have caught. PRODUCT.md and TECH.md were rewritten around it. Enforcement (rejecting before the audit, the two-rejection limit, visibility) moved to "Later: enforcement".

Built:
- `extensions/goal-precheck.ts`: request building and `runEvidencePrecheck`. It never throws, and each failure maps to `skipped` or `error` with a reason.
- `precheck` settings (`enabled`, `model`, `rejectBelow`) with one menu row.
- The `precheck_result` ledger event.
- In `goal-completion.ts`, the pre-check starts just before the auditor and runs concurrently with it. It is awaited right after the auditor returns, so its event lands before `audit_result` on every audited path.

Decisions:
- **Concurrent, not sequential.** In log-only mode nothing waits on the verdict, so running it beside the auditor keeps the added latency near zero.
- **Only the enable toggle is in the menu.** `model` and `rejectBelow` are expert settings, set in the settings file.
- **No activity-feed or report surface yet.** The ledger is the log. A report section can come with enforcement.

Tests: `tests/goal-precheck.test.ts` has 10 tests covering the request, verdicts, every failure path, settings layering, and the flow (default off, one log-only event before `audit_result` with an unchanged outcome, and no run when the auditor is disabled).

Existing tests updated because the requirement changed, not the code:
- `goal-command-palette` section count 4 → 5
- `integration/extension` row count 19 → 20.

Mistakes fixed in my own new tests:
- Comparing tool text across two goals whose file names differ.
- Reading settings after rewriting a file without clearing the session settings cache.
- Diagnostics carry the key in `settingPath`, not `path`.

Validation:
- `check`, `lint`, and `test:selfcheck` pass. `test:all`: 1125 pass, 0 fail, 9 skipped (platform-specific).
- Live call through `runEvidencePrecheck` against `jev-1.13.0`, using an archived goal: real evidence gave `passed` (lowest 0.79). Emptying one task's evidence gave `rejected` (0.03). Latency was 205–452 ms this time, against 2.5–2.8 s during the replay, so it varies with TypeSafe's load.

Next: enable the pre-check on real goals. Then compare each `precheck_result` with its `audit_result` in the ledger and decide on enforcement using the PRODUCT.md success criteria.

Replay re-run with `experiments/precheck-replay.mjs`, now built on `buildPrecheckRequest` and with no goal-contract question. Porting it first dropped the altered evidence, and that was fixed before this run.
- Real claims: lowest probability 0.72, and no false reject at any threshold up to 0.5.
- Made-up bad claims caught at 0.15: empty 10/10, planned 10/10, partial 9/10 (one scored exactly 0.15), borrowed 7/10 (0.07–0.38).
- An untouched task fell below the threshold 0 times in 40 runs.
- Latency 237–438 ms.
