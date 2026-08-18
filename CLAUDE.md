---
name: bndy-house-style
description: Jason's output rules for every bndy reply and document. Use for ALL chat replies, reports, specs, commit messages and handovers in the bndy project. Triggers on any bndy work, and on any request to write, review, plan, report, audit or explain.
---

# bndy house style

Apply to every reply. Not optional. Not only when asked.

## Reply shape

1. Answer first. State the outcome in one line.
2. Then facts, as a table or a numbered list.
3. Stop.

Hard limits per reply:

- 150 words maximum, unless Jason asks for detail.
- No section headings unless the reply has 3 or more distinct topics.
- No bold "signpost" sentences that restate what follows.
- No closing summary. No "next steps" unless asked.
- No restating what Jason just said back to him.

## Language

ASD-STE100. Full standard: `STE-STYLE.md` in bndy-population.

1. One idea per sentence. 25 words maximum.
2. Active voice. Present tense.
3. No metaphor, idiom, or figurative language.
4. Condition first: "If the lock is free, claim it."
5. Warning before the step it applies to.

## Banned

| Banned | Instead |
|---|---|
| Em-dash in ANY rendered UI string | A full stop or a comma |
| Narrating what you are about to do | Do it |
| "Here is what I found" / "Three things stand out" | The finding |
| Explaining why a fix was clever | The fix |
| Reporting effort or process | The result |
| "genuinely", "honestly", "straightforward" | Nothing |

## Data is never restyled

Never rewrite a bio, an artist name, a venue name, an event title, a captured
source row, a quotation of Jason, or a tool error string. They are evidence.

## Before sending

1. Delete every sentence that does not carry a fact or a decision.
2. Delete every heading with one item under it.
3. Read the first line. It must answer the question on its own.

## Never ask Jason for data the system already defines

A default that exists in the runbook or in code IS the answer. Do not ask for it.
Do not invent a value when you cannot find it. Read it.

| Field | Default | Where it lives |
|---|---|---|
| Event start time | Fri/Sat 21:00, Sun 19:00, other weekdays 20:00, afternoon 14:00 | RUNBOOK 5.6. Code: `defaultStartTime()` in `lib/event-defaults.js` and `src/utils/event-defaults.ts` |
| Event end time | 00:00 (midnight) | `DEFAULT_END_TIME` |
| isPublic on an imported gig | true | RUNBOOK 2A step 2 |

`create_event` does NOT require `startTime`. Omit the field when the source states
no time. The server applies RUNBOOK 5.6 and returns `startTimeDefaulted: true`.
List every defaulted time in the run report so Jason can correct it.

If a tool demands a value you do not have:

1. Look for the default in code, then in RUNBOOK.md.
2. Apply it.
3. Flag it as defaulted in the run report.
4. Raise the missing default as a build item.

Asking Jason for a start time is a defect. Guessing one is a worse defect.
Stopping a run because a time is missing is also a defect.
