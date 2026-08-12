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
const crypto = require('crypto');
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
 * Timing-safe string comparison to prevent timing attacks on token verification.
 */
const timingSafeCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Authentication middleware
 */
const requireAuth = async (event) => {
  // Service credential for unattended MCP/agent writes. Cookie auth stays the
  // primary path; this is an additional accepted credential, not a bypass.
  const bearer = event.headers?.Authorization || event.headers?.authorization || '';
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : null;
  const serviceToken = process.env.MCP_SERVICE_TOKEN;

  // Only accept service token if MCP_SERVICE_TOKEN is configured (non-empty)
  if (token && serviceToken && timingSafeCompare(token, serviceToken)) {
    return { user: { userId: 'mcp-service', platformAdmin: true, isService: true } };
  }

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

/**
 * Require MCP service token authentication
 * SEC-AUD-004: MCP DELETE routes now require Bearer token auth, not unauthenticated access
 * Returns { user } on success, { error, statusCode } on failure
 */
const requireMcpAuth = (event) => {
  const bearer = event.headers?.Authorization || event.headers?.authorization || '';
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : null;
  const serviceToken = process.env.MCP_SERVICE_TOKEN;

  // MCP_SERVICE_TOKEN must be configured
  if (!serviceToken) {
    console.error('[SEC-AUD-004] MCP_SERVICE_TOKEN not configured');
    return { error: 'MCP service not configured', statusCode: 500 };
  }

  // Require Bearer token
  if (!token) {
    return { error: 'MCP service token required', statusCode: 401 };
  }

  // Validate service token
  if (!timingSafeCompare(token, serviceToken)) {
    return { error: 'Invalid MCP service token', statusCode: 401 };
  }

  return { user: { userId: 'mcp-service', platformAdmin: true, isService: true } };
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
  handleEnrichVenue,
  handleAuditVenueAdmission,
  handleEnrichmentAction
} = require('./handlers/venues-routes');

// Deduplication handlers
const {
  handleFindOrCreateVenue,
  handleIntegrationCreateVenue
} = require('./lib/venue-deduplication');

// Curator handlers (backlog feature 4)
const {
  handleCuratorUpdateVenue,
  handleCuratorHideVenue,
  handleCuratorRestoreVenue
} = require('./handlers/curator');

// Places proxy handlers (B1: community gig wizard)
const {
  handlePlacesSuggest,
  handlePlacesDetails
} = require('./handlers/places');

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
 * CORS is now handled by API Gateway CorsConfiguration in template.yaml
 * Lambda should NOT set Access-Control-Allow-Origin to avoid conflicts
 */
function getCorsHeaders(event) {
  return {
    'Content-Type': 'application/json'
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
    // Places proxy routes (B1: community gig wizard - no auth required, WAF rate-limited)
    // SEC-COMMUNITY: Also handles /api/community/places/* (public wizard namespace)
    if (method === 'GET' && (path === '/api/places/suggest' || path === '/api/community/places/autocomplete')) {
      return await handlePlacesSuggest(deps, event);
    }

    if (method === 'GET' && (path === '/api/places/details' || path === '/api/community/places/details')) {
      return await handlePlacesDetails(deps, event);
    }

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

    // RUNBOOK §0.23: Venue admission audit - requires platform admin
    if (method === 'GET' && path === '/api/venues/audit/admission') {
      const authResult = await requirePlatformAdmin(event);
      if (authResult.error) {
        return {
          statusCode: authResult.statusCode || 401,
          headers: getCorsHeaders(event),
          body: JSON.stringify({ error: authResult.error })
        };
      }
      return await handleAuditVenueAdmission(deps, event);
    }

    // SEC-COMMUNITY: Public wizard namespace (no auth, WAF rate-limited)
    if (method === 'POST' && path === '/api/community/venues/find-or-create') {
      return await handleFindOrCreateVenue(deps, parseBody(event.body), event);
    }

    if (method === 'POST' && path === '/api/venues/find-or-create') {
      // SEC-04: Require authentication for find-or-create
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return {
          statusCode: 401,
          headers: getCorsHeaders(event),
          body: JSON.stringify({ error: authResult.error })
        };
      }
      return await handleFindOrCreateVenue(deps, parseBody(event.body), event);
    }

    if (method === 'POST' && path === '/api/integration/venues') {
      // SEC-04: Require authentication for integration endpoint
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return {
          statusCode: 401,
          headers: getCorsHeaders(event),
          body: JSON.stringify({ error: authResult.error })
        };
      }
      return await handleIntegrationCreateVenue(deps, parseBody(event.body), event);
    }

    if (method === 'GET' && event.pathParameters?.id) {
      // Feature 4: godmode can read a hidden venue with ?includeHidden=1 + platform admin
      if (event.queryStringParameters?.includeHidden === '1') {
        const adminCheck = await requirePlatformAdmin(event);
        if (!adminCheck.error) event.__allowHidden = true;
      }
      return await handleGetVenueById(deps, event.pathParameters.id, event);
    }

    // Curator routes (backlog feature 4) — role gate lives inside the handlers
    if (method === 'PUT' && path.startsWith('/api/curator/venues/')) {
      return await handleCuratorUpdateVenue(deps, event);
    }
    if (method === 'POST' && path.startsWith('/api/curator/venues/') && path.endsWith('/hide')) {
      return await handleCuratorHideVenue(deps, event);
    }
    if (method === 'POST' && path.startsWith('/api/curator/venues/') && path.endsWith('/restore')) {
      return await handleCuratorRestoreVenue(deps, event);
    }

    if (method === 'POST' && path === '/api/venues') {
      // SEC-04: Require authentication for venue creation
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return {
          statusCode: 401,
          headers: getCorsHeaders(event),
          body: JSON.stringify({ error: authResult.error })
        };
      }
      return await handleCreateVenue(deps, parseBody(event.body), event);
    }

    if (method === 'PUT' && event.pathParameters?.id) {
      // MCP routes bypass auth (machine-to-machine)
      if (!path.includes('/mcp')) {
        // SEC-04: Require authentication for venue updates (non-MCP)
        const authResult = await requireAuth(event);
        if (authResult.error) {
          return {
            statusCode: 401,
            headers: getCorsHeaders(event),
            body: JSON.stringify({ error: authResult.error })
          };
        }
      }
      return await handleUpdateVenue(deps, event.pathParameters.id, parseBody(event.body), event);
    }

    // Enrichment action endpoint (2026-08-11) - accept/reject enrichment suggestions
    if (method === 'PATCH' && event.pathParameters?.id && path.endsWith('/enrichment')) {
      // Require platform admin for enrichment actions
      const authResult = await requirePlatformAdmin(event);
      if (authResult.error) {
        return {
          statusCode: authResult.statusCode || 401,
          headers: getCorsHeaders(event),
          body: JSON.stringify({ error: authResult.error })
        };
      }
      return await handleEnrichmentAction(deps, event.pathParameters.id, parseBody(event.body), event);
    }

    if (method === 'POST' && event.pathParameters?.id && path.includes('/enrich')) {
      // MCP routes bypass auth (machine-to-machine)
      if (!path.includes('/mcp')) {
        // SEC-04: Require authentication for venue enrichment (non-MCP)
        const authResult = await requireAuth(event);
        if (authResult.error) {
          return {
            statusCode: 401,
            headers: getCorsHeaders(event),
            body: JSON.stringify({ error: authResult.error })
          };
        }
      }
      return await handleEnrichVenue(deps, event.pathParameters.id, parseBody(event.body), event);
    }

    if (method === 'DELETE' && event.pathParameters?.id) {
      // SEC-AUD-004: MCP delete now requires service token auth
      if (path.includes('/mcp')) {
        const mcpAuth = requireMcpAuth(event);
        if (mcpAuth.error) {
          return {
            statusCode: mcpAuth.statusCode || 401,
            headers: getCorsHeaders(event),
            body: JSON.stringify({ error: mcpAuth.error })
          };
        }
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
