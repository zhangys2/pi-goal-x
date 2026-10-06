# Agent workflow

Use the repository's [architecture map](architecture.md) to locate the owner of a change, then read only the relevant source region. Preserve existing uncommitted work.

## Before non-trivial implementation

1. **Bound the scope.** State the requested behavior, constraints, exclusions, and smallest useful change. Separate optional improvements from required work.
2. **Resolve behavior-changing choices.** Identify alternatives that affect architecture, safety, or user-visible behavior. If unresolved, give a recommendation and ask focused questions before implementing an alternative; do not defer the decision until other parts have been built and broadly verified.
3. **Define acceptance.** Agree on observable success and the public interface or characterization seam that will prove it. For refactoring, state which behavior must remain unchanged.
4. **Choose the verification plan.** Identify the fast development command, affected coverage, and final required checks using the [verification guide](verification.md). Note known baseline failures without silently accepting new ones.
5. **Record decisions before code.** Follow the repository's spec convention: update PRODUCT first, then TECH when planning is useful. If behavior or scope changes mid-work, revise the spec before continuing implementation.

Keep this checkpoint brief. An already clear and approved request needs a concise plan, not another approval ceremony. Ask only about unresolved decisions that affect the work.

## Rejected-edit recovery

1. **Stop after the first rejection.** Do not resend a large replacement or guess at whitespace. A rejected edit is diagnostic feedback, not a reason to rewrite the file.
2. **Inspect the current target.** Reread the small region from disk. Check whether the proposed old text matches exactly once, whether the file changed since the earlier read, and whether edit regions overlap. Inspect line endings and Unicode/encoding differences if matching remains unclear; do not normalize the whole file.
3. **Make one corrected retry.** Use the smallest unique replacement. Merge overlapping or adjacent changes into one edit; keep genuinely separate changes disjoint in the same call. Base every match on the current original file, not on the result of another entry in that call.
4. **If that retry fails, change approach.** Re-localize the change using smaller, unambiguous anchors and fresh source, or report the tool/encoding blocker if a safe exact match cannot be established. Do not repeat the same failing strategy, use a broad rewrite as a workaround, or overwrite unrelated work.
5. **Verify the result.** Inspect the targeted diff and run the narrowest relevant check from the [verification guide](verification.md). A successful tool response does not prove the intended behavior changed.

These are recovery instructions, not a new edit engine or permission to bypass tool validation. Use the existing exact-match editing tool; use full-file writes only for new files or genuinely intended complete rewrites.
