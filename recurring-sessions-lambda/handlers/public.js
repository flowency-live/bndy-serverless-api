/**
 * Public Handlers for Recurring Sessions
 *
 * READ-ONLY handlers for Slice 1.
 * No mutation routes are exposed in this slice.
 */

const { RECURRING_SESSIONS_TABLE, VALID_STATUSES } = require('../lib/recurring-session-data');
const { jsonResponse, notFound } = require('../lib/http-response');

/**
 * GET /api/venues/{venueId}/recurring-sessions
 *
 * Returns active/paused recurring sessions for a venue.
 * Query params:
 *   - status: filter by status (default: active,paused)
 *   - includeEnded: include ended sessions (default: false)
 *
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 * @returns {Promise<Object>} Lambda response
 */
async function handleGetVenueRecurringSessions(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const venueId = event.pathParameters?.venueId;

  if (!venueId) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'venueId is required' })
    };
  }

  const queryParams = event.queryStringParameters || {};
  const includeEnded = queryParams.includeEnded === 'true';

  // Determine which statuses to include
  let filterStatuses = ['active', 'paused'];
  if (queryParams.status && VALID_STATUSES.includes(queryParams.status)) {
    filterStatuses = [queryParams.status];
  } else if (includeEnded) {
    filterStatuses = ['active', 'paused', 'ended'];
  }

  try {
    const result = await dynamodb.query({
      TableName: RECURRING_SESSIONS_TABLE,
      IndexName: 'venueId-index',
      KeyConditionExpression: 'venueId = :venueId',
      ExpressionAttributeValues: {
        ':venueId': venueId
      }
    }).promise();

    // Filter by status client-side (GSI doesn't include status as sort key)
    const sessions = (result.Items || [])
      .filter(session => filterStatuses.includes(session.status))
      .map(stripInternalFields);

    return jsonResponse(event, 200, { sessions }, {
      corsHeaders: getCorsHeaders(event),
      cacheControl: 'public, max-age=60'
    });
  } catch (error) {
    console.error('RECURRING_SESSIONS: Error fetching venue sessions:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Failed to fetch recurring sessions' })
    };
  }
}

/**
 * GET /api/recurring-sessions/{id}
 *
 * Returns a single recurring session by ID.
 *
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 * @returns {Promise<Object>} Lambda response
 */
async function handleGetRecurringSessionById(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const id = event.pathParameters?.id;

  if (!id) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'id is required' })
    };
  }

  try {
    const result = await dynamodb.get({
      TableName: RECURRING_SESSIONS_TABLE,
      Key: { id }
    }).promise();

    if (!result.Item) {
      return notFound(event, 'Recurring session not found', getCorsHeaders(event));
    }

    // Only return public sessions (not draft)
    if (result.Item.status === 'draft') {
      return notFound(event, 'Recurring session not found', getCorsHeaders(event));
    }

    return jsonResponse(event, 200, { session: stripInternalFields(result.Item) }, {
      corsHeaders: getCorsHeaders(event),
      cacheControl: 'public, max-age=60'
    });
  } catch (error) {
    console.error('RECURRING_SESSIONS: Error fetching session:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Failed to fetch recurring session' })
    };
  }
}

/**
 * GET /api/recurring-sessions/search
 *
 * Search recurring sessions with filters.
 * Query params:
 *   - status: filter by status (default: active)
 *   - limit: max results (default: 50, max: 100)
 *
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 * @returns {Promise<Object>} Lambda response
 */
async function handleSearchRecurringSessions(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const queryParams = event.queryStringParameters || {};

  const status = queryParams.status || 'active';
  const limit = Math.min(parseInt(queryParams.limit, 10) || 50, 100);

  if (!VALID_STATUSES.includes(status)) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` })
    };
  }

  try {
    const result = await dynamodb.query({
      TableName: RECURRING_SESSIONS_TABLE,
      IndexName: 'status-index',
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status },
      Limit: limit
    }).promise();

    const sessions = (result.Items || []).map(stripInternalFields);

    return jsonResponse(event, 200, {
      sessions,
      count: sessions.length,
      hasMore: !!result.LastEvaluatedKey
    }, {
      corsHeaders: getCorsHeaders(event),
      cacheControl: 'public, max-age=60'
    });
  } catch (error) {
    console.error('RECURRING_SESSIONS: Error searching sessions:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Failed to search recurring sessions' })
    };
  }
}

/**
 * Strip internal fields from a session before returning to client.
 * @param {Object} session
 * @returns {Object}
 */
function stripInternalFields(session) {
  const { normalisedName, ...publicFields } = session;
  return publicFields;
}

module.exports = {
  handleGetVenueRecurringSessions,
  handleGetRecurringSessionById,
  handleSearchRecurringSessions,
  stripInternalFields
};
