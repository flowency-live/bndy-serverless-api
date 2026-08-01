// BNDY Source Runs Lambda Function - Source Runner Observability API
// Provides read-only access to source run history and review items
// Admin-only (platformAdmin required) - for backstage/godmode dashboard
//
// Endpoints:
// - GET /api/source-runs?limit=N - Recent runs across all sources
// - GET /api/source-runs/summaries - Per-source summary stats
// - GET /api/source-runs/coverage - Footprint stats per source (10min cache)
// - GET /api/source-runs/{sourceId}?limit=N - Runs for specific source
// - GET /api/source-runs/{sourceId}/{runId} - Single run detail
// - GET /api/review-items?status=open&sourceId= - Review items from S3

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');

// AWS Services
const s3 = new AWS.S3({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });

// Configuration
const BUCKET_NAME = process.env.SOURCE_RUNS_BUCKET || 'bndy-signals-prod-771551874768';
const PREFIX = 'source-runs';
const USERS_TABLE = 'bndy-users';

// JWT Secret - cached after first retrieval
let JWT_SECRET = null;

// Coverage cache - 10 minute TTL
let coverageCache = null;
let coverageCacheExpiry = 0;
const COVERAGE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
    console.log('[SOURCE-RUNS] JWT_SECRET loaded from SSM');
    return JWT_SECRET;
  } catch (error) {
    console.error('[SOURCE-RUNS] Failed to get JWT_SECRET from SSM:', error.message);
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      console.log('[SOURCE-RUNS] JWT_SECRET loaded from environment variable (fallback)');
      return JWT_SECRET;
    }
    throw new Error('JWT_SECRET not available from SSM or environment');
  }
}

// Allowed CORS origins
const ALLOWED_ORIGINS = [
  'https://www.bndy.co.uk',
  'https://backstage.bndy.co.uk',
  'https://bndy.co.uk',
  'https://live.bndy.co.uk',
  'https://gigmap.bndy.co.uk',
  'http://localhost:3000'
];

// Module-level variable for current request
let currentEvent = null;

const getAllowedOrigin = () => {
  const requestOrigin = currentEvent?.headers?.origin || currentEvent?.headers?.Origin;
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
};

const getCorsHeaders = () => ({
  'Access-Control-Allow-Origin': getAllowedOrigin(),
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Credentials': 'true'
});

const createResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    ...getCorsHeaders()
  },
  body: JSON.stringify(body)
});

const parseCookies = (cookieHeader) => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, value] = cookie.trim().split('=');
    cookies[name] = value;
    return cookies;
  }, {});
};

/**
 * Require authentication AND platformAdmin flag.
 * Returns { user } on success, { error } on failure.
 */
const requirePlatformAdmin = async (event) => {
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
    console.log('[SOURCE-RUNS] No session token found');
    return { error: 'Not authenticated', status: 401 };
  }

  try {
    const jwtSecret = await getJWTSecret();
    const session = jwt.verify(sessionToken, jwtSecret);

    // Fetch user to check platformAdmin flag
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: session.userId }
    }).promise();

    const platformAdmin = userResult.Item?.platformAdmin || false;

    if (!platformAdmin) {
      console.log('[SOURCE-RUNS] User is not platformAdmin', { userId: session.userId });
      return { error: 'Admin access required', status: 403 };
    }

    return { user: { ...session, platformAdmin } };
  } catch (error) {
    console.error('[SOURCE-RUNS] Auth error:', error.message);
    return { error: 'Invalid session', status: 401 };
  }
};

/**
 * Format source ID to human-readable name
 * e.g. "klma-stoke-gig-list" -> "KLMA Stoke Gig List"
 */
