# Executed task checks

## Outcome

A task can name the commands that prove it is done. goal-x runs them itself when the task is completed, and the task stays pending until they pass. Reviewers and the completion auditor receive the real results instead of the executor's claim.

## Evidence

The task review gate and the completion auditor both judge completion evidence written by the executor ("quoted as claims rather than re-run"). A reviewer that wants certainty must re-run the command itself, which costs a model turn and may not happen. pi-orchestrator (HenryQW/pi-harness, ADR 019) treats directly executed checks as authoritative and reserves model judgment for criteria commands cannot decide.

## Behaviour

### Declaring checks

- `set_goal_tasks` accepts `checks` on any task: up to 8 entries of `{ command, args?, timeout_seconds? }`.
- `command` is one executable name or path. `args` is an array of arguments. There is no shell: no pipes, globs, redirection, `&&`, or variable expansion. Write `{ "command": "bash", "args": ["-lc", "…"] }` when a shell is needed.
- `timeout_seconds` defaults to 600 and is capped at 3600.
- Checks are structural, like `verification_contract`: re-setting the task list replaces them, and omitting them clears them.

### Running checks

- Checks run when the task is completed (`update_goal_task` status `complete`, single or batch), after the existing completion validation (already complete, missing evidence, unfinished subtasks) and before the code review.
- They run in the project directory, in declared order, and stop at the first failure.
- A check fails when it exits non-zero, cannot start, is killed by a signal, times out, or is aborted. A timed-out or aborted check is killed with its process tree.
- On Windows, commands resolve through `PATH` and `PATHEXT`, so `npm` and `npx` work. `.cmd` and `.bat` files run through `cmd.exe` with their arguments escaped, never through a shell string built from unescaped input.
- Checks run even when task reviews are skipped or disabled: they are deterministic and cost no model call.

### Failing checks

- The task stays pending. No review starts.
- The tool result names the failing command, its exit code (or timeout, signal, start error), and the last 4,000 characters of its combined output.
- The failure is recorded in the ledger as a `task_checks` event with `passed: false`.
- A failure caused by the environment (missing toolchain, credentials, network) should be reported as a blocker to the user rather than retried; the tool result says so.

### Passing checks

- The results (command, arguments, exit code, duration) are stored on the task and recorded as a `task_checks` event with `passed: true`, written together with the completion so a completion that does not commit leaves no pass behind.
- The code reviewer receives the results as facts it does not need to re-run.
- The completion auditor sees each task's check results beside its evidence, labelled as run by goal-x.
- The dashboard activity feed and the goal report show both outcomes. The report's `unverified_completion` recommendation does not fire for a task whose checks passed.

## Non-goals

- No goal-level checks. The goal's verification contract stays a checklist for the auditor.
- No environment variables per check. Use `env`, `bash -lc`, or `wsl` as the command.
- No retry cap for failing checks: the autonomous run allowance already bounds retries.
