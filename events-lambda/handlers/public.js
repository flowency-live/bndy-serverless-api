/**
 * Public Handlers for Events Lambda
 *
 * Handles public read-only event operations.
 * These endpoints have NO AUTH - they're for public/anonymous access.
 */

const ngeohash = require('ngeohash');
const { stripPrivateFields, EVENTS_TABLE, VENUES_TABLE } = require('../lib/event-data');

// Table constants
const ARTISTS_TABLE = 'bndy-artists';
const USERS_TABLE = 'bndy-users';
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';

/**
 * POST /api/artists/:artistId/conflicts - Check for scheduling conflicts
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 */
async function handleCheckConflicts(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const { artistId } = event.pathParameters;
  const eventData = JSON.parse(event.body);

  // No auth required - public endpoint for conflict checking (read-only operation)
  // Community users need to check conflicts when creating events

  if (!eventData.date) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'date is required for conflict check' })
    };
  }

  const checkDate = eventData.date;
  const endDate = eventData.endDate || eventData.date;
  const isAllDayEvent = eventData.isAllDay || (!eventData.startTime && !eventData.endTime);

  // Query artist events on same date(s)
  const artistEventsResult = await dynamodb.query({
    TableName: EVENTS_TABLE,
    IndexName: 'artistId-date-index',
    KeyConditionExpression: 'artistId = :artistId AND #date BETWEEN :start AND :end',
    ExpressionAttributeNames: { '#date': 'date' },
    ExpressionAttributeValues: {
      ':artistId': artistId,
      ':start': checkDate,
      ':end': endDate
    }
  }).promise();

  // Get all band members to check their unavailability
  const membershipsResult = await dynamodb.query({
    TableName: MEMBERSHIPS_TABLE,
    IndexName: 'artist_id-index',
    KeyConditionExpression: 'artist_id = :artistId',
    ExpressionAttributeValues: { ':artistId': artistId }
  }).promise();

  const memberUserIds = (membershipsResult.Items || []).map(m => m.user_id);

  console.log('CONFLICTS: Checking unavailability for band members', { memberUserIds });

  // Query unavailability for ALL band members
  let allMemberUnavailability = [];
  if (memberUserIds.length > 0) {
    const unavailabilityPromises = memberUserIds.map(userId =>
      dynamodb.query({
        TableName: EVENTS_TABLE,
        IndexName: 'ownerUserId-date-index',
        KeyConditionExpression: 'ownerUserId = :userId AND #date BETWEEN :start AND :end',
        ExpressionAttributeNames: { '#date': 'date' },
        ExpressionAttributeValues: {
          ':userId': userId,
          ':start': checkDate,
          ':end': endDate
        }
      }).promise()
    );

    const unavailabilityResults = await Promise.all(unavailabilityPromises);
    allMemberUnavailability = unavailabilityResults.flatMap(result => result.Items || []);
  }

  let allEvents = [...(artistEventsResult.Items || []), ...allMemberUnavailability];

  // Exclude the event being edited (if provided)
  if (eventData.excludeEventId) {
    allEvents = allEvents.filter(e => e.id !== eventData.excludeEventId);
    console.log('CONFLICTS: Excluding event being edited', { excludeEventId: eventData.excludeEventId });
  }

  console.log('CONFLICTS: Found events', {
    artistEvents: artistEventsResult.Items?.length || 0,
    memberUnavailability: allMemberUnavailability.length,
    total: allEvents.length
  });

  // Conflict detection logic
  const conflicts = allEvents.filter(e => {
    // All-day events conflict with anything on the same date
    if (e.isAllDay || isAllDayEvent) return true;

    // If either event has no times, no conflict (shouldn't happen but safe)
    if (!e.startTime || !e.endTime || !eventData.startTime || !eventData.endTime) return false;

    // Time overlap check
    return (
      (eventData.startTime >= e.startTime && eventData.startTime < e.endTime) ||
      (eventData.endTime > e.startTime && eventData.endTime <= e.endTime) ||
      (eventData.startTime <= e.startTime && eventData.endTime >= e.endTime)
    );
  });

  console.log('CONFLICTS: Detected conflicts', { count: conflicts.length });

  // Enrich unavailability conflicts with user display names
  const enrichedConflicts = await Promise.all(conflicts.map(async (conflict) => {
    if (conflict.type === 'unavailable' && conflict.ownerUserId) {
      try {
        const userResult = await dynamodb.get({
          TableName: USERS_TABLE,
          Key: { cognito_id: conflict.ownerUserId }
        }).promise();

        if (userResult.Item) {
          const displayName = userResult.Item.display_name || userResult.Item.username || 'Unknown User';
          console.log('CONFLICTS: Enriched unavailability', {
            userId: conflict.ownerUserId,
            displayName
          });
          return {
            ...conflict,
            displayName
          };
        }
      } catch (error) {
        console.error('CONFLICTS: Failed to fetch user display name:', error);
      }
    }
    return conflict;
  }));

  return {
    statusCode: 200,
    headers: getCorsHeaders(event),
    body: JSON.stringify({
      hasConflicts: enrichedConflicts.length > 0,
      conflicts: enrichedConflicts
    })
  };
}

