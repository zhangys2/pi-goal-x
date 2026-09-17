# Technical plan

Everything lives in `extensions/goal-project-config.ts`.

## Detection

- `git rev-parse --show-prefix` both detects a repository and gives the project prefix.
- `git check-ignore --no-index --stdin` receives one sample path per runtime entry (for example `.pi/goals/goal_events.jsonl`), so directory patterns such as `.pi/` match. `--no-index` keeps tracked files from hiding a rule. Exit status 1 (nothing ignored) is treated as an empty set.
- `.pi/settings.json` counts as subagent config when it parses and has a `subagents` key; `.pi/agents/*.md` are listed.

## Writing

- `.gitignore` is at `git rev-parse --show-toplevel`; the exclude file is `git rev-parse --git-path info/exclude`, which also resolves inside linked worktrees.
- Rules are appended under a `# pi-goal-x runtime state` header, adding a newline first when the file lacks a trailing one.

## Offer

`offerProjectOrchestrationSetup(core, ctx)` is awaited before `core.replaceGoal` in the `propose_goal_draft` confirmation path and in `handleDirectGoalSet`, which became async (its command handlers await it). `replaceGoal` stays synchronous for existing callers and tests. The dialog uses `ctx.ui.select` inside `enterGoalModal`/`exitGoalModal`. A module-level set of `<gitignore path>|<prefix>` keys limits it to once per session.

## Worktree default

The existing `tool_call` handler in `goal-events.ts` calls `defaultWorkerWorktree(event.input, ctx.cwd)` for `subagent` when the focused goal is active. Pi documents `event.input` as mutable before execution. Worker detection matches `agent: '<name>'` in `workflowScript` and `agent` fields in `tasks`. The builtin names are hardcoded because pi-subagents agent frontmatter has no worktree setting.

## Tests

- `tests/goal-project-config.test.ts`: covers non-repo detection, existing config and ignore detection, prefix-anchored `.gitignore` rules, each dialog choice (including dismissal), headless and once-per-repo behaviour, and the worktree default on clean, `.pi-subagents`-only, and dirty trees, with explicit values and read-only agents.
- `tests/e2e/goal-lifecycle-dashboard.test.ts`: `/goal-direct` in a repository asks before creating and still creates the goal on skip; the `tool_call` hook leaves launches alone without a goal and isolates workers while one is active.
