/**
 * BNDY Recurring Sessions Lambda - Router
 *
 * Slice 1: GET routes only.
 * Slice 2: Godmode projection routes.
 * Slice 3: POST create route with Event materialisation.
 *
 * Routes:
 *   GET  /api/venues/{venueId}/recurring-sessions
 *   GET  /api/recurring-sessions/{id}
 *   GET  /api/recurring-sessions/search
 *   POST /api/recurring-sessions
 *   GET  /api/godmode/recurring-sessions
 *   GET  /api/godmode/recurring-sessions/{id}/projection
 */

const AWS = require('aws-sdk');
const https = require('https');

// Keep-alive for connection reuse
const keepAliveAgent = new https.Agent({ keepAlive: true });

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: 'eu-west-2',
  httpOptions: { agent: keepAliveAgent }
});

const { getCorsHeaders } = require('./lib/cors');
const {
  handleGetVenueRecurringSessions,
  handleGetRecurringSessionById,
  handleSearchRecurringSessions
} = require('./handlers/public');
const {
  handleGetProjection,
  handleListSessions
} = require('./handlers/godmode');
const {
  handleCreateRecurringSession
} = require('./handlers/mutations');

// Dependency injection for testability
const deps = { dynamodb, getCorsHeaders };

/**
 * Lambda handler
 * @param {Object} event - Lambda event
 * @param {Object} context - Lambda context
 * @returns {Promise<Object>} Lambda response
 */
exports.handler = async (event, context) => {
  // Don't wait for empty event loop (faster cold starts)
  context.callbackWaitsForEmptyEventLoop = false;

  // Extract HTTP method and path
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;

  console.log('RECURRING_SESSIONS: Request received', { method, path });

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: ''
    };
  }

  try {
    // Route matching
    const routeKey = `${method} ${path}`;

    // ========================================
    // PUBLIC READ ROUTES (Slice 1)
    // ========================================

    // GET /api/venues/{venueId}/recurring-sessions
    if (method === 'GET' && /^\/api\/venues\/[^/]+\/recurring-sessions$/.test(path)) {
      return await handleGetVenueRecurringSessions(deps, event);
    }

    // GET /api/recurring-sessions/search (must come before /{id} route)
    if (method === 'GET' && path === '/api/recurring-sessions/search') {
      return await handleSearchRecurringSessions(deps, event);
    }

    // GET /api/recurring-sessions/{id}
    if (method === 'GET' && /^\/api\/recurring-sessions\/[^/]+$/.test(path)) {
      return await handleGetRecurringSessionById(deps, event);
    }

    // ========================================
    // MUTATION ROUTES (Slice 3)
    // ========================================

    // POST /api/recurring-sessions
    if (method === 'POST' && path === '/api/recurring-sessions') {
      return await handleCreateRecurringSession(event);
    }

    // ========================================
    // GODMODE ROUTES (Slice 2)
    // ========================================

    // GET /api/godmode/recurring-sessions
    if (method === 'GET' && path === '/api/godmode/recurring-sessions') {
      return await handleListSessions(event);
    }

    // GET /api/godmode/recurring-sessions/{id}/projection
    if (method === 'GET' && /^\/api\/godmode\/recurring-sessions\/[^/]+\/projection$/.test(path)) {
      return await handleGetProjection(event);
    }

    // ========================================
    // No matching route
    // ========================================

    console.log('RECURRING_SESSIONS: No matching route', { routeKey });

    return {
      statusCode: 404,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        error: 'Route not found',
        path,
        method
      })
    };

  } catch (error) {
    console.error('RECURRING_SESSIONS: Unhandled error:', error);

    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        error: error.message || 'Internal server error'
      })
    };
  }
};