/**
 * GET /api/events/geo - Get public events by geohash (NO AUTH)
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 */
async function handleGetPublicEventsGeo(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const { geohash, startDate, endDate } = event.queryStringParameters || {};

  if (!geohash || !startDate || !endDate) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'geohash, startDate, and endDate required' })
    };
  }

  console.log('PUBLIC_GEO: Query received', { geohash, startDate, endDate });

  // Get 8 neighboring geohashes (returns array [n, ne, e, se, s, sw, w, nw])
  const neighbors = ngeohash.neighbors(geohash);
  const allGeohashes = [geohash, ...neighbors];

  console.log('PUBLIC_GEO: Querying 9 geohashes', { center: geohash, neighbors: allGeohashes.slice(1) });

  // Query all 9 geohashes in parallel
  const queryPromises = allGeohashes.map(gh =>
    dynamodb.query({
      TableName: EVENTS_TABLE,
      IndexName: 'geohash6-date-index',
      KeyConditionExpression: 'geohash6 = :geohash AND #date BETWEEN :start AND :end',
      FilterExpression: 'isPublic = :isPublic',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: {
        ':geohash': gh,
        ':start': startDate,
        ':end': endDate,
        ':isPublic': true
      }
    }).promise()
  );

  const results = await Promise.all(queryPromises);
  const allEvents = results.flatMap(result => result.Items || []);

  console.log('PUBLIC_GEO: Found events', { count: allEvents.length });

  // Return lightweight event list (frontend will batch fetch full details)
  const lightweightEvents = allEvents.map(e => ({
    id: e.id,
    artistId: e.artistId,
    venueId: e.venueId,
    date: e.date,
    geoLat: e.geoLat,
    geoLng: e.geoLng
  }));

  return {
    statusCode: 200,
    headers: getCorsHeaders(event),
    body: JSON.stringify({ events: lightweightEvents })
  };
}

