/**
 * BNDY Venues Lambda - Router
 *
 * Routes: /api/venues, /api/venues/:id, /api/venues/find-or-create, /api/integration/venues
 *
 * Architecture: Router-only entry point (~100 lines)
 * - Route handlers: handlers/venues-routes.js
 * - Deduplication logic: lib/venue-deduplication.js
 * - Fuzzy matching: lib/fuzzy-matcher.js
 * - Geohash utilities: lib/geohash.js
 * - Google Places API: lib/google-places.js
 * - External IDs: lib/external-ids.js
 */

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const lambda = new AWS.Lambda({ region: 'eu-west-2' });

// Route handlers
const {
  handleGetAllVenues,
  handleListVenuesMcp,
  handleGetVenueById,
  handleGetVenueByExternalId,
  handleCreateVenue,
  handleUpdateVenue,
  handleDeleteVenue,
  handleMCPDeleteVenue,
  handleEnrichVenue
} = require('./handlers/venues-routes');

// Deduplication handlers
const {
  handleFindOrCreateVenue,
  handleIntegrationCreateVenue
} = require('./lib/venue-deduplication');

/**
 * Safe JSON parse helper - handles both string and object body
 */
function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'object') return body;

  console.log('[Venues Lambda] Parsing body, type:', typeof body, 'length:', body.length);
  console.log('[Venues Lambda] Body preview:', body.substring(0, 200));

  try {
    const parsed = JSON.parse(body);
    console.log('[Venues Lambda] Parsed successfully, keys:', Object.keys(parsed));
    return parsed;
  } catch (error) {
    console.error('[ERROR] JSON parse failed:', error.message);
    console.error('[ERROR] Body that failed to parse:', body);
    throw new Error('Invalid JSON in request body');
  }
}

/**
 * CORS headers for API responses
 */
function getCorsHeaders(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin;
  const allowedOrigins = [
    'https://www.bndy.co.uk',
    'https://backstage.bndy.co.uk',
    'https://bndy.co.uk',
    'https://live.bndy.co.uk',
    'http://localhost:3000'
  ];

  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie,x-api-key',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Credentials': 'true'
  };
}

// Dependency injection object for handlers
const deps = { dynamodb, lambda, getCorsHeaders };

exports.handler = async (event, context) => {
  // HTTP API v2 payload format compatibility
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;

  console.log('[Venues Lambda] Request received', {
    method,
    path,
    pathParameters: event.pathParameters,
    bodyType: typeof event.body,
    bodyLength: event.body ? event.body.length : 0
  });

  context.callbackWaitsForEmptyEventLoop = false;

  try {
    // Route requests
    if (method === 'GET' && path === '/api/venues') {
      return await handleGetAllVenues(deps, event);
    }

    if (method === 'GET' && path === '/api/venues/by-external-id') {
      return await handleGetVenueByExternalId(deps, event);
    }

    if (method === 'GET' && path === '/api/venues/list') {
      return await handleListVenuesMcp(deps, event);
    }

    if (method === 'POST' && path === '/api/venues/find-or-create') {
      return await handleFindOrCreateVenue(deps, parseBody(event.body), event);
    }

    if (method === 'POST' && path === '/api/integration/venues') {
      return await handleIntegrationCreateVenue(deps, parseBody(event.body), event);
    }

    if (method === 'GET' && event.pathParameters?.id) {
      return await handleGetVenueById(deps, event.pathParameters.id, event);
    }

    if (method === 'POST' && path === '/api/venues') {
      return await handleCreateVenue(deps, parseBody(event.body), event);
    }

    if (method === 'PUT' && event.pathParameters?.id) {
      return await handleUpdateVenue(deps, event.pathParameters.id, parseBody(event.body), event);
    }

    if (method === 'POST' && event.pathParameters?.id && path.includes('/enrich')) {
      return await handleEnrichVenue(deps, event.pathParameters.id, parseBody(event.body), event);
    }

    if (method === 'DELETE' && event.pathParameters?.id) {
      if (path.includes('/mcp')) {
        return await handleMCPDeleteVenue(deps, event.pathParameters.id, event);
      }
      return await handleDeleteVenue(deps, event.pathParameters.id, event);
    }

    return {
      statusCode: 404,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Route not found', method, path })
    };

  } catch (error) {
    console.error('[ERROR] Venues Lambda: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
