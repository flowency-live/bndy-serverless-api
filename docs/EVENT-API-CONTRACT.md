# Canonical Event Mutation Contract (WP-05A)

**Date:** 20 August 2026
**Verified against:** `events-lambda` at commit 98a0cb5
**Consumer:** `bndy-enrichment` projection engine (BUILD-PLAN WP-05)
**Auth for service calls:** `Authorization: Bearer <MCP_SERVICE_TOKEN>` (secret `bndy/mcp-service`, timing-safe compare, SEC-AUD-004 pattern)

## 1. Route table

| Operation | Route | Auth | Handler |
|---|---|---|---|
| Create | `POST /api/events/community` (alias `POST /api/community/events`) | none (public wizard namespace) | `public.js handleCreateCommunityEvent` |
| Find-or-create | `POST /api/integration/events` | `x-api-key` (INTEGRATION_API_KEYS) | `integration.js` |
| Read by id | `GET /api/events/{id}/mcp` | none | `mcp.js handleGetEventMcp` |
| Read by external id | `GET /api/events/by-external-id?source=&id=` | none | `mcp.js handleGetEventByExternalId` (full table scan, use sparingly) |
| Update | `PUT /api/events/{id}/mcp` | MCP bearer | `mcp.js handleUpdateEventMcp` |
| Delete | `DELETE /api/events/{id}/mcp` | MCP bearer | `mcp.js handleDeleteEventMcp` |
| Cancel | `POST /api/curator/events/{id}/cancel` | cookie curator/staff OR MCP bearer (WP-05A) | `curator.js` |
| Uncancel | `POST /api/curator/events/{id}/uncancel` | cookie curator/staff OR MCP bearer (WP-05A) | `curator.js` |
| Hide | `POST /api/curator/events/{id}/hide` | cookie curator/staff OR MCP bearer (WP-05A) | `curator.js` |
| Restore | `POST /api/curator/events/{id}/restore` | cookie staff OR MCP bearer (WP-05A) | `curator.js` |

The four lifecycle routes run on `EventsCuratorFunction` (same codebase, template route split). `MCP_SERVICE_TOKEN` is already in its environment. A presented Bearer token must be valid; a bad bearer is 401 and never falls through to the cookie path.

## 2. Create: `POST /api/events/community`

Request (JSON): `venueId`, `date`, `startTime` REQUIRED (callers apply the RUNBOOK 5.6 default and set `startTimeDefaulted: true`). `artistId` or `artistIds[]` or `isOpenMic: true` required. Optional: `endTime` (default 00:00), `title` (generated `Artist @ Venue` if absent), `isPublic` (default true), `source`, `externalIds[] ({source, id})`, `price`, `eventUrl`, `ticketed`, `ticketInformation`, `ticketUrl`, `imageUrl`, `description`, `notes`, festival fields (`festivalId`, `festivalName`, `stageId`, `billing`, `billingOrder`).

Responses:

| Status | Meaning | Body |
|---|---|---|
| 201 | Created, persistence verified by ConsistentRead read-back inside the handler | `{message, id, event: {id, title, date, startTime, artistId, artistIds, artistNames, venueId}}` |
| 409 | Duplicate by externalId | `{error, message, existingEventId, existingEventTitle, existingDate, existingStartTime, matchedExternalId}` |
| 409 | Duplicate by artist+venue+date (advisory check or hard sentinel gate) | `{error, message, existingEventId, ...}` |
| 400 | Missing venueId/date/startTime or no artist and not open mic | `{error}` |
| 404 | Venue or artist not found | `{error}` |

`source: "mcp_ai_import"` additionally sets `aiCreated: true, needsReview: true`.

## 3. Update: `PUT /api/events/{id}/mcp`

