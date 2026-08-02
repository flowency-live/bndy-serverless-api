# BNDY API Security and ChatGPT Integration Execution Plan

**Tracking issue:** #2  
**Repository:** `flowency-live/bndy-serverless-api`  
**Deployment owner:** Jason, using AWS SAM from the local repository  
**Last updated:** 2026-08-02

## Purpose

Secure the production API so that public consumers can only read approved data, Backstage godmode retains authenticated administration, and ChatGPT receives a separate constrained integration for safe artist, venue and later draft-gig creation and enrichment.

This document, issue #2 and the linked pull requests are the source of truth. Decisions must not exist only in chat.

## Fixed decisions

1. Public access is read-only.
2. No public frontend currently needs create, edit, enrich or delete access.
3. Backstage is the only web client requiring general mutation access.
4. Backstage administration uses the existing Google-backed BNDY session plus an explicit allowlist of individual Flowency email addresses. Domain suffix matching alone is not sufficient.
5. ChatGPT uses a separate integration identity and receives no delete, ownership, membership, user-role, validation-override, merge or arbitrary-update permission.
6. AI enrichment is additive and field-allowlisted. It must not clear or replace existing trusted values.
7. AI-created records are marked `ai_created=true`, `needs_review=true`, and `created_source=chatgpt`.
8. AI-created gigs initially remain draft or review-required and must be idempotent.
9. `flowency-live/bndy-MCP` is out of scope. It remains a local stdio MCP and is not modified by this programme.
10. Infrastructure and API Gateway changes are deployed with `sam validate`, `sam build` and `sam deploy` from Jason's local machine.
11. Every implementation PR includes automated tests, manual verification, deployment impact and rollback instructions.

## Trust zones

| Zone | Authentication | Permissions |
|---|---|---|
| Public API | None | Explicitly approved GET routes only |
| Backstage admin | Existing BNDY Google session plus exact admin allowlist | Full authorised administration |
| ChatGPT integration | Dedicated revocable bearer credential | Narrow AI search, find-or-create and additive enrichment |
| Claude MCP | Existing local stdio process and AWS credentials | Unchanged and out of scope |

## Target route policy

### Public

Only routes explicitly classified as `public-read` in `security/route-policy.json` may remain unauthenticated.

### Admin

Every existing `POST`, `PUT`, `PATCH` and `DELETE` route is admin-protected unless it is explicitly assigned to the AI integration. Legacy HTTP `/mcp` mutations must be protected or removed from API Gateway.

### AI integration

Planned constrained surface:

```text
GET  /api/ai/artists/search
POST /api/ai/artists/find-or-create
POST /api/ai/artists/{id}/enrich

GET  /api/ai/venues/search
POST /api/ai/venues/find-or-create
POST /api/ai/venues/{id}/enrich

GET  /api/ai/events/search
POST /api/ai/events/find-or-create
```

There will be no AI delete route and no generic AI update route.

## Delivery model

Each task has one branch and one draft pull request. A task is not complete because code is merged; production-impacting tasks become verified only after deployment smoke-test evidence is recorded in issue #2.

| Task | Objective | Branch | Status | PR | Tests | Deployed | Merge commit |
|---|---|---|---|---|---|---|---|
| SEC-00 | Baseline, route inventory, enduring plan | `agent/sec-00-route-inventory` | In progress | Pending | Pending | N/A | |
| SEC-01 | Route security regression test | `agent/sec-01-route-security-test` | Not started | | | No | |
| SEC-02 | Shared authorisation contracts | `agent/sec-02-auth-contracts` | Not started | | | No | |
| SEC-03 | Backstage admin authorizer | `agent/sec-03-admin-authorizer` | Not started | | | No | |
| SEC-04 | Lock down all production mutations | `agent/sec-04-lock-down-mutations` | Not started | | | No | |
| SEC-05 | ChatGPT integration authorizer | `agent/sec-05-chatgpt-authorizer` | Not started | | | No | |
| SEC-06 | AI artist search and find-or-create | `agent/sec-06-ai-artists` | Not started | | | No | |
| SEC-07 | AI artist additive enrichment | `agent/sec-07-ai-artist-enrichment` | Not started | | | No | |
| SEC-08 | AI venue search and find-or-create | `agent/sec-08-ai-venues` | Not started | | | No | |
| SEC-09 | AI venue additive enrichment | `agent/sec-09-ai-venue-enrichment` | Not started | | | No | |
| SEC-10 | Durable audit logging | `agent/sec-10-audit-logging` | Not started | | | No | |
| SEC-11 | AI event search and idempotent draft creation | `agent/sec-11-ai-events` | Not started | | | No | |
| SEC-12 | ChatGPT OpenAPI Action specification | `agent/sec-12-chatgpt-openapi` | Not started | | | No | |
| SEC-13 | Monitoring, throttling and incident controls | `agent/sec-13-operational-hardening` | Not started | | | No | |

Allowed statuses: `Not started`, `In progress`, `PR open`, `Ready to deploy`, `Deployed`, `Verified`, `Blocked`, `Superseded`.

## Task definitions

### SEC-00: Baseline and route inventory

