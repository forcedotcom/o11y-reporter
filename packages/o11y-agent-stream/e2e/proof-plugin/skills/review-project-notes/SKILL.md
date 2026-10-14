---
name: review-project-notes
description: Reviews sample project notes, records the planned next step, and returns a short summary.
---

# Review Project Notes

Use `Read` exactly once to inspect
`packages/o11y-agent-stream/e2e/sample-project-notes.md`. Select the next project
step from those notes. Then call `mcp__o11y__log_decision` exactly once with decision
type `PLAN`, a concise next-step description, and a concise rationale. Do not include
paths, note contents, or other user data in the decision. Finish with a brief summary
of the selected next step.
