# /loop

## Outcome

A prompt can be repeated on an interval without a goal. `/loop 5m check the deploy` re-sends that prompt every five minutes until `/loop stop`, or until an optional deadline passes.

## Evidence

Goals are the right shape for work with an objective, tasks, and an audit. Watching something — a deploy, a queue, a flaky test, an inbox — has none of that: the user wants the same prompt asked again on a cadence, with no plan, no ledger, and no completion judgement. Today that means typing the prompt again by hand, or creating a Sisyphus goal whose machinery does not fit.

## Behaviour

### Starting a loop

- `/loop <interval> [<deadline>|--until <deadline>] [<prompt>]`.
- Durations are a number and a unit: `ms`, `s`, `m`, `h`, `d`, up to `7d`. The interval may not exceed the deadline.
- Only the token directly after the interval is read as a deadline; everything after it is the prompt.
- With no prompt, the loop repeats the last user message of the session, ignoring `/loop` commands themselves. With no prompt and no such message, the command says so and starts nothing.
- The prompt is sent immediately, then on the interval.
- Starting a loop while one is running replaces it.

### Pacing

- The next send is scheduled from the moment the agent settles, not from the moment the prompt was sent, so a run that outlasts the interval never overlaps the run after it.
- A loop started while the agent is busy waits for it to settle and sends then.
- A send that lands past the deadline is not made: the loop stops instead, and says it finished at its deadline.

### Stopping

- `/loop stop` (or `/loop cancel`) stops the loop and says so. With no loop running, it says there is none.
- Session shutdown stops the loop.
- A failed send stops the loop and reports the error.

### Status

- While a loop runs, the status line shows `loop: every <interval>[ for <deadline>] - /loop stop`. It clears when the loop stops.

### Relationship to goals

- `/loop` owns no goal state and writes nothing to `.pi/`. It is available whether or not a goal is focused, and a running goal continues to drive its own continuations; the loop only adds user prompts when the session is idle.
- Delegated goal sessions (workers) do not register it, as they register no commands.