- Generate a complete route inventory from `template.yaml`.
- Classify every route without changing runtime behaviour.
- Detect duplicate route declarations.
- Record current unauthenticated mutations as risks.
- Add the enduring plan, policy and analysis tooling.

### SEC-01: Route security regression test

- Fail CI when a mutation route has no approved authorizer.
- Fail when an unknown route is added without classification.
- Require all public routes to be explicitly allowlisted.

### SEC-02: Shared authorisation contracts

- Standardise actor context, 401 and 403 responses.
- Add constant-time secret comparison and sensitive-header redaction.
- Add reusable authenticated-event test helpers.

### SEC-03: Backstage admin authorizer

- Verify existing BNDY session JWT signature, expiry, issuer and audience where available.
- Load exact admin emails from encrypted AWS configuration.
- Fail closed on configuration or identity errors.
- Return the verified admin identity in authorizer context.

Recommended parameter: `/bndy/admin/allowed-emails`.

### SEC-04: Production mutation lock-down

- Attach admin authorisation to every existing mutation route.
- Disable or protect community writes.
- Protect or remove HTTP `/mcp` mutations.
- Keep approved public GET routes working.
- Include deployment, smoke-test and rollback scripts.

This is the first production-impacting milestone and takes priority over new AI functionality.

### SEC-05: ChatGPT integration authorizer

- Validate a dedicated revocable bearer credential.
- Support rotation and immediate disablement.
- Return only the permissions required by the AI routes.
- Never log secrets or accept credentials in query strings.

Recommended secret: `/bndy/integrations/chatgpt/api-key`.

### SEC-06 and SEC-07: AI artists

- Reuse existing matching and uniqueness gates.
- Find existing artists before creating.
- Require sufficient identity/location data.
- Allow only additive, field-allowlisted enrichment.
- Reject ownership, membership, validation and primary identity changes.

### SEC-08 and SEC-09: AI venues

- Reuse Google Place ID, deduplication ladder and uniqueness gate.
- Do not expose raw unrestricted create/update operations.
- Allow only additive, field-allowlisted enrichment.
- Reject primary name, Place ID, coordinates, ownership and validation changes.

### SEC-10: Audit logging

Record actor, operation, entity, request ID, changed fields, source attribution and outcome. Never store credentials, cookies or full authorisation headers.

### SEC-11: AI events

- Require valid artist and venue IDs.
- Support external IDs and `Idempotency-Key`.
- Detect duplicates using source ID and artist/venue/date/time identity.
- Create draft or review-required gigs only.
- Do not expose event edit or delete to ChatGPT.

### SEC-12: ChatGPT Action

Create an OpenAPI document exposing only approved `/api/ai/*` operations. Validate that no admin or delete route appears.

### SEC-13: Operational hardening

Add appropriate throttling, alarms, auth-failure monitoring, unusual mutation-volume detection, credential revocation and an incident runbook.

## Test policy

Tests are mandatory in the same PR as implementation. Depending on the task, include:

- Unit tests for validation, permissions, field allowlists and duplicate handling.
- SAM route-policy tests.
- Handler tests for unauthenticated, forbidden and permitted identities.
- Contract tests for request and response schemas.
- OpenAPI validation.
- Manual production smoke tests and rollback commands.

A future agent must not mark a test as executed unless it was actually run. Connector-only code changes may state that local execution remains required.

## Pull request standard

PR titles use `SEC-XX: Description`.

Every PR body includes:

- Task and security objective
- Scope and files changed
- Routes changed
- Tests added and tests actually executed
- SAM/CloudFormation impact
- Required AWS configuration
- Deployment steps
- Verification steps
- Rollback steps
- Known limitations
- Link to issue #2

## Handover protocol

At the end of each task, update this document and issue #2 with:

- Current status
- Branch and PR
- Decisions made
- Files changed
- Test results
- Deployment state
- Remaining risks
- Exact next task
- Final merge commit when available

A new agent should be able to continue using only this document, issue #2, linked PRs and repository code.

## Explicit non-goals

- Modifying `flowency-live/bndy-MCP`
- Changing Claude Cowork configuration
- Rebuilding Backstage
- Building the new public gig wizard
- Making community mutation routes public
- Automatic AI deletion or merging
- Direct DynamoDB access from ChatGPT
- General-purpose AI database access

## Immediate milestones

### Milestone 1: API locked down

- Public reads work.
- Every unauthenticated mutation returns 401.
- Valid non-admin sessions receive 403.
- Explicitly allowlisted Flowency accounts can administer through Backstage.
- No unauthenticated HTTP `/mcp` mutation remains.
- Claude MCP remains untouched.
- Tests prevent future unauthenticated mutations.

### Milestone 2: Safe ChatGPT artists and venues

- ChatGPT can find or create artists and venues.
- ChatGPT can add safe additive enrichment.
- ChatGPT cannot delete or arbitrarily update records.
- Every AI mutation is attributable and auditable.

### Milestone 3: Safe ChatGPT gigs

- ChatGPT can find or create draft gigs idempotently.
- Retries do not create duplicate events.
- The private GPT Action exposes only approved AI operations.
