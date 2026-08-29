/**
 * Availability Handlers for Events Lambda
 *
 * Handles artist availability management.
 * Some endpoints require auth (toggle, bulk), others are public (get).
 */

const crypto = require('crypto');

// Table constants
const EVENTS_TABLE = 'bndy-events';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UK_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function ukToday() {
  return UK_DATE.format(new Date());
}

function addUtcDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split('T')[0];
}

function isValidIsoDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().split('T')[0] === value;
}

function normaliseRange(startDate, endDate) {
  const today = ukToday();
  const start = startDate || today;
  if (!isValidIsoDate(start)) return { error: 'A valid startDate and endDate are required' };
  const end = endDate || addUtcDays(start, 180);
  if (!isValidIsoDate(end) || end < start) {
    return { error: 'A valid startDate and endDate are required' };
  }
  const rangeDays = Math.round((new Date(`${end}T00:00:00.000Z`) - new Date(`${start}T00:00:00.000Z`)) / 86400000);
  if (rangeDays > 366) return { error: 'Availability range cannot exceed 366 days' };
  return { start, end };
}

function isBusyArtistEvent(event) {
  if (!event || event.type === 'available') return false;
  if (event.cancelled === true || event.canceled === true) return false;
  if (event.hidden === true || event.deleted === true) return false;
  if (['cancelled', 'canceled', 'deleted'].includes(String(event.status || '').toLowerCase())) return false;
  return true;
}

async function queryArtistRange(dynamodb, artistId, start, end, availableOnly = false) {
  const params = {
    TableName: EVENTS_TABLE,
    IndexName: 'artistId-date-index',
    KeyConditionExpression: 'artistId = :artistId AND #date BETWEEN :start AND :end',
    ExpressionAttributeNames: { '#date': 'date' },
    ExpressionAttributeValues: {
      ':artistId': artistId,
      ':start': start,
      ':end': end
    }
  };
  if (availableOnly) {
    params.FilterExpression = '#type = :available';
    params.ExpressionAttributeNames['#type'] = 'type';
    params.ExpressionAttributeValues[':available'] = 'available';
  }
  const items = [];
  let lastKey;
  do {
    const result = await dynamodb.query({ ...params, ...(lastKey ? { ExclusiveStartKey: lastKey } : {}) }).promise();
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

function weekendDates(start, end) {
  const dates = [];
  for (let date = start; date <= end; date = addUtcDays(date, 1)) {
    const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (day === 0 || day === 5 || day === 6) dates.push(date);
  }
  return dates;
}

async function hasActiveMembership(dynamodb, user, artistId) {
  if (user.platformAdmin) return true;
  const result = await dynamodb.query({
    TableName: 'bndy-artist-memberships',
    IndexName: 'user_id-index',
    KeyConditionExpression: 'user_id = :userId',
    FilterExpression: 'artist_id = :artistId',
    ExpressionAttributeValues: {
      ':userId': user.userId,
      ':artistId': artistId
    }
  }).promise();
  return (result.Items || []).some((membership) => membership.status === 'active');
}

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
  const range = normaliseRange(
    event.queryStringParameters?.startDate,
    event.queryStringParameters?.endDate
  );
  if (range.error) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: range.error })
    };
  }
  const { start, end } = range;

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
      const candidates = weekendDates(start, end);
      if (candidates.length > 0) {
        const rangeEvents = await queryArtistRange(dynamodb, artistId, start, end);
        const busyDates = new Set(rangeEvents.filter(isBusyArtistEvent).map((item) => item.date));
        availability = candidates
          .filter((date) => !busyDates.has(date))
          .map((date) => ({
            id: `free-${date}`,
            artistId,
            date,
            type: 'free_weekend',
            notes: 'Free weekend day'
          }));
      }
      console.log('ARTIST_AVAILABILITY: Free weekends found', { artistId, count: availability.length });
    } else {
      availability = await queryArtistRange(dynamodb, artistId, start, end, true);
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
 * GET /api/artists/:artistId/availability - Get saved availability for editing
 * even when the public publishing switch is off.
 */
async function handleGetManagedArtistAvailability(deps, event, user) {
  const { dynamodb, getCorsHeaders } = deps;
  const artistId = event.pathParameters?.artistId;
  if (!artistId) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'artistId is required' })
    };
  }

  if (!(await hasActiveMembership(dynamodb, user, artistId))) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Active artist membership required' })
    };
  }

  const range = normaliseRange(
    event.queryStringParameters?.startDate,
    event.queryStringParameters?.endDate
  );
  if (range.error) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: range.error })
    };
  }

  try {
    const events = await queryArtistRange(dynamodb, artistId, range.start, range.end);
    const availability = events
      .filter((item) => item.type === 'available')
      .sort((a, b) => a.date.localeCompare(b.date));
    const busyDates = [...new Set(events.filter(isBusyArtistEvent).map((item) => item.date))].sort();
    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ availability, busyDates })
    };
  } catch (error) {
    console.error('MANAGED_ARTIST_AVAILABILITY: Error:', error);
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

  if (!(await hasActiveMembership(dynamodb, user, artistId))) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Active artist membership required' })
    };
  }

  // Validate date is provided
  if (!date || !isValidIsoDate(date)) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Valid date in YYYY-MM-DD format is required' })
    };
  }

  // Validate date is in the future or today
  const today = ukToday();
  if (date < today) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Cannot mark past dates as available' })
    };
  }

  try {
    // Read every artist event on the date. Existing availability toggles off;
    // a real booking blocks a new availability marker.
    const existingResult = await dynamodb.query({
      TableName: EVENTS_TABLE,
      IndexName: 'artistId-date-index',
      KeyConditionExpression: 'artistId = :artistId AND #date = :date',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':date': date
      }
    }).promise();

    const dateEvents = existingResult.Items || [];
    const existing = dateEvents.find((item) => item.type === 'available');

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
      if (dateEvents.some(isBusyArtistEvent)) {
        return {
          statusCode: 409,
          headers: getCorsHeaders(event),
          body: JSON.stringify({ error: 'This date already has an artist event', code: 'DATE_BUSY' })
        };
      }

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

  if (!(await hasActiveMembership(dynamodb, user, artistId))) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Active artist membership required' })
    };
  }

  // Validate required fields
  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate) || !rules || !Array.isArray(rules) || rules.length === 0) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'startDate, endDate, and rules array are required' })
    };
  }

  // Validate date range
  const today = ukToday();
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
  handleGetManagedArtistAvailability,
  handleToggleAvailability,
  handleBulkAvailability,
  isBusyArtistEvent,
  normaliseRange,
  weekendDates,
  EVENTS_TABLE
};