/**
 * POST /api/events/batch - Batch fetch with joins (NO AUTH)
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 */
async function handleBatchEventsWithJoins(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const { eventIds } = JSON.parse(event.body || '{}');

  if (!eventIds || !Array.isArray(eventIds) || eventIds.length === 0) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'eventIds array required' })
    };
  }

  if (eventIds.length > 100) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Maximum 100 events per batch' })
    };
  }

  console.log('BATCH_EVENTS: Fetching events', { count: eventIds.length });

  // Batch get events
  const eventPromises = eventIds.map(id =>
    dynamodb.get({
      TableName: EVENTS_TABLE,
      Key: { id }
    }).promise()
  );

  const eventResults = await Promise.all(eventPromises);
  const events = eventResults.map(r => r.Item).filter(Boolean);

  // Collect unique artistIds and venueIds
  const artistIds = [...new Set(events.map(e => e.artistId).filter(Boolean))];
  const venueIds = [...new Set(events.map(e => e.venueId).filter(Boolean))];

  console.log('BATCH_EVENTS: Fetching joins', { artistIds: artistIds.length, venueIds: venueIds.length });

  // Batch get artists
  const artistPromises = artistIds.map(id =>
    dynamodb.get({
      TableName: ARTISTS_TABLE,
      Key: { id }
    }).promise()
  );

  // Batch get venues
  const venuePromises = venueIds.map(id =>
    dynamodb.get({
      TableName: VENUES_TABLE,
      Key: { id }
    }).promise()
  );

  const [artistResults, venueResults] = await Promise.all([
    Promise.all(artistPromises),
    Promise.all(venuePromises)
  ]);

  // Build lookup maps
  const artistMap = {};
  artistResults.forEach((result, idx) => {
    if (result.Item) {
      artistMap[artistIds[idx]] = result.Item;
    }
  });

  const venueMap = {};
  venueResults.forEach((result, idx) => {
    if (result.Item) {
      venueMap[venueIds[idx]] = result.Item;
    }
  });

  // Join events with artist and venue data
  const enrichedEvents = events.map(e => ({
    ...e,
    artist: e.artistId && artistMap[e.artistId] ? {
      id: artistMap[e.artistId].id,
      name: artistMap[e.artistId].name,
      genres: artistMap[e.artistId].genres,
      profileImageUrl: artistMap[e.artistId].profileImageUrl
    } : null,
    venue: e.venueId && venueMap[e.venueId] ? {
      id: venueMap[e.venueId].id,
      name: venueMap[e.venueId].name,
      address: venueMap[e.venueId].address,
      city: venueMap[e.venueId].city,
      latitude: venueMap[e.venueId].latitude,
      longitude: venueMap[e.venueId].longitude
    } : null
  }));

  console.log('BATCH_EVENTS: Returning enriched events', { count: enrichedEvents.length });

  return {
    statusCode: 200,
    headers: getCorsHeaders(event),
    body: JSON.stringify({ events: enrichedEvents })
  };
}

/**
 * GET /api/venues/:venueId/events - Get venue events (NO AUTH)
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 */
async function handleGetVenueEvents(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const { venueId } = event.pathParameters;
  const { startDate, endDate } = event.queryStringParameters || {};

  if (!startDate || !endDate) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'startDate and endDate required' })
    };
  }

  console.log('VENUE_EVENTS: Query received', { venueId, startDate, endDate });

  // Query events by venueId
  const result = await dynamodb.query({
    TableName: EVENTS_TABLE,
    IndexName: 'venueId-date-index',
    KeyConditionExpression: 'venueId = :venueId AND #date BETWEEN :start AND :end',
    FilterExpression: 'isPublic = :isPublic',
    ExpressionAttributeNames: { '#date': 'date' },
    ExpressionAttributeValues: {
      ':venueId': venueId,
      ':start': startDate,
      ':end': endDate,
      ':isPublic': true
    }
  }).promise();

  const events = result.Items || [];

  console.log('VENUE_EVENTS: Found events', { count: events.length });

  // Collect unique artistIds
  const artistIds = [...new Set(events.map(e => e.artistId).filter(Boolean))];

  // Batch get artists
  const artistPromises = artistIds.map(id =>
    dynamodb.get({
      TableName: ARTISTS_TABLE,
      Key: { id }
    }).promise()
  );

  const artistResults = await Promise.all(artistPromises);

  // Build artist lookup map
  const artistMap = {};
  artistResults.forEach((result, idx) => {
    if (result.Item) {
      artistMap[artistIds[idx]] = result.Item;
    }
  });

  // Join events with artist data
  const enrichedEvents = events.map(e => ({
    ...e,
    artist: e.artistId && artistMap[e.artistId] ? {
      id: artistMap[e.artistId].id,
      name: artistMap[e.artistId].name,
      genres: artistMap[e.artistId].genres,
      profileImageUrl: artistMap[e.artistId].profileImageUrl
    } : null
  }));

  return {
    statusCode: 200,
    headers: getCorsHeaders(event),
    body: JSON.stringify({ events: enrichedEvents })
  };
}

