/**
 * Festivals Lambda - Main router
 * Per spec: festival-mcp-write-api-spec.md §1
 */

const {
  handleCreateFestival,
  handleUpdateFestival,
  handleSearchFestivals,
  handleGetPublicFestivals,
  handleGetFestivalBySlug,
  handleGetFestivalByExternalId
} = require('./handlers/crud');

const AWS = require('aws-sdk');

const dynamodb = new AWS.DynamoDB.DocumentClient();

function getCorsHeaders(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || 'https://live.bndy.co.uk';
  const allowedOrigins = [
    'https://live.bndy.co.uk',
    'https://gigmap.bndy.co.uk',
    'https://backstage.bndy.co.uk',
    'http://localhost:3000',
    'http://localhost:3001'
  ];

  const allowOrigin = allowedOrigins.includes(origin) ? origin : 'https://live.bndy.co.uk';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Credentials': 'true'
  };
}

exports.handler = async (event) => {
  console.log('FESTIVALS: Request received', {
    routeKey: event.routeKey,
    path: event.rawPath,
    method: event.requestContext?.http?.method
  });

  const deps = { dynamodb, getCorsHeaders };
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
    // Route matching
    // POST /festivals - Create festival
    if (routeKey.match(/POST \/festivals$/)) {
      return await handleCreateFestival(deps, event);
    }

    // PATCH /festivals/{id} - Update festival
    if (routeKey.match(/PATCH \/festivals\/[^/]+$/)) {
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
