/**
 * Godmode Handlers for Recurring Sessions
 *
 * Privileged routes for viewing projection results and managing Series.
 * Requires platformAdmin authorization.
 */

const AWS = require('aws-sdk');
const { requireAuth } = require('../lib/auth');
const { getCorsHeaders } = require('../lib/cors');
const { jsonResponse } = require('../lib/http-response');
const { computeOccurrencesInRange, PROJECTION_DEFAULTS } = require('../lib/projector');
const { applyExceptions } = require('../lib/exception-handler');
const { compareWithExistingEvents } = require('../lib/event-comparison');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const ssm = new AWS.SSM();

const RECURRING_SESSIONS_TABLE = process.env.RECURRING_SESSIONS_TABLE || 'bndy-recurring-sessions';
const EVENTS_TABLE = 'bndy-events';

/**
 * GET /api/godmode/recurring-sessions/{id}/projection
 *
 * Returns shadow projection results for a RecurringSession.
 * Shows what would be created/updated/conflicted without making any writes.
 */
async function handleGetProjection(event) {
  const corsHeaders = getCorsHeaders(event);

  // Require auth and platformAdmin
  const authResult = await requireAuth({ ssm, dynamodb, getCorsHeaders }, event);
  if (authResult.statusCode) {
    return authResult;
  }

  const { user } = authResult;
  if (!user.platformAdmin) {
    return jsonResponse(event, 403, { error: 'Godmode access required' }, { corsHeaders });
  }

  const seriesId = event.pathParameters?.id;
  if (!seriesId) {
    return jsonResponse(event, 400, { error: 'Series ID required' }, { corsHeaders });
  }

  // Fetch the RecurringSession
  const sessionResult = await dynamodb.get({
    TableName: RECURRING_SESSIONS_TABLE,
    Key: { id: seriesId }
  }).promise();

  if (!sessionResult.Item) {
    return jsonResponse(event, 404, { error: 'RecurringSession not found' }, { corsHeaders });
  }

  const session = sessionResult.Item;

  // Calculate projection window (16 weeks from today)
  const today = new Date();
  const startDate = today.toISOString().split('T')[0];

  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + PROJECTION_DEFAULTS.horizonWeeks * 7);
  const endDateStr = endDate.toISOString().split('T')[0];

  // Compute occurrences
  const rawOccurrences = computeOccurrencesInRange(
    session,
    startDate,
    endDateStr,
    { maxOccurrences: PROJECTION_DEFAULTS.maxOccurrences }
  );

  // Apply exceptions
  const exceptions = session.exceptions || [];
  const { occurrences, applied, notApplied } = applyExceptions(rawOccurrences, exceptions);

  // Fetch existing events for comparison
  const existingEvents = await fetchExistingEvents(session.venueId, startDate, endDateStr);

  // Compare projected occurrences with existing events
  const comparison = compareWithExistingEvents(occurrences, existingEvents);

  const response = {
    seriesId: session.id,
    seriesVersion: session.version || 1,
    seriesStatus: session.status,
    projectedAt: new Date().toISOString(),
    horizon: {
      startDate,
      endDate: endDateStr,
      weeks: PROJECTION_DEFAULTS.horizonWeeks
    },
    results: {
      wouldCreate: comparison.wouldCreate,
      wouldUpdate: comparison.wouldUpdate,
      alreadyExists: comparison.alreadyExists,
      conflicts: comparison.conflicts
    },
    exceptions: {
      applied,
      notApplied
    },
    summary: {
      totalOccurrences: occurrences.length,
      wouldCreate: comparison.wouldCreate.length,
      wouldUpdate: comparison.wouldUpdate.length,
      alreadyExists: comparison.alreadyExists.length,
      conflicts: comparison.conflicts.length,
      exceptionsApplied: applied.length
    }
  };

  return jsonResponse(event, 200, response, { corsHeaders });
}

/**
 * GET /api/godmode/recurring-sessions
 *
 * List all RecurringSessions with their status and next occurrence.
 */
async function handleListSessions(event) {
  const corsHeaders = getCorsHeaders(event);

  // Require auth and platformAdmin
  const authResult = await requireAuth({ ssm, dynamodb, getCorsHeaders }, event);
  if (authResult.statusCode) {
    return authResult;
  }

  const { user } = authResult;
  if (!user.platformAdmin) {
    return jsonResponse(event, 403, { error: 'Godmode access required' }, { corsHeaders });
  }

  // Query parameters
  const status = event.queryStringParameters?.status;
  const limit = parseInt(event.queryStringParameters?.limit || '50', 10);

  let params;

  if (status) {
    // Use status-index GSI
    params = {
      TableName: RECURRING_SESSIONS_TABLE,
      IndexName: 'status-index',
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status },
      Limit: limit
    };
  } else {
    // Scan all (limited)
    params = {
      TableName: RECURRING_SESSIONS_TABLE,
      Limit: limit
    };
  }

  const result = status
    ? await dynamodb.query(params).promise()
    : await dynamodb.scan(params).promise();

  const sessions = (result.Items || []).map(session => ({
    id: session.id,
    name: session.name,
    venueId: session.venueId,
    status: session.status,
    startsOn: session.startsOn,
    endsOn: session.endsOn,
    recurrence: session.recurrence,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt
  }));

  return jsonResponse(event, 200, {
    sessions,
    count: sessions.length,
    hasMore: !!result.LastEvaluatedKey
  }, { corsHeaders });
}

/**
 * Fetch existing events for a venue within a date range.
 */
async function fetchExistingEvents(venueId, startDate, endDate) {
  try {
    const result = await dynamodb.query({
      TableName: EVENTS_TABLE,
      IndexName: 'venueId-date-index',
      KeyConditionExpression: 'venueId = :venueId AND #date BETWEEN :startDate AND :endDate',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: {
        ':venueId': venueId,
        ':startDate': startDate,
        ':endDate': endDate
      }
    }).promise();

    return result.Items || [];
  } catch (error) {
    console.error('Failed to fetch existing events:', error);
    return [];
  }
}

module.exports = {
  handleGetProjection,
  handleListSessions
};