/**
 * GET /api/events/public - Get ALL public events in date range (NO AUTH)
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 */
async function handleGetAllPublicEvents(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const { startDate, endDate } = event.queryStringParameters || {};

  // Default to today if no startDate provided
  const today = new Date().toISOString().split('T')[0];
  const start = startDate || today;
  const end = endDate || '2099-12-31';

  console.log('PUBLIC_ALL: Query received', { startDate: start, endDate: end });

  try {
    // Scan table with FilterExpression, handling pagination for large result sets
    // DynamoDB returns max 1MB per scan - must paginate to get all results
    const allEvents = [];
    let lastEvaluatedKey;

    do {
      const scanParams = {
        TableName: EVENTS_TABLE,
        FilterExpression: 'isPublic = :true AND #date BETWEEN :start AND :end',
        ExpressionAttributeNames: { '#date': 'date' },
        ExpressionAttributeValues: {
          ':true': true,
          ':start': start,
          ':end': end
        }
      };

      if (lastEvaluatedKey) {
        scanParams.ExclusiveStartKey = lastEvaluatedKey;
      }

      const result = await dynamodb.scan(scanParams).promise();
      allEvents.push(...(result.Items || []));
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    console.log('PUBLIC_ALL: Found events', { count: allEvents.length });

    // Collect ALL artist IDs (primary + collaborating) for enrichment
    const allArtistIds = new Set();
    allEvents.forEach(e => {
      if (e.artistId) allArtistIds.add(e.artistId);
      if (e.collaboratingArtistIds && Array.isArray(e.collaboratingArtistIds)) {
        e.collaboratingArtistIds.forEach(id => allArtistIds.add(id));
      }
    });
    const artistIds = [...allArtistIds];
    const venueIds = [...new Set(allEvents.map(e => e.venueId).filter(Boolean))];

    const [artistResults, venueResults] = await Promise.all([
      Promise.all(artistIds.map(id => dynamodb.get({ TableName: ARTISTS_TABLE, Key: { id } }).promise())),
      Promise.all(venueIds.map(id => dynamodb.get({ TableName: VENUES_TABLE, Key: { id } }).promise()))
    ]);

    // Build lookup maps
    const artistMap = {};
    artistResults.forEach((result, idx) => {
      if (result.Item) artistMap[artistIds[idx]] = result.Item;
    });

    const venueMap = {};
    venueResults.forEach((result, idx) => {
      if (result.Item) venueMap[venueIds[idx]] = result.Item;
    });

    // Join events with artist and venue data, including multi-artist arrays
    // Strip private fee fields for public endpoint
    const enrichedEvents = allEvents.map(e => {
      const sanitizedEvent = stripPrivateFields(e);
      // Build full artistIds array (primary + collaborating)
      const eventArtistIds = sanitizedEvent.artistId ? [sanitizedEvent.artistId] : [];
      if (sanitizedEvent.collaboratingArtistIds && Array.isArray(sanitizedEvent.collaboratingArtistIds)) {
        eventArtistIds.push(...sanitizedEvent.collaboratingArtistIds);
      }
      // Build artistNames array from artistIds
      const eventArtistNames = eventArtistIds.map(id => artistMap[id]?.name).filter(Boolean);

      return {
        ...sanitizedEvent,
        artistName: artistMap[sanitizedEvent.artistId]?.name,
        artistIds: eventArtistIds.length > 0 ? eventArtistIds : undefined,
        artistNames: eventArtistNames.length > 0 ? eventArtistNames : undefined,
        venueName: venueMap[sanitizedEvent.venueId]?.name,
        venue: venueMap[sanitizedEvent.venueId] ? {
          city: venueMap[sanitizedEvent.venueId].city
        } : null
      };
    });

    console.log('PUBLIC_ALL: Enriched events with artist and venue data');

    // Return full event data (clustering on client will handle display)
    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ events: enrichedEvents })
    };
  } catch (error) {
    console.error('PUBLIC_ALL: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Failed to fetch events' })
    };
  }
}

