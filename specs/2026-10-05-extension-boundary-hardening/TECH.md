# Technical plan

## 1. Cancellation

Use native AbortSignal composition for the tool signal, context signal, and existing Escape controller. Forward it to nested model sessions/checks. Guard durable mutations after asynchronous work, including injected reviewers that ignore cancellation. Completion audit cleanup belongs in finally, and shutdown must abort live audit work and clear timers. Preserve the existing Escape choice only when the parent operation was not cancelled.

## 2. Integration

Retain the clean-tree precondition, three-way application, and path-scoped rollback. Add bounded asynchronous Git execution and a repository-scoped cross-process lock covering validation through rollback/commit. Capture the original HEAD and ownership snapshots; detect unexpected concurrent changes rather than overwriting them. Cancellation must still permit bounded recovery commands.

## 3. Auditor boundary

Decision B: keep `createAgentSession` cwd and `read/grep/find/ls/bash` tools unchanged. Add the trust-boundary explanation to `docs/advanced-usage.md` (already shipped in the package) and the architecture document, and clarify the default auditor prompt and relevant comments. Resource isolation refers to default empty extension/skill discovery and an independent conversation, not OS/filesystem enforcement. Additional workspace paths are guidance, not access-control allowlists; opt-in project resources may add executable behavior.

## 5. Refactoring

Extract `GoalAuditRuntime` into `extensions/goal-audit-runtime.ts`, owning progress, the Escape controller, animation, short-lived result cards, and idempotent shutdown. Start/update/finish identify operations by their controller so an old cancelled audit cannot clear a replacement audit. Keep core accessors as compatibility delegates; completion calls runtime start/update/finish and shutdown calls one cleanup method. Preserve the existing 80ms animation and 6-second result card. Characterize through the already-green registered-tool cancellation, replacement-session, rejection/approval, Escape, and shutdown tests before moving code. Leave settings and questionnaire modules unchanged.

## Feedback loop

Baseline: `node --experimental-strip-types --import ./scripts/test-adapter-hooks.mjs --test tests/goal-auditor.test.ts tests/goal-core-tools.test.ts tests/goal-task-checks-gate.test.ts tests/goal-task-review.test.ts tests/goal-worker-integration.test.ts`.

Final checks: `npm run check`, `npm run lint`, `npm run test:all`, and test-manifest self-check if new test entries are added.

## PR #31 context gate follow-up

Compare the two auditor captures against a counterfactual with the previous system/checklist wording, retaining the same SDK/platform/fixture data. Confirm the intentional delta is limited to child request size and extension-attributable size, with semantic counts and parent request breakdowns unchanged. Update only those fields in the two committed fixture rows and the corresponding aggregate totals; do not regenerate unrelated platform-specific SDK measurements or relax the gate. Validate the strict gate in a Linux-equivalent SDK capture when available, provider/retention boundaries, and the actual GitHub CI run after pushing.