const formatSourceName = (sourceId) => {
  const acronyms = ['klma', 'api', 'rss'];
  return sourceId
    .split('-')
    .map(word => {
      if (acronyms.includes(word.toLowerCase())) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
};

/**
 * GET /api/source-runs/summaries
 * Returns per-source summary stats for the dashboard overview.
 * Response format matches frontend SourceSummary interface.
 */
const handleGetSourceSummaries = async (event) => {
  const authResult = await requirePlatformAdmin(event);
  if (authResult.error) {
    return createResponse(authResult.status, { error: authResult.error });
  }

  try {
    // List all source directories
    const listResult = await s3.listObjectsV2({
      Bucket: BUCKET_NAME,
      Prefix: `${PREFIX}/`,
      Delimiter: '/'
    }).promise();

    const sourceIds = (listResult.CommonPrefixes || [])
      .map(p => p.Prefix.replace(`${PREFIX}/`, '').replace(/\/$/, ''))
      .filter(Boolean);

    console.log('[SOURCE-RUNS] Building summaries for sources:', sourceIds);

    // Build summary for each source (matching frontend SourceSummary interface)
    const sources = [];
    for (const sourceId of sourceIds) {
      const runsResult = await s3.listObjectsV2({
        Bucket: BUCKET_NAME,
        Prefix: `${PREFIX}/${sourceId}/`,
        Delimiter: '/'
      }).promise();

      const runDates = (runsResult.CommonPrefixes || [])
        .map(p => {
          const parts = p.Prefix.split('/').filter(Boolean);
          return parts[parts.length - 1];
        })
        .filter(Boolean)
        .sort((a, b) => b.localeCompare(a)); // Descending by date

      // Get recent runs (up to 10)
      const recentRuns = [];
      let completedCount = 0;
      for (const runDate of runDates.slice(0, 10)) {
        try {
          const runData = await s3.getObject({
            Bucket: BUCKET_NAME,
            Key: `${PREFIX}/${sourceId}/${runDate}/run.json`
          }).promise();
          const run = JSON.parse(runData.Body.toString());
          recentRuns.push(run);
          if (run.status === 'completed') completedCount++;
        } catch (e) {
          // No run.json for this date
        }
      }

      // Calculate success rate
      const successRate = recentRuns.length > 0
        ? (completedCount / recentRuns.length) * 100
        : 0;

      sources.push({
        sourceId,
        sourceName: formatSourceName(sourceId),
        lastRun: recentRuns[0] || null,
        recentRuns,
        successRate,
        totalRuns: runDates.length,
        openReviewItems: 0, // TODO: fetch from review items
      });
    }

    return createResponse(200, { sources });
  } catch (error) {
    console.error('[SOURCE-RUNS] Error getting summaries:', error);
    return createResponse(500, { error: 'Failed to get source summaries' });
  }
};

/**
 * GET /api/source-runs?limit=N
 * Returns most recent runs across all sources.
 */
const handleListSourceRuns = async (event) => {
  const authResult = await requirePlatformAdmin(event);
  if (authResult.error) {
    return createResponse(authResult.status, { error: authResult.error });
  }

  const limit = parseInt(event.queryStringParameters?.limit || '20', 10);

  try {
    // List all source directories
    const listResult = await s3.listObjectsV2({
      Bucket: BUCKET_NAME,
      Prefix: `${PREFIX}/`,
      Delimiter: '/'
    }).promise();

    const sourceIds = (listResult.CommonPrefixes || [])
      .map(p => p.Prefix.replace(`${PREFIX}/`, '').replace(/\/$/, ''))
      .filter(Boolean);

    console.log('[SOURCE-RUNS] Found sources:', sourceIds);

    // For each source, get recent run.json files
    const allRuns = [];
    for (const sourceId of sourceIds) {
      const runsResult = await s3.listObjectsV2({
        Bucket: BUCKET_NAME,
        Prefix: `${PREFIX}/${sourceId}/`,
        Delimiter: '/'
      }).promise();

      const runDates = (runsResult.CommonPrefixes || [])
        .map(p => {
          const parts = p.Prefix.split('/').filter(Boolean);
          return parts[parts.length - 1];
        })
        .filter(Boolean)
        .sort((a, b) => b.localeCompare(a)); // Descending by date

      // Get latest runs for this source (up to 5)
      for (const runDate of runDates.slice(0, 5)) {
        try {
          const runData = await s3.getObject({
            Bucket: BUCKET_NAME,
            Key: `${PREFIX}/${sourceId}/${runDate}/run.json`
          }).promise();
          const run = JSON.parse(runData.Body.toString());
          allRuns.push(run);
        } catch (e) {
          // run.json doesn't exist for this date, skip
          console.log(`[SOURCE-RUNS] No run.json for ${sourceId}/${runDate}`);
        }
      }
    }

    // Sort all runs by startedAt descending
    allRuns.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));

    return createResponse(200, {
      runs: allRuns.slice(0, limit),
      count: allRuns.length,
      sources: sourceIds
    });
  } catch (error) {
    console.error('[SOURCE-RUNS] Error listing runs:', error);
    return createResponse(500, { error: 'Failed to list source runs' });
  }
};

