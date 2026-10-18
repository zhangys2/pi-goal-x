# Self-check and planning follow-up

- Add a successful `process.exit(0)` at the end of the existing self-check branch, matching manifest-write mode. Leave discovery, manifest validation, error exits, and ordinary suite execution unchanged.
- Exercise the real runner through its public CLI in temporary fixture repositories. Copy the current runner, provide an empty adapter hook and one marker-writing test in each discovered suite, and use a matching fixture manifest. Markers prove whether test bodies executed without relying on timing or source-shape assertions.
- Cover matching self-check (including `all --selfcheck`), manifest drift/missing manifest, regular unit/integration/e2e/all runs, and manifest regeneration. Bound child processes and remove only owned temporary fixture directories.
- Register the new test via the existing manifest-write command; existing CI already discovers it and runs the self-check. No new CI step or dependency needed.
- Extend the workflow guide with a short pre-coding checkpoint and update its steering-file pointer. Correct verification guidance to describe manifest-only self-check behavior.
- Validate with the focused runner test file, real manifest self-check, typecheck, lint, and doc/diff checks. Do not rerun unrelated extension-runtime fixtures or change the known Windows baseline.