Allowed fields: `title, date, startTime, endTime, artistId (alias artist_id), venueId, description, isPublic, isOpenMic, ticketed, ticketUrl, ticketinformation, price, imageUrl, eventUrl, notes, externalIds, collaboratingArtistIds, headlineArtistIds, festivalId, festivalName, stageId, billing, billingOrder`. `null` on `ticketed, price, ticketUrl, ticketinformation` REMOVES the attribute (tri-state).

Identity changes (artist, venue, date, bill) re-run the duplicate check and atomically re-key the uniqueness sentinels. Responses: 200 with the full updated record read back (includes `externalIds`, `venueName`); 404 unknown id; 400 no valid fields, TOO_MANY_ACTS (>4), INVALID_HEADLINERS; 409 `{error: 'Duplicate event', code: 'DUPLICATE', existingEventId}`.

## 4. Delete: `DELETE /api/events/{id}/mcp`

Deletes the record, releases the (venue|artist|date) sentinels, writes a best-effort calendar cancellation record. 200 `{message: 'Event deleted', id}`; 404 unknown id. Deletion is unconditional on any event. The projection engine writes its DynamoDB tombstone in the same operation (ADR-103); the API does not do that.

## 5. Cancel and lifecycle (WP-05A change)

`POST /api/curator/events/{id}/cancel` body `{reason?}` sets `cancelled: true, cancelled_by, cancelled_at, cancelled_reason`. 200 `{success, id, cancelled: true}`; 404 unknown id. Cancelled is PUBLIC information: the event stays visible as a ghosted row with a stamp (backlog feature 7, already in bndy-app), and public reads carry `cancelled: !!e.cancelled`. Uncancel reverses it. Hide sets `isPublic: false` + hidden metadata (leaves all public surfaces); restore reverses it. All four now accept the MCP bearer; the audit row records actor `MCP`.

## 6. Duplicate sentinel

Unchanged and verified: one sentinel per act, key `(venue|artist|date)`, hard gate on create (`putEventGated`), advisory check + atomic re-key on identity update, release on delete and on leave-event. Open mic events gate on an OPENMIC key. Gate mode `enforce` returns 409; the existing event id is always in the response.

## 7. Owner-managed protection

Events have no per-record owner lock today. Artist-created events (cookie + membership path, `crud.js`) carry `membershipId`; community/import events carry `createdByUserId: null`. The MCP routes can mutate ANY event. Owner protection for events is therefore a PROJECTION-LAYER duty: the WP-05 AuthorityPolicy must refuse source-driven mutation of events with `membershipId != null` or `verifiedByArtist: true` unless authority rules allow it. Flagged to BUILD-PLAN WP-05.

## 8. Read-back

Create verifies persistence internally (ConsistentRead). Update returns the re-fetched record. Delete and lifecycle ops return confirmations only: the projection engine reads back via `GET /api/events/{id}/mcp` (expect 404 after delete; `cancelled: true` after cancel).

## 9. Test coverage

| Contract point | Suite |
|---|---|
| Duplicate create 409, sentinel per act, bill rules | `event-dedup.test.js` |
| Delete releases sentinels | `__tests__/delete-releases-sentinels.test.js` |
| MCP bearer on PUT/DELETE /mcp | `multi-artist.test.js` (SEC-AUD-004 block) |
| Integration find-or-create + x-api-key | `integration.test.js` |
| Lifecycle routes accept MCP bearer, reject bad bearer, cookie path unchanged, audit actor MCP | `handlers/curator-mcp-gate.test.js` (new, WP-05A) |

Full suite: 19 suites, 220 tests, green (20 August 2026).

## 10. Capability gaps identified

1. CLOSED by this WP: no service-token path to cancel/uncancel/hide/restore. Now accepted on all four.
2. OPEN, deliberate: no owner-managed protection on events at the API layer (section 7). Owned by WP-05 AuthorityPolicy.
3. OPEN, noted: `GET /api/events/by-external-id` is a full table scan. Acceptable for occasional lookups; the projection engine should key on its own state, not this route, for bulk reconciliation.