/**
 * GET /api/source-runs/{sourceId}?limit=N
 * Returns run history for a specific source.
 */
const handleGetSourceRunsBySource = async (event) => {
  const authResult = await requirePlatformAdmin(event);
  if (authResult.error) {
    return createResponse(authResult.status, { error: authResult.error });
  }

  const sourceId = event.pathParameters?.sourceId;
  const limit = parseInt(event.queryStringParameters?.limit || '20', 10);

  if (!sourceId) {
    return createResponse(400, { error: 'sourceId is required' });
  }

  try {
    const runsResult = await s3.listObjectsV2({
      Bucket: BUCKET_NAME,
      Prefix: `${PREFIX}/${sourceId}/`,
      Delimiter: '/'
    }).promise();

    const runDates = (runsResult.CommonPrefixes || [])
      .map(p => {
        const parts = p.Prefix.split('/').filter(Boolean);
        return parts[parts.length - 1];
      })
      .filter(Boolean)
      .sort((a, b) => b.localeCompare(a));

    const runs = [];
    for (const runDate of runDates.slice(0, limit)) {
      try {
        const runData = await s3.getObject({
          Bucket: BUCKET_NAME,
          Key: `${PREFIX}/${sourceId}/${runDate}/run.json`
        }).promise();
        runs.push(JSON.parse(runData.Body.toString()));
      } catch (e) {
        // Skip dates without run.json
      }
    }

    return createResponse(200, { runs, sourceId, count: runs.length });
  } catch (error) {
    console.error('[SOURCE-RUNS] Error getting source runs:', error);
    return createResponse(500, { error: 'Failed to get source runs' });
  }
};

/**
 * GET /api/source-runs/{sourceId}/{runId}
 * Returns a single run's full details.
 */
const handleGetSourceRun = async (event) => {
  const authResult = await requirePlatformAdmin(event);
  if (authResult.error) {
    return createResponse(authResult.status, { error: authResult.error });
  }

  const { sourceId, runId } = event.pathParameters || {};

  if (!sourceId || !runId) {
    return createResponse(400, { error: 'sourceId and runId are required' });
  }

  try {
    // List run dates and find the one matching runId
    const runsResult = await s3.listObjectsV2({
      Bucket: BUCKET_NAME,
      Prefix: `${PREFIX}/${sourceId}/`,
      Delimiter: '/'
    }).promise();

    for (const prefix of runsResult.CommonPrefixes || []) {
      const runDate = prefix.Prefix.split('/').filter(Boolean).pop();
      try {
        const runData = await s3.getObject({
          Bucket: BUCKET_NAME,
          Key: `${PREFIX}/${sourceId}/${runDate}/run.json`
        }).promise();
        const run = JSON.parse(runData.Body.toString());
        if (run.runId === runId) {
          return createResponse(200, run);
        }
      } catch (e) {
        // Continue searching
      }
    }

    return createResponse(404, { error: 'Run not found', sourceId, runId });
  } catch (error) {
    console.error('[SOURCE-RUNS] Error getting run:', error);
    return createResponse(500, { error: 'Failed to get source run' });
  }
};

