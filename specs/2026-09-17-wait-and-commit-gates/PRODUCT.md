# Wait and commit gates

## Outcome

A goal that needs the user asks the user instead of parking itself, and a goal never commits work the user had in progress without asking.

## Evidence

Session `01a0b0d2` (2026-09-17, barter-rs, 22 minutes):

- The build could not run because global `CC`/`AR` point to MinGW for an MSVC target. The agent declared `update_goal` wait with a deadline of 20:00Z, and after the user asked for status, declared another wait until the next day at 12:00Z. Nothing about that condition resolves without the user, so the goal was parked ~16 hours and never asked.
- The agent ran `git add -A && git commit -m "chore: checkpoint in-progress spec improvements"`, committing 45 files and +3088/−272 of the user's in-progress roadmap work as one unreviewable commit on a docs branch. Its own scout then reported the tree as clean, with no dirty changes to preserve.

## Behaviour

### Waits declare what they wait on

- A new `wait` continuation requires `depends_on`: `"producer"` for an external condition that resolves on its own, or `"user"`.
- `depends_on: "user"` is rejected, naming `update_goal({status: "blocked", reason})` as the correct call. A rejected wait changes no state, so the goal stays active and the agent can block in the next call.
- A missing `depends_on` on a new wait is rejected with the same explanation.
- Re-declaring an existing wait by `wait_id` keeps its stored dependency and needs no `depends_on`.
- The active-goal prompt states that a blocker only the user can clear is blocked immediately, never waited on.

### Pre-existing work is not swept into a commit

- Applies while the focused goal is active and the goal has a review baseline.
- A command is guarded when it stages or commits everything (`git commit -a`/`--all`, or `git add -A`/`--all`/`.`/`:/` combined with a commit). Commits that name paths are not guarded.
- Pre-existing paths are those modified or untracked when the baseline was taken that are still dirty now. Goal runtime state is excluded, as it is for task reviews.
- When such paths exist, the command is blocked once per goal with the count, up to twelve names, and the instruction to ask the user and stop the turn.
- The next user-initiated run clears the gate, so an approved commit proceeds on retry.
- A goal that started from a clean tree is never affected.
