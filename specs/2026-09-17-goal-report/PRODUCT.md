# Goal report

## Outcome

Every goal keeps one Markdown report that answers, without reading a transcript: what the plan was, where it is now, what each task cost, what reviews and tests said, where time was lost, and what should change. It is readable outside the terminal and stays current while the goal runs.

## Why

Reconstructing the barter-rs sessions took a transcript parser and several hours. The facts that mattered were all recorded in the ledger and the goal file, but nowhere assembled: that w5 had been rejected 11 times, that six tasks were open at once, that the goal had sat in `wait` for 16 hours, that the auditor and the executor were running different commands. The dashboard shows the present moment in a terminal widget; the ledger is machine-readable. Neither is a document a person reads or shares.

## Sections

The report is one file per goal, sections in this order.

1. **Header** — objective, goal id, status with elapsed time in that status, auto-continue, auditor on/off, verification contract, created/updated times, report generation time.
2. **Plan (initial task DAG)** — Mermaid flowchart of the task tree as confirmed, parent to child, with each node's id and title. A second edge style marks declared order where the plan is ordered (Sisyphus). This is the plan as accepted; it does not change as work proceeds, so drift is visible against the next section.
3. **Current state (flowchart)** — the same graph with status styling: complete, in progress (started, unresolved), pending, skipped, rejected-and-retrying, blocked. One node per task, so the two graphs are comparable side by side.
4. **Tasks table** — id, title, status, attempts (review rejections), started, finished, wall-clock duration, tokens, cost. Cost and tokens are marked approximate when they are derived rather than measured (see below).
5. **Reviews and verification** — per task: each review verdict with its date, the reviewer's findings (bounded), and the skip reason when a review was skipped. Plus the goal-level audit history, each audit with verdict and findings. Test and command results are **quoted** from completion evidence and review reports; the report never runs commands itself, so an unverified claim stays visibly a claim.
6. **Attention and lost time** — blocks, pauses, waits and stalls with their reason, suggested action, and how long the goal spent in each. This is the section that would have surfaced the 16-hour wait.
7. **Scope** — per task, the files changed since its baseline, and any path the task's contract declared out of scope that changed anyway.
8. **Subagent artifacts** — entries in `.pi-subagents/artifacts` whose modification time falls inside the goal's window, with their paths, so child handoffs remain findable after the fact. Labelled as observed artifacts, not tracked runs: this extension has no link to pi-subagents and cannot claim which run belongs to which task. Omitted when the directory is absent.
9. **Timeline** — the goal's ledger events in order, one line each.
10. **Recommendations** — generated from the report's own data, not from prose. Each names the task and the evidence that produced it:
    - a task rejected three or more times (the only numeric threshold in the report, matching the blocking cap);
    - a task that ran while another code task was open;
    - a task whose changed files exceed its declared scope;
    - a wait that expired without its signal;
    - a task completed without a recorded verification command.

    No cost-outlier rule: token attribution per task is approximate (see below), so a "much more expensive than the others" rule would fire on an artefact of the estimate.

## Behaviour

- One report per goal, written to `.pi/goals/reports/`. Naming follows the goal file, so a report is traceable to its goal, and it is archived with the goal on completion. There is no cross-goal index; `/goal-list` already enumerates goals.
- The report is regenerated when goal state changes in a way the report shows: task transitions, review outcomes, audits, block/pause/resume, wait declaration and expiry, task-list changes. Not on every turn and not on a timer.
- `/goal-report` regenerates on demand and prints the path. With no focused goal it reports the most recent goal.
- The report is derived state: deleting it loses nothing, and the next regeneration recreates it in full from the ledger and the goal file.
- Regeneration never fails a goal operation. A write error is notified once and the goal continues.
- Sections with no data are omitted, so an early report is short rather than full of empty headings.
- `disableGoalReport: true` turns it off. `goalReportPath` overrides the directory.

## Cost and tokens

- Goal-level tokens and active time are measured today and reported as such.
- Per-task attribution does not exist yet. It requires a token snapshot on task transitions; until that lands, per-task figures are marked approximate and derived from the snapshots that do exist, or left blank.
- Currency cost needs a price table. Without configured pricing, the cost column is omitted rather than guessed.

## Non-goals

- Not a replacement for the dashboard (live, in-terminal) or the ledger (machine-readable, append-only).
- Not a project deliverable: it is agent runtime state, written where runtime state goes, not into the repository tree.
- No charts beyond Mermaid text, and no HTML.