/**
 * GET /api/artists/:artistId/public-events - Get public events for an artist (NO AUTH)
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 */
async function handleGetArtistPublicEvents(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;

  console.log('ARTIST_PUBLIC_EVENTS: Handler invoked', { pathParameters: event.pathParameters, queryStringParameters: event.queryStringParameters });

  if (!event.pathParameters || !event.pathParameters.artistId) {
    console.error('ARTIST_PUBLIC_EVENTS: Missing artistId in pathParameters');
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

  console.log('ARTIST_PUBLIC_EVENTS: Query received', { artistId, startDate: start, endDate: end });

  try {
    // Query events where this artist is the PRIMARY artist (using GSI)
    const primaryResult = await dynamodb.query({
      TableName: EVENTS_TABLE,
      IndexName: 'artistId-date-index',
      KeyConditionExpression: 'artistId = :artistId AND #date BETWEEN :start AND :end',
      FilterExpression: 'isPublic = :true',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':start': start,
        ':end': end,
        ':true': true
      }
    }).promise();

    const primaryEvents = primaryResult.Items || [];
    console.log('ARTIST_PUBLIC_EVENTS: Found primary events', { artistId, count: primaryEvents.length });

    // Scan for events where this artist is COLLABORATING (multi-artist support)
    const collaboratingResult = await dynamodb.scan({
      TableName: EVENTS_TABLE,
      FilterExpression: 'isPublic = :true AND #date BETWEEN :start AND :end AND contains(collaboratingArtistIds, :artistId)',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':start': start,
        ':end': end,
        ':true': true
      }
    }).promise();

    const collaboratingEvents = collaboratingResult.Items || [];
    console.log('ARTIST_PUBLIC_EVENTS: Found collaborating events', { artistId, count: collaboratingEvents.length });

    // Combine and deduplicate events
    const eventMap = new Map();
    [...primaryEvents, ...collaboratingEvents].forEach(e => {
      if (!eventMap.has(e.id)) {
        eventMap.set(e.id, e);
      }
    });
    const events = Array.from(eventMap.values());

    console.log('ARTIST_PUBLIC_EVENTS: Total unique events', { artistId, count: events.length });

    // Enrich events with venue data
    const venueIds = [...new Set(events.map(e => e.venueId).filter(Boolean))];
    const venuePromises = venueIds.map(id =>
      dynamodb.get({
        TableName: VENUES_TABLE,
        Key: { id }
      }).promise()
    );

    const venueResults = await Promise.all(venuePromises);

    // Build venue lookup map
    const venueMap = {};
    venueResults.forEach((result, idx) => {
      if (result.Item) {
        venueMap[venueIds[idx]] = result.Item;
      }
    });

    // Join events with venue data
    // Strip private fee fields for public endpoint
    const enrichedEvents = events.map(e => {
      const sanitizedEvent = stripPrivateFields(e);
      const venue = venueMap[sanitizedEvent.venueId];
      return {
        ...sanitizedEvent,
        venueName: venue?.name || sanitizedEvent.venueName || 'Unknown Venue',
        venueCity: venue?.city || null
      };
    });

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ events: enrichedEvents })
    };
  } catch (error) {
    console.error('ARTIST_PUBLIC_EVENTS: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Failed to fetch artist events' })
    };
  }
}

module.exports = {
  handleCheckConflicts,
  handleGetPublicEventsGeo,
  handleBatchEventsWithJoins,
  handleGetVenueEvents,
  handleGetAllPublicEvents,
  handleGetArtistPublicEvents,
  EVENTS_TABLE,
  VENUES_TABLE,
  ARTISTS_TABLE,
  USERS_TABLE,
  MEMBERSHIPS_TABLE
};
