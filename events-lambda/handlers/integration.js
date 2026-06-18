/**
 * Integration Handlers for Events Lambda
 *
 * Handles Integration API event operations.
 * These endpoints require API key authentication.
 */

const crypto = require('crypto');
const { getIntegrationHeaders } = require('../lib/cors');
const { validateApiKey } = require('../lib/auth');

// Table constants
const EVENTS_TABLE = 'bndy-events';

/**
 * POST /api/integration/events/find-or-create - Find or create event
 *
 * Checks for existing event by artistId + date + venueId (existing duplicate check logic).
 * Returns existing if found, creates new if not.
 *
 * Request: { artistId, venueId, date, title?, startTime?, endTime?, ticketUrl?, ticketPrice?, description? }
 * Response: { success, event, isNew, matchMethod }
 *
 * @param {Object} deps - Dependencies { dynamodb }
 * @param {Object} event - Lambda event
 */
async function handleIntegrationFindOrCreateEvent(deps, event) {
  const { dynamodb } = deps;

  console.log('[INTEGRATION] Events Lambda: Find-or-create event');

  // 1. Validate API key
  if (!validateApiKey(event)) {
    return {
      statusCode: 401,
      headers: getIntegrationHeaders(),
      body: JSON.stringify({ error: 'Invalid or missing API key' })
    };
  }

  // 2. Parse and validate input
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: getIntegrationHeaders(),
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  const { artistId, venueId, date, title, startTime, endTime, ticketUrl, ticketPrice, description } = body;

  if (!artistId) {
    return {
      statusCode: 400,
      headers: getIntegrationHeaders(),
      body: JSON.stringify({ error: 'artistId is required' })
    };
  }

  if (!venueId) {
    return {
      statusCode: 400,
      headers: getIntegrationHeaders(),
      body: JSON.stringify({ error: 'venueId is required' })
    };
  }

  if (!date) {
    return {
      statusCode: 400,
      headers: getIntegrationHeaders(),
      body: JSON.stringify({ error: 'date is required' })
    };
  }

  try {
    // 3. Check for existing event (artistId + date + venueId) - using existing GSI
    const duplicateCheck = await dynamodb.query({
      TableName: EVENTS_TABLE,
      IndexName: 'artistId-date-index',
      KeyConditionExpression: 'artistId = :artistId AND #date = :date',
      FilterExpression: 'venueId = :venueId',
      ExpressionAttributeNames: {
        '#date': 'date'
      },
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':date': date,
        ':venueId': venueId
      }
    }).promise();

    // 4. If duplicate found, return existing event
    if (duplicateCheck.Items && duplicateCheck.Items.length > 0) {
      const existingEvent = duplicateCheck.Items[0];
      console.log(`[INTEGRATION] Found existing event: ${existingEvent.id}`);

      return {
        statusCode: 200,
        headers: getIntegrationHeaders(),
        body: JSON.stringify({
          success: true,
          event: {
            id: existingEvent.id,
            artistId: existingEvent.artistId,
            venueId: existingEvent.venueId,
            date: existingEvent.date,
            title: existingEvent.title || null,
            startTime: existingEvent.startTime || null,
            endTime: existingEvent.endTime || null,
            ticketUrl: existingEvent.ticketUrl || null,
            ticketPrice: existingEvent.ticketPrice || null,
            type: existingEvent.type || 'public_gig'
          },
          isNew: false,
          matchMethod: 'artist_venue_date'
        })
      };
    }

    // 5. No duplicate - create new event
    console.log(`[INTEGRATION] No duplicate found - creating new event for artist ${artistId} at venue ${venueId} on ${date}`);

    const now = new Date().toISOString();
    const eventId = crypto.randomUUID();

    const newEvent = {
      id: eventId,
      artistId: artistId,
      venueId: venueId,
      date: date,
      title: title || '',
      type: 'public_gig',
      isPublic: true,
      startTime: startTime || null,
      endTime: endTime || null,
      ticketUrl: ticketUrl || null,
      ticketPrice: ticketPrice || null,
      description: description || null,
      source: 'integration_api',
      ai_created: true,
      needs_review: true,
      created_at: now,
      updated_at: now
    };

    await dynamodb.put({
      TableName: EVENTS_TABLE,
      Item: newEvent
    }).promise();

    console.log(`[INTEGRATION] Created new event: ${eventId}`);

    return {
      statusCode: 201,
      headers: getIntegrationHeaders(),
      body: JSON.stringify({
        success: true,
        event: {
          id: eventId,
          artistId: artistId,
          venueId: venueId,
          date: date,
          title: newEvent.title,
          startTime: newEvent.startTime,
          endTime: newEvent.endTime,
          ticketUrl: newEvent.ticketUrl,
          ticketPrice: newEvent.ticketPrice,
          type: newEvent.type
        },
        isNew: true,
        matchMethod: 'new_event_created'
      })
    };

  } catch (error) {
    console.error('[INTEGRATION] Event find-or-create failed:', error);
    return {
      statusCode: 500,
      headers: getIntegrationHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

module.exports = {
  handleIntegrationFindOrCreateEvent,
  EVENTS_TABLE
};
