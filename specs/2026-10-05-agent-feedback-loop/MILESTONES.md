# Implementation and verification

- Read repository instructions, current TypeScript configuration, existing verification scripts/CI from the retrospective, and the historical test-strategy document. That historical document is explicitly superseded; new guidance is separate and current.
- Recorded the approved scope in PRODUCT before changes. Preserved the existing uncommitted extension-hardening work. No runtime implementation, CI, runner, README, dependency, or package-content changes made for this follow-up.
- Baseline: `npm run check` passed before enabling the new compiler restriction.
- Red: an external temporary class fixture with a constructor parameter property was accepted by the compiler configuration (exit 0). The negative-control assertion failed as intended, demonstrating the missing constraint. The fixture's temporary config extended the real repository config and selected only that fixture.
- Added rejected-edit recovery and verification guidance in `docs/agent-workflow.md` and `docs/verification.md`; AGENTS additions are two pointers only. Guidance favors existing filtered Node commands, affected suites at milestones, and final full verification when runtime changes require it.
- Enabled `erasableSyntaxOnly` in `tsconfig.json`. The existing `npm run check` command and CI typecheck now enforce erasable syntax without a new tool or dependency.
- Verification-harness correction: the compiler correctly rejected the fixture with TS1294 and exit 2, but the first assertion incorrectly required exit 1. Corrected the temporary assertion to require a nonzero compiler exit and TS1294. No production changes were needed for this harness mistake.
- Green: the same fixture/configuration setup was rejected with TS1294; `npm run check` passed for the existing project. Temporary fixtures/configs were removed in finally blocks on every run.
- Final: `npm run check`, `npm run lint`, document-link/whitespace validation, and `git diff --check` passed. The exact documented focused command ran one test with one pass and zero reported failures/skips, in approximately 1.2 seconds.
- No full runtime-suite rerun: these changes are documentation and compiler policy only; the existing project's stricter typecheck passed and no runtime code changed. Prior full-suite baseline failures remain recorded in the extension-boundary-hardening spec, not claimed as a new result here. No test entries were added and the manifest is unchanged.
- No commits, releases, or dependency installations performed.

## Approved follow-up: self-check early exit and scope checkpoint

- Updated PRODUCT first for the user's approval of #6 and #4, then recorded the focused CLI-fixture plan in TECH. Windows baseline/CI work remains excluded.
- Added `tests/test-runner.test.ts`, using the real runner CLI in disposable repositories with marker-writing test bodies. The first fixture attempt inherited NODE_TEST_CONTEXT, preventing nested tests from executing independently. Reused the existing SDK subprocess test pattern to omit that variable; no runner changes had been made yet.
- Red/Characterize after fixture correction: 9 tests passed on the old runner (manifest failure handling, ordinary suite execution, regeneration); 2 matching-manifest self-check tests failed because unit tests actually executed. This reproduced the fallthrough without running the project suite.
- Green: added one successful exit at the end of the existing self-check branch. The identical test command passed 11/11 in approximately 3.6 seconds. Matching checks, including `all --selfcheck`, now execute no test bodies; manifest drift/missing-manifest failures and regular unit/integration/e2e/all execution remain covered.
- Added the pre-coding scope/decision/acceptance/verification checkpoint to the workflow guide, without requiring redundant approval for clear requests. Updated the AGENTS pointer and corrected self-check semantics in the verification guide.
- Regenerated the manifest with the existing command; its only change is the new runner test entry. Existing CI discovers the test without workflow modifications.
- Final verification: focused CLI tests 11/11, real `npm run test:selfcheck` (89 unit + 1 integration + 5 e2e entries, validation only), `npm run check`, `npm run lint`, doc/spec link and whitespace checks, and targeted `git diff --check` passed.
- No full extension runtime-suite rerun: the change affects only the manifest-only CLI branch, with public-CLI fixtures pinning normal suite execution. Known Windows baseline failures were not changed or suppressed. No CI, dependency, README, extension implementation, commit, or release changes made in this follow-up.

## PR preparation

- User requested a PR for the completed session work, authorizing a feature-branch commit and push. Target is `zhangys2/pi-goal-x:main` (origin); fetched origin and confirmed local main matches it, with no open PR to reuse.
- Repeated quick checks before publication: typecheck, lint, real manifest-only self-check, all 11 runner CLI regressions, package dry-run inclusion checks for new runtime helpers/integration safety, and diff whitespace all passed.
- PR evidence includes the earlier 118/118 boundary-focused tests and 1,241-test full-suite result (15 failures matching unchanged HEAD). The full extension suite was not rerun after the documentation/compiler-policy/self-check-only follow-ups; CLI execution/regeneration is independently pinned by the new fixture tests. No claim that the full Windows suite is green.
