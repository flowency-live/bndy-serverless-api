---
type: task-brief
for: VSCode agent
owner: Claude (CTO stream), on behalf of Jason
created: 2026-08-11
scope: bndy-serverless-api only
items: F3 (postcode backfill), F4 (address validation at write)
---

# TASK: venue postcode backfill (F3) and address validation (F4)

You own these two backlog items. You touch ONLY `C:\VSProjects\bndy-serverless-api`.
Do not touch `bndy-app`, `bndy-backstage`, or `bndy-frontstage`. A second stream works there now.

## Why

The venue guard reads the `postcode` field. The field is empty on 2,471 of 2,500 venues.
The postcode sits inside the `address` string instead. The guard then falls back to
name comparison. That fault rejected 48 correct gigs.

## Hard rules

1. Do not run any import. Imports are Jason-only.
2. Do not run any enum or region compliance sweep. Read RUNBOOK §0 rules if unsure.
3. Never overwrite a non-empty `postcode` field.
4. Never change `address`, `name`, or any other field. F3 writes `postcode` only.
5. All data writes need a dry-run report and Jason's approval first. See the gate below.
6. Do not deploy. Prepare and test. Jason deploys with SAM.
7. Work on a branch: `fix/f3-f4-venue-postcode`.

## F3 — backfill `postcode` on existing venues

Table: `bndy-venues` (DynamoDB, eu-west-2). Key code lives in `venues-lambda/`.

Steps:

1. Write a script `scripts/f3-postcode-backfill.js` with two modes: `--dry-run` and `--apply`.
2. In dry-run mode, scan all venues. For each venue with an empty `postcode`:
   extract a UK postcode from `address` with a full UK postcode regex.
   Normalize: uppercase, one space before the final 3 characters.
3. Write the dry-run result to `scripts/f3-dry-run.csv` with columns:
   `venueId, name, address, currentPostcode, extractedPostcode`.
   Include a summary count: matched, no-postcode-in-address, already-filled.
4. **STOP. Report the dry-run in the progress log. Jason approves before `--apply` runs.**
5. In apply mode, update `postcode` only, only where the field was empty.
6. Report final counts and list every venue where no postcode was found.

## F4 — refuse a bad address at write time

"Derby, UK" is a live venue today. That must not happen again.

Rule to implement: a new venue must have a UK postcode. Accept it from the
`postcode` field, or extract it from `address`. If neither holds one, return
HTTP 422 with body `{ "error": "Venue address needs a postcode. Add the full address." }`.

Where:

1. `venues-lambda/handlers/venues-routes.js` → `handleFindOrCreateVenue`.
   This serves `/api/venues/find-or-create` and `/api/community/venues/find-or-create` (the public wizard).
2. `handleIntegrationCreateVenue` (`/api/integration/venues`).
3. Venue edit: refuse an edit that empties an existing `postcode`.

Also: when a create request has the postcode only inside `address`, extract it
and store it in the `postcode` field. New writes must not recreate the F3 debt.

Check first: the public wizard creates venues from Google Places details.
Confirm the wizard payload carries a postcode. If it does not, extraction from
`address` must cover it. If neither covers it, STOP and report — do not guess.

Match-only calls to find-or-create (an existing venue is found, nothing is created)
must not be blocked by the new rule.

## Tests

1. Unit tests for the postcode extractor: full UK formats, lowercase input, no postcode, two postcodes (take the last).
2. Unit tests for F4: create without postcode → 422; create with postcode in address → stored in field; edit that removes postcode → 422; find (match, no create) without postcode → passes.
3. Follow the existing test pattern in the repo (see `users-lambda/__tests__/`).
4. Run the full existing test suite. Report any failure that exists before your change separately from failures you cause. You must cause none.

## Progress log — how you report to the CTO

Append entries to the section below in THIS file. One entry per work session or event.
Format: `- [timestamp] STATUS: one or two short sentences.`
Statuses: STARTED, PROGRESS, BLOCKED, AWAITING-APPROVAL, DONE.

STOP and write BLOCKED when:
- the wizard payload has no postcode and address extraction cannot cover it
- the scan finds a schema surprise (postcode stored elsewhere, mixed types)
- any existing test fails after your change
- anything needs a data write beyond `postcode`

## Progress log

- (agent appends here)
