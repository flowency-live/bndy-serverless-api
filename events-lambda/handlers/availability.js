/**
 * Availability Handlers for Events Lambda
 *
 * Handles artist availability management.
 * Some endpoints require auth (toggle, bulk), others are public (get).
 */

const crypto = require('crypto');
const { verifyMembership } = require('../lib/auth');

// Table constants
const EVENTS_TABLE = 'bndy-events';

/**
 * GET /api/artists/:artistId/public-availability - Get artist availability (NO AUTH)
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 */
async function handleGetArtistAvailability(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;

  console.log('ARTIST_AVAILABILITY: Handler invoked', { pathParameters: event.pathParameters, queryStringParameters: event.queryStringParameters });

  if (!event.pathParameters || !event.pathParameters.artistId) {
    console.error('ARTIST_AVAILABILITY: Missing artistId in pathParameters');
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'artistId is required' })
    };
  }

  const { artistId } = event.pathParameters;
  const { startDate, endDate } = event.queryStringParameters || {};

  // Default to today if no startDate provided
  const today = new Date().toISOString().split('T')[0];
  const start = startDate || today;
  const end = endDate || '2099-12-31';

  console.log('ARTIST_AVAILABILITY: Query received', { artistId, startDate: start, endDate: end });

  try {
    // Fetch artist to check availabilityMode and publishAvailability
    const artistResult = await dynamodb.get({
      TableName: 'bndy-artists',
      Key: { id: artistId }
    }).promise();

    const artist = artistResult.Item;
    const publishAvailability = artist?.publishAvailability || false;
    const availabilityMode = artist?.availabilityMode || 'selected_dates_only';

    // Return empty if publishAvailability is false
    if (!publishAvailability) {
      console.log('ARTIST_AVAILABILITY: publishAvailability is false, returning empty');
      return {
        statusCode: 200,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ availability: [] })
      };
    }

    let availability = [];

    if (availabilityMode === 'free_weekends') {
      // Generate all Fri/Sat/Sun dates in range
      const weekendDates = [];
      let currentDate = new Date(start);
      const endDateObj = new Date(end);

      while (currentDate <= endDateObj) {
        const dayOfWeek = currentDate.getDay();
        // Friday (5), Saturday (6), Sunday (0)
        if (dayOfWeek === 0 || dayOfWeek === 5 || dayOfWeek === 6) {
          const dateStr = currentDate.toISOString().split('T')[0];
          weekendDates.push(dateStr);
        }
        currentDate.setDate(currentDate.getDate() + 1);
      }

      console.log('ARTIST_AVAILABILITY: Generated weekend dates', { count: weekendDates.length });

      // For each weekend date, check if any events exist (each day evaluated independently)
      for (const date of weekendDates) {
        const eventsOnDate = await dynamodb.query({
          TableName: EVENTS_TABLE,
          IndexName: 'artistId-date-index',
          KeyConditionExpression: 'artistId = :artistId AND #date = :date',
          ExpressionAttributeNames: { '#date': 'date' },
          ExpressionAttributeValues: {
            ':artistId': artistId,
            ':date': date
          }
        }).promise();

        // Include date only if no events exist
        if (!eventsOnDate.Items || eventsOnDate.Items.length === 0) {
          availability.push({
            id: `free-${date}`,
            artistId,
            date,
            type: 'free_weekend',
            notes: 'Free weekend day'
          });
        }
      }

      console.log('ARTIST_AVAILABILITY: Free weekends found', { artistId, count: availability.length });
    } else {
      // Selected dates only mode - query for type="available" events
      const result = await dynamodb.query({
        TableName: EVENTS_TABLE,
        IndexName: 'artistId-date-index',
        KeyConditionExpression: 'artistId = :artistId AND #date BETWEEN :start AND :end',
        FilterExpression: '#type = :available',
        ExpressionAttributeNames: { '#date': 'date', '#type': 'type' },
        ExpressionAttributeValues: {
          ':artistId': artistId,
          ':start': start,
          ':end': end,
          ':available': 'available'
        }
      }).promise();

      availability = result.Items || [];
      console.log('ARTIST_AVAILABILITY: Selected dates found', { artistId, count: availability.length });
    }

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ availability })
    };
  } catch (error) {
    console.error('ARTIST_AVAILABILITY: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Failed to fetch artist availability' })
    };
  }
}

