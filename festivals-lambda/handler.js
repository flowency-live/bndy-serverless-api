/**
 * Festivals Lambda - Main router
 * Per spec: festival-mcp-write-api-spec.md §1
 */

const {
  handleCreateFestival,
  handleUpdateFestival,
  handleSearchFestivals,
  handleGetFestivalByExternalId
} = require('./handlers/crud');
const {
  handleGetPublicFestivals,
  handleGetFestivalBySlug
} = require('./handlers/public-v1');
const {
  handleCuratorCreateFestival,
  handleCuratorGetFestival,
  handleCuratorUpdateFestival
} = require('./handlers/curator');

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient();
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
    console.log('[FESTIVALS] JWT_SECRET loaded from SSM');
    return JWT_SECRET;
  } catch (error) {
    console.error('[FESTIVALS] Failed to get JWT_SECRET from SSM:', error.message);
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      console.log('[FESTIVALS] JWT_SECRET loaded from environment variable (fallback)');
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
 * Authentication middleware - SEC-04
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
    return { user: session };
  } catch (error) {
    console.error('[FESTIVALS] Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

/**
 * MCP service token gate - same pattern as venues-lambda groups.js
 * Staff by cookie, OR the MCP service token by Bearer header.
 */
const MCP_GATE = Object.freeze({
  user: { userId: 'mcp-service', platformAdmin: true, isService: true },
  role: 'staff'
});

function isMcpService(event) {
  const header = event.headers?.Authorization || event.headers?.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  const serviceToken = process.env.MCP_SERVICE_TOKEN;
  if (!token || !serviceToken) return false;
  if (token.length !== serviceToken.length) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(serviceToken);
  return crypto.timingSafeEqual(a, b);
}

async function requireStaffOrMcp(event) {
  if (isMcpService(event)) {
    console.log('[FESTIVALS] MCP service token accepted');
    return MCP_GATE;
  }
  return requireAuth(event);
}

// CORS is now handled by API Gateway CorsConfiguration in template.yaml
function getCorsHeaders(event) {
  return {
    'Content-Type': 'application/json'
  };
}

exports.handler = async (event) => {
  console.log('FESTIVALS: Request received', {
    routeKey: event.routeKey,
    path: event.rawPath,
    method: event.requestContext?.http?.method
  });

  // ssm is required by the curator routes' requireRole (curator-core).
  const deps = { dynamodb, getCorsHeaders, ssm };
  const routeKey = event.routeKey || `${event.httpMethod} ${event.path}`;

  // Handle OPTIONS (CORS preflight)
  if (routeKey.match(/OPTIONS /)) {
    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: ''
    };
  }

  try {
    // Curator routes (festival curator builder; role gated inside the handlers)
    if (routeKey.match(/^POST \/api\/curator\/festivals$/)) {
      return await handleCuratorCreateFestival(deps, event);
    }
    if (routeKey.match(/^GET \/api\/curator\/festivals\/[^/]+$/)) {
      return await handleCuratorGetFestival(deps, event);
    }
    if (routeKey.match(/^PATCH \/api\/curator\/festivals\/[^/]+$/)) {
      return await handleCuratorUpdateFestival(deps, event);
    }

    // Route matching
    // POST /festivals - Create festival
    if (routeKey.match(/POST \/festivals$/)) {
      // SEC-04: Staff cookie OR MCP service token
      const authResult = await requireStaffOrMcp(event);
      if (authResult.error) {
        return {
          statusCode: 401,
          headers: getCorsHeaders(event),
          body: JSON.stringify({ error: authResult.error })
        };
      }
      return await handleCreateFestival(deps, event);
    }

    // PATCH /festivals/{id} - Update festival
    if (routeKey.match(/PATCH \/festivals\/[^/]+$/)) {
      // SEC-04: Staff cookie OR MCP service token
      const authResult = await requireStaffOrMcp(event);
      if (authResult.error) {
        return {
          statusCode: 401,
          headers: getCorsHeaders(event),
          body: JSON.stringify({ error: authResult.error })
        };
      }
      return await handleUpdateFestival(deps, event);
    }

    // GET /festivals - Search festivals
    if (routeKey.match(/GET \/festivals$/)) {
      return await handleSearchFestivals(deps, event);
    }

    // GET /api/festivals/public - Public festivals list
    if (routeKey.match(/GET \/api\/festivals\/public$/)) {
      return await handleGetPublicFestivals(deps, event);
    }

    // GET /api/festivals/by-external-id - idempotent import lookup (#97b)
    if (routeKey.match(/GET \/api\/festivals\/by-external-id/)) {
      return await handleGetFestivalByExternalId(deps, event);
    }

    // GET /api/festivals/slug/{slug} - Get by slug
    if (routeKey.match(/GET \/api\/festivals\/slug\/[^/]+$/)) {
      return await handleGetFestivalBySlug(deps, event);
    }

    // No matching route
    console.log('FESTIVALS: No matching route', { routeKey });
    return {
      statusCode: 404,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Not found' })
    };
  } catch (error) {
    console.error('FESTIVALS: Unhandled error', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
