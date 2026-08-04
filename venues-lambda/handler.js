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
const https = require('https');
const jwt = require('jsonwebtoken');

// Keep-alive agent: SDK v2 opens a new TLS connection per DynamoDB call by
// default; reusing connections saves ~10-50ms per call on busy handlers.
const keepAliveAgent = new https.Agent({ keepAlive: true });
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2', httpOptions: { agent: keepAliveAgent } });
const lambda = new AWS.Lambda({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });

// JWT Secret - cached after first retrieval
let JWT_SECRET = null;

/**
 * Get JWT secret from SSM Parameter Store with fallback to env var
 */
async function getJWTSecret() {
  if (JWT_SECRET) {
    return JWT_SECRET;
  }

  try {
    const result = await ssm.getParameter({
      Name: '/bndy/auth/jwt-secret',
      WithDecryption: true
    }).promise();
    JWT_SECRET = result.Parameter.Value;
    console.log('[VENUES] JWT_SECRET loaded from SSM');
    return JWT_SECRET;
  } catch (error) {
    console.error('[VENUES] Failed to get JWT_SECRET from SSM:', error.message);
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      console.log('[VENUES] JWT_SECRET loaded from environment variable (fallback)');
      return JWT_SECRET;
    }
    throw new Error('JWT_SECRET not available from SSM or environment');
  }
}

/**
 * Parse cookies from event
 */
const parseCookies = (cookieHeader) => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, value] = cookie.trim().split('=');
    cookies[name] = value;
    return cookies;
  }, {});
};

/**
 * Authentication middleware
 */
const requireAuth = async (event) => {
  let sessionToken = null;

  if (event.cookies && Array.isArray(event.cookies)) {
    const cookieString = event.cookies.find(c => c.startsWith('bndy_session='));
    if (cookieString) {
      sessionToken = cookieString.split('=')[1];
    }
  } else {
    const cookies = parseCookies(event.headers?.Cookie || event.headers?.cookie || '');
    sessionToken = cookies.bndy_session;
  }

  if (!sessionToken) {
    return { error: 'Not authenticated' };
  }

  try {
    const jwtSecret = await getJWTSecret();
    const session = jwt.verify(sessionToken, jwtSecret);

    // Fetch user to check platformAdmin flag
    const userResult = await dynamodb.get({
      TableName: 'bndy-users',
      Key: { cognito_id: session.userId }
    }).promise();

    const platformAdmin = userResult.Item?.platformAdmin || false;

    return {
      user: {
        ...session,
        platformAdmin
      }
    };
  } catch (error) {
    console.error('[VENUES] Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

/**
 * Require platform admin authentication
 * Returns { user } on success, { error, statusCode } on failure
 */
const requirePlatformAdmin = async (event) => {
  const authResult = await requireAuth(event);
  if (authResult.error) {
    return { error: authResult.error, statusCode: 401 };
  }

  if (!authResult.user.platformAdmin) {
    return { error: 'Platform admin access required', statusCode: 403 };
  }

  return authResult;
};

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
    'https://gigmap.bndy.co.uk',
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

      // SEC-XX: Require platformAdmin for venue deletion (godmode only)
      const authResult = await requirePlatformAdmin(event);
      if (authResult.error) {
        return {
          statusCode: authResult.statusCode || 401,
          headers: getCorsHeaders(event),
          body: JSON.stringify({ error: authResult.error })
        };
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
