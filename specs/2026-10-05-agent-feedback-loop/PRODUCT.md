# Faster agent feedback loops

## Approved scope

Implement the user's selected retrospective proposals: #1 rejected-edit recovery, #3 narrower verification, and #5 strip-only TypeScript compatibility checking. The user subsequently approved #6 self-check early exit and #4 a pre-coding scope checkpoint. Windows baseline/CI work (#2) remains excluded.

## Acceptance criteria

1. Add `docs/agent-workflow.md`: after a rejected edit, inspect exact matching, line endings/encoding, uniqueness, and overlap before one corrected retry. If that retry fails, stop guessing and change approach without broad rewrites or overwriting existing work.
3. Add `docs/verification.md`: use existing Node test-name filtering during development, affected suites at meaningful milestones, and a full suite at final code-delivery boundaries. Retain contract-required checks and accurately distinguish skipped tests, baseline failures, and passing verification.
5. Enable `erasableSyntaxOnly` in the existing TypeScript configuration so `npm run check` rejects syntax that Node's strip-only execution cannot run, including constructor parameter properties. Verify rejection with a temporary negative-control fixture and acceptance of the existing project.

4. Add a pre-coding checkpoint to the workflow guide: settle behavior-changing alternatives, exclusions, acceptance criteria, and the verification plan before non-trivial implementation. Ask focused questions only for unresolved decisions; do not require redundant approval for an already clear request.
6. Make `--selfcheck` exit successfully after validating a matching manifest without executing test suites. Preserve manifest-drift/missing-manifest rejection, normal suite execution, and manifest regeneration. Add public-CLI regression coverage and maintain the test manifest.

Keep `AGENTS.md` additions to pointers. Do not change README, CI, dependencies, or unrelated implementation files. Preserve the existing uncommitted extension-hardening work. No release requested. After implementation, the user requested committing the completed session work and opening a PR against the origin fork's main branch.

## Verification scope

This change adds workflow documentation and a compiler constraint, not extension runtime behavior. Verify the documented focused-test command, negative-control compiler rejection, project typecheck, lint, links, and whitespace. For the runner follow-up, test the CLI in disposable fixture repositories to verify self-check success/failure and unchanged normal execution/regeneration, then run the real self-check, typecheck, and lint. A new full extension runtime-suite run is not needed for these changes; the preceding implementation's 15 baseline failures remain recorded in its spec.