/**
 * GET /api/review-items?status=open&sourceId=
 * Returns review items from S3.
 */
const handleGetReviewItems = async (event) => {
  const authResult = await requirePlatformAdmin(event);
  if (authResult.error) {
    return createResponse(authResult.status, { error: authResult.error });
  }

  const status = event.queryStringParameters?.status || 'open';
  const sourceIdFilter = event.queryStringParameters?.sourceId;

  try {
    // Get all sources or filter to specific one
    let sourceIds = [];
    if (sourceIdFilter) {
      sourceIds = [sourceIdFilter];
    } else {
      const listResult = await s3.listObjectsV2({
        Bucket: BUCKET_NAME,
        Prefix: `${PREFIX}/`,
        Delimiter: '/'
      }).promise();
      sourceIds = (listResult.CommonPrefixes || [])
        .map(p => p.Prefix.replace(`${PREFIX}/`, '').replace(/\/$/, ''))
        .filter(Boolean);
    }

    const allItems = [];
    for (const sourceId of sourceIds) {
      // Get most recent run dates for this source
      const runsResult = await s3.listObjectsV2({
        Bucket: BUCKET_NAME,
        Prefix: `${PREFIX}/${sourceId}/`,
        Delimiter: '/'
      }).promise();

      const runDates = (runsResult.CommonPrefixes || [])
        .map(p => p.Prefix.split('/').filter(Boolean).pop())
        .filter(Boolean)
        .sort((a, b) => b.localeCompare(a));

      // Check recent runs for review items (last 10 runs)
      for (const runDate of runDates.slice(0, 10)) {
        try {
          const itemsData = await s3.getObject({
            Bucket: BUCKET_NAME,
            Key: `${PREFIX}/${sourceId}/${runDate}/review/items.json`
          }).promise();
          const items = JSON.parse(itemsData.Body.toString());
          const filtered = items.filter(item => item.status === status);
          allItems.push(...filtered);
        } catch (e) {
          // No review items for this run
        }
      }
    }

    return createResponse(200, {
      items: allItems,
      count: allItems.length,
      status
    });
  } catch (error) {
    console.error('[SOURCE-RUNS] Error getting review items:', error);
    return createResponse(500, { error: 'Failed to get review items' });
  }
};

/**
 * GET /api/source-runs/coverage
 * Returns footprint stats per source: how many events/venues/artists in bndy
 * have external_ids from each source. Cached for 10 minutes.
 */
const handleGetCoverage = async (event) => {
  const authResult = await requirePlatformAdmin(event);
  if (authResult.error) {
    return createResponse(authResult.status, { error: authResult.error });
  }

  // Return cached result if still valid
  const now = Date.now();
  if (coverageCache && now < coverageCacheExpiry) {
    console.log('[SOURCE-RUNS] Returning cached coverage data');
    return createResponse(200, coverageCache);
  }

  console.log('[SOURCE-RUNS] Computing fresh coverage data');

  try {
    // Tables to scan for external_ids
    const tables = [
      { name: 'bndy-events', type: 'events' },
      { name: 'bndy-venues', type: 'venues' },
      { name: 'bndy-artists', type: 'artists' }
    ];

    // Count external_ids by source for each table
    const coverage = {};

    for (const table of tables) {
      const sourceIdCounts = await countExternalIdsBySource(table.name);

      for (const [sourceId, count] of Object.entries(sourceIdCounts)) {
        if (!coverage[sourceId]) {
          coverage[sourceId] = {
            sourceId,
            sourceName: formatSourceName(sourceId),
            events: 0,
            venues: 0,
            artists: 0
          };
        }
        coverage[sourceId][table.type] = count;
      }
    }

    // Convert to array sorted by total footprint
    const sources = Object.values(coverage).sort((a, b) => {
      const totalA = a.events + a.venues + a.artists;
      const totalB = b.events + b.venues + b.artists;
      return totalB - totalA;
    });

    const result = { sources, computedAt: new Date().toISOString() };

    // Cache the result
    coverageCache = result;
    coverageCacheExpiry = now + COVERAGE_CACHE_TTL_MS;

    return createResponse(200, result);
  } catch (error) {
    console.error('[SOURCE-RUNS] Error computing coverage:', error);
    return createResponse(500, { error: 'Failed to compute coverage stats' });
  }
};

