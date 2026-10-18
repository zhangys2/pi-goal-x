# Worker integration safety

Worker patches still require an attached branch, an existing commit, a started task, and a clean working tree (goal/subagent runtime state excepted).

Integrations acquire an exclusive repository-wide lock in the common Git directory, `goal-x-integration.lock/`. A second integration fails fast with the lock path; it does not queue or apply anything. This coordinates goal-x integrations across processes and worktrees, not editors or arbitrary Git commands. Avoid changing the branch or editing integration paths until the operation finishes.

Git runs asynchronously with a 60-second timeout and a 64 MiB output bound. Cancellation stops the Git process tree, including hooks, and declared checks receive the same cancellation. Cancellation is checked before patch application and immediately before requesting a commit. A commit that already landed cannot be made not to have happened; an ambiguous Git failure explicitly tells you to inspect HEAD before retrying.

The patch is read once, so path inspection and application use identical bytes. Patches over 64 MiB, unsafe paths, symlinked parent directories, goal/subagent runtime paths, and new paths that already exist as untracked or ignored files are rejected. Commits name only the patch's paths, never unrelated staged work.

## Conservative recovery

After application, goal-x snapshots the patch paths' contents and index entries. Failed checks, failed commits, conflicts, and cancellation trigger bounded recovery without the cancelled operation signal. Recovery restores paths only when their ownership snapshot still matches and HEAD and the branch have not moved.

A check, hook, editor, or another process may change those paths. Such changes are deliberately preserved and listed as `leftover` paths instead of being overwritten. Recovery failures are listed too. Changes outside the patch are never automatically removed. Inspect the named paths before retrying; do not use `git reset --hard` or `git clean` to guess which changes belong to the integration.

A killed Git process may leave Git-owned lock files. Goal-x does not delete unknown Git locks. Resolve them only after confirming no Git process still owns them.

The integration lock is normally removed in `finally`. A crash may leave `goal-x-integration.lock/` behind. Its `owner.json` records the process id. Confirm that owner is no longer running and no integration is in progress before explicitly removing that exact directory. Locks are not automatically expired by age, because verification may legitimately take a long time.
