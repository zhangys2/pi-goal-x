# Verification feedback loops

Use the existing commands in `package.json` and the CI workflow. Choose the smallest loop that proves the current change; do not replace required acceptance checks with a convenient subset.

## During implementation: one behavior

Read the target test names, then select the relevant file and behavior with Node's existing test-name filter. Keep the adapter hook used by the repository runner:

```bash
node --experimental-strip-types --import ./scripts/test-adapter-hooks.mjs --test --test-name-pattern='signal is already aborted' tests/goal-auditor.test.ts
```

This example selects the completion auditor's pre-flight cancellation regression. Substitute the file and pattern for the behavior being changed. Quote the pattern and place Node options before test-file arguments. For nested tests, ensure any required parent tests are selected too.

Confirm that the intended test actually ran: an empty selection or skipped-only result is not evidence. Filtering skips unrelated test bodies, but imports and top-level setup still execute. Prefer a focused public-interface regression over assertions about private implementation shape.

For a bug, reproduce the failure before changing code. For a refactor, pin passing behavior before and after the change. Reuse the same narrow command throughout that loop instead of repeatedly running unrelated Git-heavy fixtures.

## At meaningful milestones: affected coverage

Run the complete affected test files, without the name filter, to catch neighboring behavior regressions. Examples include auditor/core-tool/widget-lifetime coverage for audit-resource changes, and integration/gate coverage for patch-integration changes.

Run the existing static checks for TypeScript changes:

```bash
npm run check
npm run lint
```

`npm run check` includes `erasableSyntaxOnly`: it rejects TypeScript syntax that requires transformation, such as constructor parameter properties, before Node's strip-only test execution encounters it. This is a syntax constraint, not a guarantee of runtime, SDK, or platform compatibility.

## At the final code-delivery boundary

After runtime implementation is stable, run the full configured suite once:

```bash
npm run test:all
```

Retain any contract-specific checks. Run `npm run test:selfcheck` when test entries change; it validates the manifest and exits without running test suites. It does not replace executing the tests. Use `npm pack --dry-run --ignore-scripts` when package contents change. Inspect the final diff and run `git diff --check`.

If implementation changes after final verification, rerun the affected checks; repeat the full suite when those changes invalidate its earlier evidence. Do not claim an earlier run verified later code.

For documentation-only or compiler-policy changes with no runtime changes, use link/example validation and the applicable static/compiler checks, and record why a full runtime rerun is unnecessary. For test-tooling-only changes, use isolated public-CLI fixtures covering affected validation and execution paths, plus applicable static checks; rerun the full suite if the contract requires it or earlier runtime-verification evidence is invalidated. Do not rerun unrelated known failures just to produce another identical log.

## Report evidence accurately

Record commands, selected-test pass/skip counts, and relevant failures in the feature's `MILESTONES.md`. A suite with failures is not green. Compare suspected baseline failures against unchanged code when needed, record the comparison and environment, and reuse that evidence for unchanged failure signatures rather than rebuilding the same baseline repeatedly. Investigate new or changed failures; do not loosen assertions or silently suppress them.
