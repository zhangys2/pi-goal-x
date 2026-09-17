<div align="center">
  <img src="pi-goal-x.png" alt="pi-goal-x logo" width="560">
</div>

<div align="center">
  <a href="https://pi.dev/packages?type=extension" target="_blank" rel="noopener noreferrer">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/badge-dark.svg">
      <img src="assets/badge-light.svg" alt="TOP 0.3% of Pi coding agent extensions: #7 of 3,200 by downloads · Sep 14, 2026 (best recorded rank)" width="480">
    </picture>
  </a>
</div>

# pi-goal-x

Adds `/goal` functionality to [pi](https://github.com/earendil-works/pi-coding-agent). The agent helps you define a goal and plan, continues working on it automatically, and submits the result to an optional independent completion auditor.

The extension saves goal objectives, tasks, and progress across sessions. You can pause, resume, revise, or switch goals as your work changes.

## Install

```bash
pi install npm:pi-goal-x
```

## Create a goal

```text
/goal Add CSV export to the reports page, with documentation and tests.
```

The agent discusses the goal with you, asks focused questions where needed, and proposes an objective, task plan, and completion requirements. You review the proposal and choose whether to use the completion auditor. Once you confirm, the agent starts working and continues automatically while the goal is active.

You can specify completion requirements, such as passing the test suite or producing a report with every required section. The agent tracks tasks and subtasks, records evidence, and works toward those requirements. If it gets blocked and needs your input, you can resolve the issue and resume.

If you already have a complete objective, use `/goal-direct <objective>` to create the goal and start immediately without drafting.

### Project setup check

goal-x never adds Pi configuration to a repository on its own. When a goal is created in a git repository, it reports any existing `.pi/settings.json` subagent settings and `.pi/agents/*.md` files. It also checks whether its runtime state (`.pi/goals/`, `.pi/.goals-pool-snapshot.json`, `.pi-subagents/`) is git-ignored. Untracked runtime state blocks subagent worktree isolation, which needs a clean working tree. It also clutters `git status`, and cleanup commands such as `git clean` can delete the active goal. If rules are missing, goal-x explains this and asks where to add them: `.git/info/exclude` (this machine only), `.gitignore` (shared), or nowhere. It asks once per repository per session. Without a UI, it only reports.

While a goal is active, the first command that would commit everything (`git add -A`, `git commit -a`) is blocked when it would include paths that were already modified or untracked when the goal started. The block names those paths so the agent asks you what to do with your own work. After you answer, the next run may proceed; commits that name their own paths are never blocked.

While a goal is active, `subagent` launches that run an implementation `worker` (or its aliases) default to `worktree: true` when the working tree is clean, so parallel workers do not share the parent's worktree. This needs no project files. An explicit `worktree` value is always kept.

## Goal types

| Type | Behaviour | Example uses |
| --- | --- | --- |
| **Regular** — `/goal` | An outcome to achieve, with the agent choosing and adapting the plan. | Features, debugging, research, and documentation. |
| **Sisyphus** — `/sisyphus` | An ordered plan that the agent follows one step at a time. | Migrations, staged refactors, and release procedures. |

For an ordered goal, you can provide the steps or define them with the agent:

```text
/sisyphus Migrate authentication in this order:
1. Add the new token validator.
2. Update login and session refresh to use it.
3. Remove the old validator.
4. Run the authentication tests.
```

Use `/sisyphus-direct <objective>` to start an ordered goal without drafting.

Sisyphus plans are intentionally ordered, but they are not immutable: if the
user changes the plan, use `/goal-tweak` and obtain confirmation before
replacing it. A skipped step must include a reason, and a skipped or completed
step can be reopened with `update_goal_task` when later evidence shows it is
needed again. Completion still requires every required step to be complete or
explicitly justified as skipped.

## Tasks and subtasks

The agent can divide a goal into tasks and subtasks, each describing part of the work required to complete it. During guided goal creation, you review the proposed plan before work begins.

For example, a CSV export goal could have this task plan:

```text
Add CSV export to reports
├─ Review the report data and active filters
├─ Implement CSV export
│  ├─ Generate the CSV from filtered results
│  └─ Add a download button
├─ Test the export
└─ Document how to use it
```

As work progresses, the agent marks the current task, records completed work, and explains any skipped tasks. The dashboard shows what is done and what remains, including progress within subtasks. Task progress is saved when you pause and remains available in later sessions.

Tasks can also have their own completion requirements—for example, “The download contains only rows matching the active filters.” The agent records evidence against those requirements, and the completion auditor uses that evidence when reviewing the overall result.

### Per-task code review gate

When a task is declared code-changing (`code_change: true` in `set_goal_tasks`),
`update_goal_task(status="complete")` runs a separate read-only code review first. The task
remains pending when the reviewer finds an issue, so the executor must resolve the findings and
retry completion. Set `code_change: false` for documentation, research, report, and planning
tasks. Tasks without the label are reviewed when their changed files include source code, and
also when their changes cannot be determined (no git repository), so the gate fails closed.
Completion evidence and prose filenames are never used for classification.

The review sees only the task's own changes: tracked, staged, and untracked files changed since
the task first started, or since the task list was set if it was never started. Restarting a
rejected task keeps its original baseline. An oversized diff is marked as truncated and lists every
changed file. Goal and subagent runtime state (`.pi/goals/`, `.pi/.goals-pool-snapshot.json`,
`.pi-subagents/`) is left out of the diff. Completion checks such as missing evidence run before
the review, so an invalid completion never starts one.

Code tasks run one at a time: a code task cannot start while another started code task is still
open, because both would share one worktree and each review would include the other's changes.
A retry review checks the previous review's findings against the task's verification contract. If
the same task is rejected three times in a row, the goal is blocked until you resume it with
`/goal-resume`, for example after narrowing the task, fixing the build environment, or revising the
contract.

Every decision is recorded in the ledger as a `task_review` event: approved (written with the
completion), rejected, failed, or skipped with its reason. The review uses the configured auditor
provider/model. Set `disableTaskReviews: true` in settings to skip this gate, or set
`taskReviewExcludedTypes` to a list of `review_type` values to skip selectively. These controls are
independent of the goal-level completion auditor unless the auditor itself is disabled, in which
case task reviews are skipped too.

Use `/goal-tweak <change>` to discuss revisions to the goal and its plan. Task tracking, completion requirements, and subtask depth are configurable in `/goal-settings`.

## Completion auditor

When enabled, a separate agent reviews the work before the goal is accepted as complete. It checks the objective, tasks, recorded evidence, completion requirements, and workspace. The goal's and tasks' completion requirements are its checklist; the objective explains what they mean.

If the auditor approves, the goal is archived as complete. If it identifies unmet requirements, the goal remains open with feedback describing the work still needed. The next review checks each earlier finding and reports whether it is fixed. You can choose the auditor model in `/goal-settings` and toggle auditing for the focused goal with `Ctrl+Shift+A`.

If the work spans more than the project directory, such as a second repository, or is verified somewhere the auditor cannot run commands directly, such as WSL, tell the auditor in the settings file. `auditorWorkspaces` lists extra directories it may inspect, and `auditorEnvironment` describes how to run verification:

```json
{
  "auditorWorkspaces": ["C:/Users/me/repos/second-repo"],
  "auditorEnvironment": "Builds and tests run in WSL: wsl -e bash -lc 'cd /mnt/c/Users/me/repos/project && ctest --test-dir build'"
}
```

The auditor treats both as guidance for where to look, never as evidence.

## Progress and goal controls

The dashboard above the editor shows the goal's status, task progress, current task, elapsed time, and token usage. Press `Ctrl+Shift+T` to expand it for the full task tree, completion requirements, evidence, and recent activity. Audit progress and results appear there too.

A project can have several open goals, with one focused goal per session. Switch with `/goal-focus`, pause with `/goal-pause`, or use `/goal-tweak` to discuss changes to the current goal. Pressing `Esc` during active work also pauses the goal; in the expanded dashboard, it collapses the view.

## Commands

| Command | What it does |
| --- | --- |
| `/goal [idea]` | Discuss, plan, and confirm a regular goal. |
| `/sisyphus [idea]` | Discuss, plan, and confirm an ordered goal. |
| `/goal-direct <objective>` | Create and start a regular goal immediately. |
| `/sisyphus-direct <objective>` | Create and start an ordered goal immediately. |
| `/goal-list` | List open goals. |
| `/goal-status` | Show the focused goal and its progress. |
| `/goal-focus` | Choose an open goal to work on. |
| `/goal-unfocus` | Leave the current goal open without focusing on it. |
| `/goal-tweak <change>` | Revise the current goal with the agent. |
| `/goal-pause` | Pause work on the focused goal. |
| `/goal-resume` | Resume a paused or blocked goal. |
| `/goal-clear` | Archive the focused goal after confirmation. |
| `/goal-cancel` | Cancel an unconfirmed draft. |
| `/goal-settings` | Configure goal behaviour and the auditor. |

For troubleshooting, use `/goal-status verbose` for more detail, `/goal-status health` or `/goal-recovery` to check for problems, and `/goal-refresh` to reload saved goals and settings after external changes. `/goal-recovery repair` offers repairs after confirmation.

## Settings

Open `/goal-settings` to change these options. You can save defaults for all projects, override them for the current project, or remove an override to use the inherited value.

| Setting | What it controls |
| --- | --- |
| Autonomous run allowance (`maxAutonomousRuns`) | Positive whole number of extension-started runs per creation or `/goal-resume` period. **Unset disables automatic continuation.** Settings edits change the limit without resetting usage. |
| Task tracking (`disableTasks`) | Turn task lists on or off. Set to `true` to disable them. |
| Subtask depth (`subtaskDepth`) | Limit how many levels of subtasks the agent can create. |
| Completion requirements (`disableContracts`) | Turn explicit goal and task completion requirements on or off. Set to `true` to disable them. |
| Auditor disabled | Turn off independent completion review. |
| Auditor provider, model, and thinking level | Choose which model reviews completed work and its reasoning effort. |
| Auditor workspaces and environment (`auditorWorkspaces`, `auditorEnvironment`) | Point the auditor at extra directories and explain how to run verification. Set in the settings file. |


### Explicit execution and waiting

Goals no longer restart merely because they remain unfinished or a tool was used. Before yielding, the agent declares runnable work or an external wait using `update_goal`, or reports complete, paused, or blocked. A missing decision permits one repair prompt within the remaining allowance, then pauses.

When a goal blocks, you are notified immediately with why it stopped, what the agent already tried, and what you can do about it, followed by `/goal-resume`, `/goal-tweak` and `/goal-clear`. The same details appear in the dashboard, and a blocked goal is restated when a session starts, so it cannot go unnoticed. Blocking therefore requires the agent to supply `suggested_action` addressed to you.

A new wait must say what it depends on. `depends_on: "producer"` is an external condition that resolves on its own, such as a remote build. `depends_on: "user"` is rejected: anything only you can do, such as installing a tool, supplying credentials, or making a decision, is a blocker, so the goal is blocked and asks you instead of parking itself until a deadline.

Waits are announced when declared, and one lasting longer than 30 minutes reminds you every 30 minutes with the time left and any remaining checks. The reminders only notify: no model turn runs and no autonomous allowance is spent. If the deadline passes without the expected signal, the goal pauses with the reason and the next step.

Set an appropriate allowance in `/goal-settings`, or in `.pi/pi-goal-x-settings.json`:

```json
{ "maxAutonomousRuns": 20 }
```

Agents may edit this setting. Changing it does not replenish consumed runs; explicit `/goal-resume` renews the period and continues now, including from a waiting goal. It requires a configured allowance. Tool calls within a run are not separate runs. Existing token budgets still apply.

```js
update_goal({ continuation: { kind: "ready", next_action: "Verify the build artifacts" } })
update_goal({ continuation: {
  kind: "wait", depends_on: "producer", reason: "Await the remote build",
  deadline: "2026-09-15T12:00:00Z",
  polling: { interval_seconds: 60, max_checks: 3 }
} })
```

Use a future deadline appropriate to the task. Omit `polling` for an event-only wait. Successful declarations terminate the execution segment. On a scheduled check, reuse the returned `wait_id` and original deadline, omitting `polling`; remaining checks cannot be reset. A ready decision ends the wait. Time spent waiting is not active execution time.

The dashboard, `/goal-status`, and `get_goal` show scheduling state, timing, checks, and allowance consumption. Expired waits and exhausted checks or allowance pause without another model call. Waits survive reopening the same session, without replaying missed checks; Pi must remain open for timers to execute. Another session requires explicit resume to take ownership. An ambiguous interrupted dispatch requires resume instead of automatic replay.

### Background producer integration

Budget-controlled producers emit a scheduler signal instead of starting their own model turn:

```js
pi.events.emit("pi-goal:wake", { goalId, waitToken });
```

`waitToken` is returned in the wait declaration's tool-result details. Register it before the producer completes, or retain the completion until registration (for example, observe the `update_goal` tool result in the host adapter). The token changes after consumption and re-declaration. A matching signal received before agent settlement is retained; duplicate, stale and wrong-goal tokens are ignored. A signal and timer can claim only one wake.

Existing producers that directly send `triggerTurn`/`followUp` messages still run as ordinary host work and supersede old pending decisions. Those independently started turns are **outside this extension's allowance**; use `pi-goal:wake` to put them through its spending gate. The allowance also does not limit Pi's own within-run tool loop or native retries. It bounds the goal extension's kickoff, continuation, check, signal, repair and recovery dispatches.

## Observability

For troubleshooting long-running goals, set `PI_GOAL_X_OBSERVABILITY=1` before
starting Pi. The extension then appends privacy-conscious JSONL events for
continuation scheduling, retries, focus changes, and auditor decisions to
`.pi/goals/debug/observability.jsonl`. Objectives, prompts, tool arguments, and
model output are intentionally excluded; telemetry failures never affect goal
execution.

## License

MIT
