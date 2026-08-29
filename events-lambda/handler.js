/**
 * BNDY Events Lambda - Router
 *
 * Routes: /api/events, /api/artists/:artistId/events, /api/artists/:artistId/calendar
 *
 * Architecture: Router-only entry point (~150 lines)
 * - MCP handlers: handlers/mcp.js
 * - Public handlers: handlers/public.js
 * - Availability handlers: handlers/availability.js
 * - Integration handlers: handlers/integration.js
 * - CRUD handlers: handlers/crud.js
 * - Calendar handlers: handlers/calendar.js
 * - Auth utilities: lib/auth.js
 * - CORS utilities: lib/cors.js
 * - Event data utilities: lib/event-data.js
 * - Geohash utilities: lib/geohash.js
 * - Notifications: lib/notifications.js
 * - Calendar tokens: calendar-tokens.js
 * - Calendar cancellations: calendar-cancellations.js
 * - iCal generator: ical-generator.js
 */

const AWS = require('aws-sdk');
const https = require('https');
// Keep-alive agent: SDK v2 opens a new TLS connection per DynamoDB call by
// default; reusing connections saves ~10-50ms per call on busy handlers.
const keepAliveAgent = new https.Agent({ keepAlive: true });
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2', httpOptions: { agent: keepAliveAgent } });
const ssm = new AWS.SSM({ region: 'eu-west-2' });
const lambda = new AWS.Lambda({ region: 'eu-west-2' });

// Auth
const { requireAuth, requireMcpAuth } = require('./lib/auth');

// CORS
const { getCorsHeaders } = require('./lib/cors');

// MCP handlers (SEC-AUD-004: DELETE now requires service token auth)
const { handleGetEventByExternalId, handleUpdateEventMcp, handleDeleteEventMcp, handleGetEventMcp, handleLeaveEvent } = require('./handlers/mcp');

// Public handlers (NO AUTH for most)
const { handleCheckConflicts, handleGetPublicEventsGeo, handleBatchEventsWithJoins, handleGetVenueEvents, handleGetAllPublicEvents, handleGetArtistPublicEvents, handleCreatePublicGig, handleCreateCommunityEvent } = require('./handlers/public');

// Availability handlers (mixed auth)
const { handleGetArtistAvailability, handleGetManagedArtistAvailability, handleToggleAvailability, handleBulkAvailability } = require('./handlers/availability');

// Integration handlers (API key auth)
const { handleIntegrationFindOrCreateEvent } = require('./handlers/integration');

// CRUD handlers (AUTH required)
const { handleCreateArtistEvent, handleCreateUserUnavailability, handleGetEvent, handleUpdateEvent, handleDeleteEvent } = require('./handlers/crud');

// Calendar handlers (mixed auth)
const { handleGetCalendar, handleGetAllArtistEvents, handleCreateCalendarSubscription, handleGetCalendarSubscriptions, handleRevokeCalendarSubscription, handleGetIcalFeed, handleGetEventIcal } = require('./handlers/calendar');

// Curator handlers (backlog feature 4) — role gate lives inside the handlers
const { handleCuratorUpdateEvent, handleCuratorHideEvent, handleCuratorRestoreEvent, handleCuratorCancelEvent, handleCuratorUncancelEvent, handleCuratorFestivalTag } = require('./handlers/curator');

