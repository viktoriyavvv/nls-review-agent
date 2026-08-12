---
id: global-review-principles
type: global_rule
status: approved
confidence: high
appliesTo:
  projects: []
  repos: []
  tags:
    - review
    - process
createdAt: 2026-07-02T10:16:42.695Z
updatedAt: 2026-07-02T10:16:42.695Z
---

# Global review principles

## Rules

- Do not treat a developer response as a fix without code evidence.
- Separate blocker, risk, minor, and question.
- If API contract is unclear, ask for clarification instead of guessing.
- Do not block on style-only issues unless they create a real maintenance or regression risk.
- In followup review, verify delta from previous HEAD to current HEAD.
- If a task returns as bugfix after review, analyze the missed pattern.
