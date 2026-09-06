/**
 * Mutation Handlers for Recurring Sessions
 *
 * POST /api/recurring-sessions - Create a new Series and materialise Events
 */

const AWS = require('aws-sdk');
const crypto = require('crypto');
const { requireAuth } = require('../lib/auth');
const { getCorsHeaders } = require('../lib/cors');
const { jsonResponse } = require('../lib/http-response');
const { validateRecurringSession } = require('../lib/recurring-session-data');
const { validateRecurrencePattern } = require('../lib/recurrence-patterns');
const { validateTimezone } = require('../lib/timezone-utils');
const { checkSeriesUniqueness, reserveSeriesKey } = require('../lib/series-uniqueness');
const { computeOccurrencesInRange, PROJECTION_DEFAULTS } = require('../lib/projector');
const { applyExceptions } = require('../lib/exception-handler');
const { writeBatch } = require('../lib/event-writer');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const ssm = new AWS.SSM();

const RECURRING_SESSIONS_TABLE = process.env.RECURRING_SESSIONS_TABLE || 'bndy-recurring-sessions';

/**
 * Generate a unique Series ID.
 * @returns {string}
 */
function generateSeriesId() {
  return 'rs_' + crypto.randomBytes(12).toString('hex');
}

/**
 * POST /api/recurring-sessions
 *
 * Create a new RecurringSession and materialise bounded Events.
 */
async function handleCreateRecurringSession(event) {
  const corsHeaders = getCorsHeaders(event);

  // Require authentication
  const authResult = await requireAuth({ ssm, dynamodb, getCorsHeaders }, event);
  if (authResult.statusCode) {
    return authResult;
  }

  const { user } = authResult;

  // Parse request body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonResponse(event, 400, { error: 'Invalid JSON body' }, { corsHeaders });
  }

  // Validate required fields
  const requiredFields = ['name', 'venueId', 'recurrence', 'defaultStartTime', 'startsOn', 'timezone'];
  for (const field of requiredFields) {
    if (!body[field]) {
      return jsonResponse(event, 400, { error: `${field} is required` }, { corsHeaders });
    }
  }

  // Validate recurrence pattern
  const recurrenceError = validateRecurrencePattern(body.recurrence);
  if (recurrenceError) {
    return jsonResponse(event, 400, { error: recurrenceError }, { corsHeaders });
  }

  // Validate timezone
  const timezoneError = validateTimezone(body.timezone);
  if (timezoneError) {
    return jsonResponse(event, 400, { error: timezoneError }, { corsHeaders });
  }

  // Build the session object
  const now = new Date().toISOString();
  const session = {
    id: generateSeriesId(),
    name: body.name,
    venueId: body.venueId,
    sessionType: body.sessionType || 'other',
    recurrence: body.recurrence,
    defaultStartTime: body.defaultStartTime,
    defaultEndTime: body.defaultEndTime || null,
    startsOn: body.startsOn,
    endsOn: body.endsOn || null,
    timezone: body.timezone,
    description: body.description || null,
    status: 'active',
    version: 1,
    exceptions: [],
    createdBy: user.userId,
    createdAt: now,
    updatedAt: now
  };

  // Validate the full session
  const sessionError = validateRecurringSession(session);
  if (sessionError) {
    return jsonResponse(event, 400, { error: sessionError }, { corsHeaders });
  }

  // Check for existing Series with same key
  const existing = await checkSeriesUniqueness(dynamodb, session);
  if (existing) {
    return jsonResponse(event, 409, {
      error: 'Series conflict',
      existingSeries: {
        id: existing.refId,
        key: existing.key
      },
      suggestion: 'A similar recurring session already exists at this venue'
    }, { corsHeaders });
  }

  // Reserve the Series unique key
  const reserveResult = await reserveSeriesKey(dynamodb, session);
  if (!reserveResult.success) {
    return jsonResponse(event, 409, {
      error: 'Series conflict',
      suggestion: 'A similar recurring session was just created at this venue'
    }, { corsHeaders });
  }

  // Write the RecurringSession to DynamoDB
  try {
    await dynamodb.put({
      TableName: RECURRING_SESSIONS_TABLE,
      Item: session
    }).promise();
  } catch (error) {
    console.error('Failed to create RecurringSession:', error);
    return jsonResponse(event, 500, { error: 'Failed to create recurring session' }, { corsHeaders });
  }

  // Compute and materialise Events
  const startDate = session.startsOn;
  const endDate = computeEndDate(startDate, PROJECTION_DEFAULTS.horizonWeeks);

  const rawOccurrences = computeOccurrencesInRange(
    session,
    startDate,
    endDate,
    { maxOccurrences: PROJECTION_DEFAULTS.maxOccurrences }
  );

  const { occurrences } = applyExceptions(rawOccurrences, session.exceptions);

  // Write Events (with notification suppression)
  const writeResult = await writeBatch(dynamodb, occurrences, session, {
    suppressNotifications: true
  });

  return jsonResponse(event, 201, {
    seriesId: session.id,
    status: session.status,
    createdEvents: writeResult.created.map(e => ({
      eventId: e.eventId,
      date: e.date
    })),
    conflicts: writeResult.conflicts,
    summary: writeResult.summary
  }, { corsHeaders });
}

/**
 * Compute end date for projection window.
 */
function computeEndDate(startDate, weeks) {
  const start = new Date(startDate + 'T00:00:00Z');
  start.setUTCDate(start.getUTCDate() + weeks * 7);
  return start.toISOString().split('T')[0];
}

module.exports = {
  handleCreateRecurringSession
};
