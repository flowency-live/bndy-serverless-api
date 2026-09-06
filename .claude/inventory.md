# Decision Inventory - bndy-serverless-api

> Living ledger of agent decisions. Auto-appended by `C:\VSProjects\.claude\hooks\pre-write-guardian.js` when a write is blocked. Manually appended by the agent for non-trivial choices below the ADR threshold.
>
> **Status lifecycle:** `pending` -> `validated` (kept; promote to ADR if pattern repeats) | `invalidated` (reverted; root cause documented).
>
> **Promote to ADR when:** the same decision recurs, the change crosses a port/adapter boundary, or the change requires a charter amendment. Use the `adr` skill.

| Date | Decided By | Decision | File(s) | Status | Notes / ADR |
|------|-----------|----------|---------|--------|-------------|
| 06/09/2026 | Jason (owner ruling), drafted by Claude | Charter `owns` glob corrected from `lambda/**` to `*-lambda/**`; the old glob matched no code directory, so the guardian would have blocked every lambda write once it fired | .claude/agent-charter.yaml | validated | Charter amendment, own PR ahead of the venue-rules work; no ADR |