/**
 * POST /api/artists/:artistId/events/toggle-availability - Toggle availability for a date
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 * @param {Object} user - Authenticated user
 */
async function handleToggleAvailability(deps, event, user) {
  const { dynamodb, getCorsHeaders } = deps;
  const { artistId } = event.pathParameters;
  const { date, notes } = JSON.parse(event.body);

  console.log('TOGGLE_AVAILABILITY: Request received', { artistId, date, userId: user.userId });

  // Check access - platform admin OR member
  if (!user.platformAdmin) {
    const membership = await verifyMembership(dynamodb, user.userId, artistId);
    if (!membership) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'Not a member of this artist' })
      };
    }
  } else {
    console.log('[AVAILABILITY] Platform admin access granted');
  }

  // Validate date is provided
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Valid date in YYYY-MM-DD format is required' })
    };
  }

  // Validate date is in the future or today
  const today = new Date().toISOString().split('T')[0];
  if (date < today) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Cannot mark past dates as available' })
    };
  }

  try {
    // Check if availability event already exists for this artist + date
    const existingResult = await dynamodb.query({
      TableName: EVENTS_TABLE,
      IndexName: 'artistId-date-index',
      KeyConditionExpression: 'artistId = :artistId AND #date = :date',
      FilterExpression: '#type = :available',
      ExpressionAttributeNames: { '#date': 'date', '#type': 'type' },
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':date': date,
        ':available': 'available'
      }
    }).promise();

    const existing = (existingResult.Items || [])[0];

    if (existing) {
      // Delete existing availability (toggle off)
      await dynamodb.delete({
        TableName: EVENTS_TABLE,
        Key: { id: existing.id }
      }).promise();

      console.log('TOGGLE_AVAILABILITY: Deleted availability', { eventId: existing.id, artistId, date });

      return {
        statusCode: 200,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          action: 'deleted',
          id: existing.id
        })
      };
    } else {
      // Create new availability event (toggle on)
      const eventId = crypto.randomUUID();
      const now = new Date().toISOString();

      const newEvent = {
        id: eventId,
        artistId: artistId,
        type: 'available',
        date: date,
        endDate: date,
        isPublic: false,
        isAllDay: true,
        createdAt: now,
        updatedAt: now
      };

      if (notes) newEvent.notes = notes;

      await dynamodb.put({
        TableName: EVENTS_TABLE,
        Item: newEvent
      }).promise();

      console.log('TOGGLE_AVAILABILITY: Created availability', { eventId, artistId, date });

      return {
        statusCode: 201,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          action: 'created',
          event: newEvent
        })
      };
    }
  } catch (error) {
    console.error('TOGGLE_AVAILABILITY: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Failed to toggle availability' })
    };
  }
}

/**
 * POST /api/artists/:artistId/events/bulk-availability - Bulk set availability
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 * @param {Object} user - Authenticated user
 */
