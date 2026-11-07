---
status: resolved
blocked_by: []
claimed_by: none
type: Grilling (HITL)
---

# Goal recovery

## Question
Where and how should users recover interrupted work: (A) one `/goal` recovery view with per-goal next actions, (B) recovery actions embedded in the dashboard, or (C) another surface? Specify which states it covers (blocked, paused, persisted waiting, interrupted checkpoints) and whether actions may mutate state directly or only explain commands. Label a goal stale only when durable state proves it, never based on age or inactivity.

## Resolution
Use one read-only recovery view listing paused, blocked/awaiting-user-action, persisted waiting, and interrupted-checkpoint goals with suggested next actions. Label a goal stale only when durable state proves it, never based on age or inactivity. User agreed.
