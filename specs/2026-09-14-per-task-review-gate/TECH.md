# Technical plan

Capture a task-start immutable git state with `git stash create` when possible, retaining the existing HEAD fallback. At completion, derive a complete diff including staged, unstaged, and untracked paths relative to that state, and pass the bounded patch plus file list to the reviewer. Persist each verdict as a task review ledger event and derive dashboard activity from that event. Integration tests must exercise the public task tool with a mocked reviewer and reload the ledger/dashboard from disk.