async function handleBulkAvailability(deps, event, user) {
  const { dynamodb, getCorsHeaders } = deps;
  const { artistId } = event.pathParameters;
  const { startDate, endDate, rules, notes } = JSON.parse(event.body);

  console.log('BULK_AVAILABILITY: Request received', { artistId, startDate, endDate, rules, userId: user.userId });

  // Check access - platform admin OR member
  if (!user.platformAdmin) {
    const membership = await verifyMembership(dynamodb, user.userId, artistId);
    if (!membership) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'Not a member of this artist' })
      };
    }
  } else {
    console.log('[AVAILABILITY] Platform admin access granted for bulk set');
  }

  // Validate required fields
  if (!startDate || !endDate || !rules || !Array.isArray(rules) || rules.length === 0) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'startDate, endDate, and rules array are required' })
    };
  }

  // Validate date range
  const today = new Date().toISOString().split('T')[0];
  if (startDate < today) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Cannot mark past dates as available' })
    };
  }

  if (endDate < startDate) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'endDate must be after startDate' })
    };
  }

  // Validate date range is not more than 1 year
  const start = new Date(startDate);
  const end = new Date(endDate);
  const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
  if (daysDiff > 365) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Date range cannot exceed 1 year' })
    };
  }

  try {
    // Generate list of dates matching rules
    const datesToMark = [];
    let currentDate = new Date(startDate);
    const endDateObj = new Date(endDate);

    while (currentDate <= endDateObj) {
      const dayOfWeek = currentDate.getDay();
      const dateStr = currentDate.toISOString().split('T')[0];

      let shouldMark = false;

      // Check against rules
      for (const rule of rules) {
        if (rule === 'monday' && dayOfWeek === 1) shouldMark = true;
        if (rule === 'tuesday' && dayOfWeek === 2) shouldMark = true;
        if (rule === 'wednesday' && dayOfWeek === 3) shouldMark = true;
        if (rule === 'thursday' && dayOfWeek === 4) shouldMark = true;
        if (rule === 'friday' && dayOfWeek === 5) shouldMark = true;
        if (rule === 'saturday' && dayOfWeek === 6) shouldMark = true;
        if (rule === 'sunday' && dayOfWeek === 0) shouldMark = true;
        if (rule === 'weekdays' && dayOfWeek >= 1 && dayOfWeek <= 5) shouldMark = true;
        if (rule === 'weekends' && (dayOfWeek === 0 || dayOfWeek === 5 || dayOfWeek === 6)) shouldMark = true;
      }

      if (shouldMark) {
        datesToMark.push(dateStr);
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    console.log('BULK_AVAILABILITY: Generated dates to mark', { count: datesToMark.length });

    // For each date, check if any event already exists
    const created = [];
    const skipped = [];

    for (const date of datesToMark) {
      // Check if ANY event exists on this date
      const existingEventsResult = await dynamodb.query({
        TableName: EVENTS_TABLE,
        IndexName: 'artistId-date-index',
        KeyConditionExpression: 'artistId = :artistId AND #date = :date',
        ExpressionAttributeNames: { '#date': 'date' },
        ExpressionAttributeValues: {
          ':artistId': artistId,
          ':date': date
        }
      }).promise();

      if (existingEventsResult.Items && existingEventsResult.Items.length > 0) {
        skipped.push(date);
        console.log('BULK_AVAILABILITY: Skipping date with existing events', { date });
        continue;
      }

      // Create availability event
      const eventId = crypto.randomUUID();
      const now = new Date().toISOString();

      const newEvent = {
        id: eventId,
        artistId: artistId,
        type: 'available',
        date: date,
        endDate: date,
        isPublic: false,
        isAllDay: true,
        createdAt: now,
        updatedAt: now
      };

      if (notes) newEvent.notes = notes;

      await dynamodb.put({
        TableName: EVENTS_TABLE,
        Item: newEvent
      }).promise();

      created.push(newEvent);
      console.log('BULK_AVAILABILITY: Created availability', { eventId, date });
    }

    console.log('BULK_AVAILABILITY: Completed', { created: created.length, skipped: skipped.length });

    return {
      statusCode: 201,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        created: created.length,
        skipped: skipped.length,
        events: created
      })
    };
  } catch (error) {
    console.error('BULK_AVAILABILITY: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Failed to bulk set availability' })
    };
  }
}

module.exports = {
  handleGetArtistAvailability,
  handleToggleAvailability,
  handleBulkAvailability,
  EVENTS_TABLE
};