// Dependency injection object for handlers
const deps = { dynamodb, ssm, lambda, getCorsHeaders };

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  // HTTP API v2 compatibility
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;

  console.log('EVENTS: Request received', { method, path, pathParameters: event.pathParameters });

  // OPTIONS for CORS
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: getCorsHeaders(event), body: '' };
  }

  try {
    const routeKey = `${method} ${path}`;

    // ========================================
    // PUBLIC ROUTES (NO AUTH REQUIRED)
    // ========================================

    if (routeKey.match(/GET \/api\/events\/by-external-id/)) {
      return await handleGetEventByExternalId(deps, event);
    }

    if (routeKey.match(/GET \/api\/events\/public\/geo/)) {
      return await handleGetPublicEventsGeo(deps, event);
    }

    if (routeKey.match(/GET \/api\/events\/public$/)) {
      return await handleGetAllPublicEvents(deps, event);
    }

    if (routeKey.match(/GET \/api\/artists\/[^/]+\/public-events/)) {
      return await handleGetArtistPublicEvents(deps, event);
    }

    if (routeKey.match(/GET \/api\/artists\/[^/]+\/public-availability/)) {
      return await handleGetArtistAvailability(deps, event);
    }

    if (routeKey.match(/POST \/api\/events\/batch/)) {
      return await handleBatchEventsWithJoins(deps, event);
    }

    if (routeKey.match(/GET \/api\/venues\/[^/]+\/events/)) {
      return await handleGetVenueEvents(deps, event);
    }

    if (routeKey.match(/^POST \/api\/events\/community\/mcp$/)) {
      const mcpAuth = requireMcpAuth(deps, event);
      if (mcpAuth.statusCode) return mcpAuth;
      event.__allowScopedIngestion = true;
      return await handleCreateCommunityEvent(deps, event);
    }

    // SEC-COMMUNITY: Also handles /api/community/events (public wizard namespace)
    if (routeKey.match(/POST \/api\/events\/community/) || routeKey.match(/POST \/api\/community\/events$/)) {
      return await handleCreateCommunityEvent(deps, event);
    }

    if (routeKey.match(/POST \/api\/integration\/events$/)) {
      return await handleIntegrationFindOrCreateEvent(deps, event);
    }

    // SEC-AUD-005: MCP PUT now requires service token auth (was public, fixed 2026-08-12)
    if (routeKey.match(/PUT \/api\/events\/[^/]+\/mcp$/)) {
      const mcpAuth = requireMcpAuth(deps, event);
      if (mcpAuth.statusCode) return mcpAuth;
      return await handleUpdateEventMcp(deps, event);
    }

    // Curator routes (backlog feature 4)
    // festival-tag is a literal segment - matched before the {id} patterns.
    if (routeKey.match(/^POST \/api\/curator\/events\/festival-tag$/)) {
      return await handleCuratorFestivalTag(deps, event);
    }
    if (routeKey.match(/^PUT \/api\/curator\/events\/[^/]+$/)) {
      return await handleCuratorUpdateEvent(deps, event);
    }
    if (routeKey.match(/^POST \/api\/curator\/events\/[^/]+\/hide$/)) {
      return await handleCuratorHideEvent(deps, event);
    }
    if (routeKey.match(/^POST \/api\/curator\/events\/[^/]+\/restore$/)) {
      return await handleCuratorRestoreEvent(deps, event);
    }
    if (routeKey.match(/^POST \/api\/curator\/events\/[^/]+\/cancel$/)) {
      return await handleCuratorCancelEvent(deps, event);
    }
    if (routeKey.match(/^POST \/api\/curator\/events\/[^/]+\/uncancel$/)) {
      return await handleCuratorUncancelEvent(deps, event);
    }

    if (routeKey.match(/GET \/api\/events\/[^/]+\/mcp$/)) {
      return await handleGetEventMcp(deps, event);
    }

    // SEC-AUD-004: MCP DELETE now requires service token auth
    if (routeKey.match(/DELETE \/api\/events\/[^/]+\/mcp$/)) {
      const mcpAuth = requireMcpAuth(deps, event);
      if (mcpAuth.statusCode) return mcpAuth;
      return await handleDeleteEventMcp(deps, event);
    }

    if (routeKey.match(/POST \/api\/artists\/[^/]+\/events\/check-conflicts/)) {
      return await handleCheckConflicts(deps, event);
    }

    if (routeKey.match(/GET \/api\/calendar\/ical\/[^/]+$/)) {
      return await handleGetIcalFeed(deps, event);
    }

    // ========================================
    // AUTHENTICATED ROUTES
    // ========================================

    const authResult = await requireAuth(deps, event);
    if (authResult.statusCode === 401) {
      return authResult;
    }
    const { user } = authResult;

    // Calendar sync routes (must come BEFORE generic /calendar route)
    if (routeKey.match(/POST \/api\/artists\/[^/]+\/calendar\/subscribe$/)) {
      return await handleCreateCalendarSubscription(deps, event, user);
    }

    if (routeKey.match(/GET \/api\/artists\/[^/]+\/calendar\/subscriptions$/)) {
      return await handleGetCalendarSubscriptions(deps, event, user);
    }

    if (routeKey.match(/DELETE \/api\/artists\/[^/]+\/calendar\/subscriptions\/[^/]+$/)) {
      return await handleRevokeCalendarSubscription(deps, event, user);
    }

    if (routeKey.match(/GET \/api\/artists\/[^/]+\/events\/[^/]+\/ical$/)) {
      return await handleGetEventIcal(deps, event, user);
    }

    // Calendar view (GENERIC - must come AFTER specific calendar routes)
    if (routeKey.match(/GET \/api\/artists\/[^/]+\/calendar$/)) {
      return await handleGetCalendar(deps, event, user);
    }

    // Get all artist events (no date filter)
    if (routeKey.match(/GET \/api\/artists\/[^/]+\/events$/) && !path.includes('/check-conflicts')) {
      return await handleGetAllArtistEvents(deps, event, user);
    }

    // Availability
    if (routeKey.match(/GET \/api\/artists\/[^/]+\/availability$/)) {
      return await handleGetManagedArtistAvailability(deps, event, user);
    }

    if (routeKey.match(/POST \/api\/artists\/[^/]+\/events\/toggle-availability/)) {
      return await handleToggleAvailability(deps, event, user);
    }

    if (routeKey.match(/POST \/api\/artists\/[^/]+\/events\/bulk-availability/)) {
      return await handleBulkAvailability(deps, event, user);
    }

    // Create artist event
    if (routeKey.match(/POST \/api\/artists\/[^/]+\/events$/) && !path.includes('/user') && !path.includes('/toggle-availability') && !path.includes('/bulk-availability')) {
      return await handleCreateArtistEvent(deps, event, user);
    }

    // Create user unavailability (artist-agnostic)
    if (routeKey.match(/POST \/api\/users\/me\/unavailability/)) {
      return await handleCreateUserUnavailability(deps, event, user);
    }

    // Get single event
    if (routeKey.match(/GET \/api\/artists\/[^/]+\/events\/[^/]+$/) && !path.includes('/check-conflicts')) {
      return await handleGetEvent(deps, event, user);
    }

    // Update event
    if (routeKey.match(/PUT \/api\/artists\/[^/]+\/events\/[^/]+/)) {
      return await handleUpdateEvent(deps, event, user);
    }

    // Leave event (multi-artist support)
    if (routeKey.match(/POST \/api\/artists\/[^/]+\/events\/[^/]+\/leave/)) {
      return await handleLeaveEvent(deps, event);
    }

    // Delete event
    if (routeKey.match(/DELETE \/api\/artists\/[^/]+\/events\/[^/]+/)) {
      return await handleDeleteEvent(deps, event, user);
    }

    // Create public gig
    if (routeKey.match(/POST \/api\/artists\/[^/]+\/public-gigs/)) {
      return await handleCreatePublicGig(deps, event, user);
    }

    return {
      statusCode: 404,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Route not found', routeKey })
    };

  } catch (error) {
    console.error('EVENTS: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: error.message })
    };
  }
};