/**
 * Scan a DynamoDB table and count unique external_ids by source.
 * Returns { sourceId: count } for each source found in external_ids arrays.
 */
async function countExternalIdsBySource(tableName) {
  const counts = {};
  let lastEvaluatedKey = undefined;

  do {
    const params = {
      TableName: tableName,
      ProjectionExpression: 'external_ids',
      ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey })
    };

    const result = await dynamodb.scan(params).promise();

    for (const item of result.Items || []) {
      const externalIds = item.external_ids;
      if (!externalIds || !Array.isArray(externalIds)) continue;

      for (const extId of externalIds) {
        // external_id format: "source:id" e.g. "klma-stoke-gig-list:123"
        if (typeof extId !== 'string') continue;
        const colonIndex = extId.indexOf(':');
        if (colonIndex === -1) continue;

        const sourceId = extId.slice(0, colonIndex);
        counts[sourceId] = (counts[sourceId] || 0) + 1;
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return counts;
}

/**
 * Main handler
 */
exports.handler = async (event, context) => {
  currentEvent = event;
  context.callbackWaitsForEmptyEventLoop = false;

  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;

  console.log('[SOURCE-RUNS] Request:', { method, path });

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: getCorsHeaders(), body: '' };
  }

  try {
    // Route by path pattern
    // GET /api/source-runs
    if (method === 'GET' && path === '/api/source-runs') {
      return await handleListSourceRuns(event);
    }

    // GET /api/review-items
    if (method === 'GET' && path === '/api/review-items') {
      return await handleGetReviewItems(event);
    }

    // GET /api/source-runs/summaries (must be before {sourceId} regex)
    if (method === 'GET' && path === '/api/source-runs/summaries') {
      return await handleGetSourceSummaries(event);
    }

    // GET /api/source-runs/coverage (must be before {sourceId} regex)
    if (method === 'GET' && path === '/api/source-runs/coverage') {
      return await handleGetCoverage(event);
    }

    // GET /api/source-runs/{sourceId} (but not /api/source-runs/{sourceId}/{runId})
    const sourceRunsMatch = path.match(/^\/api\/source-runs\/([^/]+)$/);
    if (method === 'GET' && sourceRunsMatch) {
      event.pathParameters = { sourceId: sourceRunsMatch[1] };
      return await handleGetSourceRunsBySource(event);
    }

    // GET /api/source-runs/{sourceId}/{runId}
    const sourceRunDetailMatch = path.match(/^\/api\/source-runs\/([^/]+)\/([^/]+)$/);
    if (method === 'GET' && sourceRunDetailMatch) {
      event.pathParameters = {
        sourceId: sourceRunDetailMatch[1],
        runId: sourceRunDetailMatch[2]
      };
      return await handleGetSourceRun(event);
    }

    return createResponse(404, {
      error: 'Route not found',
      path,
      method,
      availableRoutes: [
        'GET /api/source-runs',
        'GET /api/source-runs/summaries',
        'GET /api/source-runs/coverage',
        'GET /api/source-runs/{sourceId}',
        'GET /api/source-runs/{sourceId}/{runId}',
        'GET /api/review-items'
      ]
    });
  } catch (error) {
    console.error('[SOURCE-RUNS] Unexpected error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};
