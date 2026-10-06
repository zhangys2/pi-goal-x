# Extension boundary hardening

## Scope and order

Implement the user's selected improvements in order: (1) end-to-end cancellation, (2) safe worker patch integration, (3) auditor isolation/trust boundaries, then (5) surgical maintenance refactoring. Windows CI (#4), unrelated features, and a broad rewrite are excluded.

## Accepted behavior

1. Tool and active-turn cancellation reach completion auditors, task reviewers, and blocker advisers. Cancellation never approves/completes a goal or task, never opens the Escape audit-bypass dialog, and releases audit resources even on exceptions. Explicit Escape remains a separate user-owned bypass workflow.
2. Integration checks cancellation before applying a patch and before committing. Git subprocesses are bounded and cancellable; integrations sharing a repository serialize across processes. Failed/cancelled integrations restore only integration-owned changes and must not silently discard concurrent edits.
3. User selected B: retain the current auditor workspace and tool profile. Document explicitly that the separate conversation/resource loader is not a filesystem or OS sandbox, bash is unrestricted, and the non-mutating policy is instructions rather than enforcement. Describe verification-command side effects, inherited credentials/permissions, extra-workspace guidance, and opt-in project-resource loading without adding settings or confirmation dialogs.
5. Refactor only boundaries touched by this work, preserving observable behavior and avoiding speculative configuration or unrelated file changes. Extract ownership of completion-audit progress, cancellation, animation, result-card timers, and cleanup from the shared core/completion/event modules into one small runtime. Preserve the existing core accessors and explicit Escape behavior. Leave settings and questionnaire modules unchanged.

## Verification

Use focused public-interface regression tests first, followed by typecheck, lint, and the full test suite. Record failures and remaining platform limitations honestly. No dependencies installed or release requested. After implementation, the user requested committing the completed session work and opening a PR against the origin fork's main branch.
