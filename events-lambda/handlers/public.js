/**
 * Public Handlers for Events Lambda
 *
 * Handles public event operations (read-only + community creation).
 * Most endpoints have NO AUTH - they're for public/anonymous access.
 * handleCreatePublicGig requires auth.
 */

const crypto = require('crypto');
const ngeohash = require('ngeohash');
const { stripPrivateFields, EVENTS_TABLE, VENUES_TABLE, getVenue, checkForDuplicateEvent, checkForDuplicateByExternalId, ensureVenueRelationship, putEventGated } = require('../lib/event-data');
const { duplicateResponseBody } = require('../lib/unique-gate');
const { resolveTicketing } = require('./ticketing-resolution');
const { computeGeohashFields } = require('../lib/geohash');
const { parseBbox, validateDateWindow, planBboxQuery, GH6_INDEX } = require('../lib/geo-query');
const { verifyMembership } = require('../lib/auth');
const { hasPrivilegedIngestionFields, validateScopedIngestion, editionMetadata } = require('../lib/edition-domain');
const { triggerNotification } = require('../lib/notifications');
const { jsonResponse } = require('../lib/http-response');
const { batchGetByIds } = require('../lib/batch-get');
const { scanAll } = require('../lib/scan-all');
const { DEFAULT_END_TIME } = require('../lib/event-defaults');
const { isPublishedInEdition } = require('../lib/edition-domain');

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
  const { geohash, bbox: rawBbox, startDate, endDate } = event.queryStringParameters || {};
  const corsHeaders = getCorsHeaders(event);
  const bad = (msg) => ({ statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: msg }) });

  if (!rawBbox && !geohash) return bad('bbox (west,south,east,north) or geohash required');
  const dateErr = validateDateWindow(startDate, endDate);
  if (dateErr.error) return bad(dateErr.error);

  let plan;
  if (rawBbox) {
    const parsed = parseBbox(rawBbox);
    if (parsed.error) return bad(parsed.error);
    plan = planBboxQuery(parsed.bbox);
    console.log('PUBLIC_GEO: bbox query', { bbox: rawBbox, precision: plan.precision || 'fallback', cells: plan.cells ? plan.cells.length : 0 });
  } else {
    // Deprecated path: centre + 8 neighbours at gh6. Kept for existing clients.
    plan = { precision: 6, indexName: GH6_INDEX, hashAttr: 'geohash6', cells: [geohash, ...ngeohash.neighbors(geohash)] };
    console.log('PUBLIC_GEO: legacy geohash query', { geohash });
  }

  let items;
  let truncated = false;
  if (plan.fallback) {
    // Country-scale viewport: never fan out hundreds of cell queries.
    // Serve the whole-window public dataset; the shared 60s cache absorbs it.
    truncated = true;
    items = await scanAll(dynamodb, {
      TableName: EVENTS_TABLE,
      FilterExpression: 'isPublic = :true AND #date BETWEEN :start AND :end',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: { ':true': true, ':start': startDate, ':end': endDate }
    });
  } else {
    const results = await Promise.all(plan.cells.map(gh =>
      dynamodb.query({
        TableName: EVENTS_TABLE,
        IndexName: plan.indexName,
        KeyConditionExpression: `${plan.hashAttr} = :gh AND #date BETWEEN :start AND :end`,
        FilterExpression: 'isPublic = :true',
        ExpressionAttributeNames: { '#date': 'date' },
        ExpressionAttributeValues: { ':gh': gh, ':start': startDate, ':end': endDate, ':true': true }
      }).promise()
    ));
    items = results.flatMap(r => r.Items || []);
  }

  // Lightweight shape — enough for map pins; details via POST /api/events/batch.
  const events = items.filter(e => e.hidden !== true && isPublishedInEdition(e, 'live')).map(e => ({
    id: e.id, artistId: e.artistId, venueId: e.venueId,
    date: e.date, startTime: e.startTime, geoLat: e.geoLat, geoLng: e.geoLng,
    ticketed: !!e.ticketed,
    // Feature 7: only present when the GSI projects it — MapView joins the
    // full gigs cache as the fallback, same pattern as `ticketed`.
    cancelled: !!e.cancelled
  }));

  console.log('PUBLIC_GEO: Found events', { count: events.length, truncated });
  return jsonResponse(event, 200, { events, truncated }, { corsHeaders, cacheControl: 'public, max-age=60' });
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

  // Batch get events (BatchGetItem, chunks of 25)
  const eventsById = await batchGetByIds(dynamodb, EVENTS_TABLE, eventIds);
  const events = eventIds.map(id => eventsById[id]).filter(e =>
    e && e.isPublic === true && e.hidden !== true && isPublishedInEdition(e, 'live')
  );

  // Collect unique artistIds (primary + collaborating) and venueIds
  const allArtistIds = new Set();
  events.forEach(e => {
    if (e.artistId) allArtistIds.add(e.artistId);
    if (Array.isArray(e.collaboratingArtistIds)) {
      e.collaboratingArtistIds.forEach(id => allArtistIds.add(id));
    }
  });
  const artistIds = [...allArtistIds];
  const venueIds = [...new Set(events.map(e => e.venueId).filter(Boolean))];

  console.log('BATCH_EVENTS: Fetching joins', { artistIds: artistIds.length, venueIds: venueIds.length });

  // Batch get artists and venues (BatchGetItem, chunks of 25)
  const [artistMap, venueMap] = await Promise.all([
    batchGetByIds(dynamodb, ARTISTS_TABLE, artistIds),
    batchGetByIds(dynamodb, VENUES_TABLE, venueIds)
  ]);

  // Join events with artist, venue, and resolved ticketing data.
  // Flat fields (artistName, artistIds, artistNames, venueName) match the
  // GET /api/events/public contract so every consumer maps events identically.
  // The nested artist/venue objects stay for existing consumers.
  const enrichedEvents = events.map(e => {
    const sanitizedEvent = stripPrivateFields(e);
    const venue = sanitizedEvent.venueId ? venueMap[sanitizedEvent.venueId] : null;
    const ticketing = resolveTicketing(e, venue);

    // Build full artistIds array (primary + collaborating)
    const eventArtistIds = sanitizedEvent.artistId ? [sanitizedEvent.artistId] : [];
    if (Array.isArray(sanitizedEvent.collaboratingArtistIds)) {
      eventArtistIds.push(...sanitizedEvent.collaboratingArtistIds);
    }
    // Build artistNames array parallel to artistIds
    const eventArtistNames = eventArtistIds.map(id => artistMap[id]?.name).filter(Boolean);

    return {
      ...sanitizedEvent,
      artistName: sanitizedEvent.artistId ? artistMap[sanitizedEvent.artistId]?.name : undefined,
      artistIds: eventArtistIds.length > 0 ? eventArtistIds : undefined,
      artistNames: eventArtistNames.length > 0 ? eventArtistNames : undefined,
      venueName: venue?.name,
      artist: sanitizedEvent.artistId && artistMap[sanitizedEvent.artistId] ? {
        id: artistMap[sanitizedEvent.artistId].id,
        name: artistMap[sanitizedEvent.artistId].name,
        genres: artistMap[sanitizedEvent.artistId].genres,
        profileImageUrl: artistMap[sanitizedEvent.artistId].profileImageUrl
      } : null,
      venue: venue ? {
        id: venue.id,
        name: venue.name,
        address: venue.address,
        city: venue.city,
        latitude: venue.latitude,
        longitude: venue.longitude,
        standardTicketed: venue.standardTicketed,
        standardTicketUrl: venue.standardTicketUrl
      } : null,
      ticketing
    };
  });

  console.log('BATCH_EVENTS: Returning enriched events', { count: enrichedEvents.length });

  return jsonResponse(event, 200, { events: enrichedEvents }, {
    corsHeaders: getCorsHeaders(event)
  });
}

/**
 * GET /api/venues/:venueId/events - Get venue events (NO AUTH)
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 */
async function handleGetVenueEvents(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const { venueId } = event.pathParameters;
  const { startDate } = event.queryStringParameters || {};
  const start = startDate || new Date().toISOString().split('T')[0];

  console.log('VENUE_EVENTS: Query received', { venueId, startDate: start });

  // Query all public events for the venue from startDate onwards.
  // There is deliberately no end date for an upcoming-events feed.
  const result = await dynamodb.query({
    TableName: EVENTS_TABLE,
    IndexName: 'venueId-date-index',
    KeyConditionExpression: 'venueId = :venueId AND #date >= :start',
    FilterExpression: 'isPublic = :isPublic',
    ExpressionAttributeNames: { '#date': 'date' },
    ExpressionAttributeValues: {
      ':venueId': venueId,
      ':start': start,
      ':isPublic': true
    }
  }).promise();

  const events = (result.Items || []).filter(e => e.hidden !== true && isPublishedInEdition(e, 'live'));

  console.log('VENUE_EVENTS: Found events', { count: events.length });

  // Collect unique artistIds
  const artistIds = [...new Set(events.map(e => e.artistId).filter(Boolean))];

  // Batch get artists and venue (BatchGetItem, chunks of 25)
  const [artistMap, venueResult] = await Promise.all([
    batchGetByIds(dynamodb, ARTISTS_TABLE, artistIds),
    dynamodb.get({ TableName: VENUES_TABLE, Key: { id: venueId } }).promise()
  ]);
  const venue = venueResult.Item || null;

  // Join events with artist data and resolved ticketing
  const enrichedEvents = events.map(e => {
    const ticketing = resolveTicketing(e, venue);
    return {
      ...e,
      artist: e.artistId && artistMap[e.artistId] ? {
        id: artistMap[e.artistId].id,
        name: artistMap[e.artistId].name,
        genres: artistMap[e.artistId].genres,
        profileImageUrl: artistMap[e.artistId].profileImageUrl
      } : null,
      // ⚠ Normalise provenance to camelCase. DynamoDB stores `external_ids`; these public
      // endpoints spread the raw item, so consumers reading `externalIds` saw undefined and
      // defaulted it to []. That reads as "this event has no provenance" rather than
      // "this endpoint did not tell you", and edit_event REPLACES externalIds — so a caller
      // acting on the empty array destroys the real id. Additive: `external_ids` is untouched.
      externalIds: e.external_ids || e.externalIds || [],
      ticketing
    };
  });

  return jsonResponse(event, 200, { events: enrichedEvents }, {
    corsHeaders: getCorsHeaders(event),
    cacheControl: 'public, max-age=60'
  });
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
      allEvents.push(...(result.Items || []).filter(e => e.hidden !== true && isPublishedInEdition(e, 'live')));
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

    // Batch get artists and venues (BatchGetItem, chunks of 25)
    const [artistMap, venueMap] = await Promise.all([
      batchGetByIds(dynamodb, ARTISTS_TABLE, artistIds),
      batchGetByIds(dynamodb, VENUES_TABLE, venueIds)
    ]);

    // Join events with artist and venue data, including multi-artist arrays
    // Strip private fee fields for public endpoint
    const enrichedEvents = allEvents.map(e => {
      const sanitizedEvent = stripPrivateFields(e);
      const venue = sanitizedEvent.venueId ? venueMap[sanitizedEvent.venueId] : null;
      const ticketing = resolveTicketing(e, venue);

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
        venueName: venue?.name,
        venue: venue ? {
          city: venue.city
        } : null,
        ticketing
      };
    });

    console.log('PUBLIC_ALL: Enriched events with artist and venue data');

    // Return full event data (clustering on client will handle display)
    return jsonResponse(event, 200, { events: enrichedEvents }, {
      corsHeaders: getCorsHeaders(event),
      cacheControl: 'public, max-age=60'
    });
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
    const collaboratingEvents = await scanAll(dynamodb, {
      TableName: EVENTS_TABLE,
      FilterExpression: 'isPublic = :true AND #date BETWEEN :start AND :end AND contains(collaboratingArtistIds, :artistId)',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':start': start,
        ':end': end,
        ':true': true
      }
    });
    console.log('ARTIST_PUBLIC_EVENTS: Found collaborating events', { artistId, count: collaboratingEvents.length });

    // Combine and deduplicate events
    const eventMap = new Map();
    [...primaryEvents, ...collaboratingEvents].forEach(e => {
      if (!eventMap.has(e.id)) {
        eventMap.set(e.id, e);
      }
    });
    const events = Array.from(eventMap.values()).filter(e => e.hidden !== true && isPublishedInEdition(e, 'live'));

    console.log('ARTIST_PUBLIC_EVENTS: Total unique events', { artistId, count: events.length });

    // Enrich events with venue data (BatchGetItem, chunks of 25)
    const venueIds = [...new Set(events.map(e => e.venueId).filter(Boolean))];
    const venueMap = await batchGetByIds(dynamodb, VENUES_TABLE, venueIds);

    // Join events with venue data and resolved ticketing
    // Strip private fee fields for public endpoint
    const enrichedEvents = events.map(e => {
      const sanitizedEvent = stripPrivateFields(e);
      const venue = venueMap[sanitizedEvent.venueId] || null;
      const ticketing = resolveTicketing(e, venue);
      return {
        ...sanitizedEvent,
        venueName: venue?.name || sanitizedEvent.venueName || 'Unknown Venue',
        venueCity: venue?.city || null,
      // ⚠ Normalise provenance to camelCase. DynamoDB stores `external_ids`; these public
      // endpoints spread the raw item, so consumers reading `externalIds` saw undefined and
      // defaulted it to []. That reads as "this event has no provenance" rather than
      // "this endpoint did not tell you", and edit_event REPLACES externalIds — so a caller
      // acting on the empty array destroys the real id. Additive: `external_ids` is untouched.
      externalIds: e.external_ids || e.externalIds || [],
        ticketing
      };
    });

    return jsonResponse(event, 200, { events: enrichedEvents }, {
      corsHeaders: getCorsHeaders(event),
      cacheControl: 'public, max-age=60'
    });
  } catch (error) {
    console.error('ARTIST_PUBLIC_EVENTS: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Failed to fetch artist events' })
    };
  }
}

/**
 * POST /api/artists/:artistId/public-gigs/create - Create public gig with venue resolution
 * REQUIRES AUTH - user must be platform admin or member of artist
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders, lambda }
 * @param {Object} event - Lambda event
 * @param {Object} user - Authenticated user
 */
async function handleCreatePublicGig(deps, event, user) {
  const { dynamodb, getCorsHeaders, lambda } = deps;
  const { artistId } = event.pathParameters;
  const gigData = JSON.parse(event.body);

  console.log('PUBLIC_GIG: Create request', { artistId, gigData });

  // Check access - platform admin OR member
  let membership = null;
  if (!user.platformAdmin) {
    membership = await verifyMembership(dynamodb, user.userId, artistId);
    if (!membership) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'Not a member of this artist' })
      };
    }
  } else {
    console.log('[EVENTS] Platform admin access granted for public gig creation');
    // Create a minimal membership object for compatibility
    membership = { user_id: user.userId, artist_id: artistId, membership_id: 'platform-admin' };
  }

  // Validate required fields for public gig
  if (!gigData.venueId) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'venueId is required for public gigs' })
    };
  }

  if (!gigData.date) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'date is required' })
    };
  }

  // Fetch venue to get location for geohash computation
  const venue = await getVenue(dynamodb, gigData.venueId);
  if (!venue) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Venue not found' })
    };
  }

  // Validate venue has coordinates (required for public events)
  if (!venue.latitude || !venue.longitude) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        error: 'Venue must have valid coordinates for public gigs',
        venueId: gigData.venueId
      })
    };
  }

  // Check for duplicate events (same venue + date + artist - one gig per day)
  const duplicateEvent = await checkForDuplicateEvent(dynamodb, gigData.venueId, gigData.date, [artistId]);
  if (duplicateEvent) {
    console.log(`DUPLICATE_PREVENTED: Event already exists - ${duplicateEvent.id} (${duplicateEvent.title})`);
    return {
      statusCode: 409,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        error: 'Duplicate event detected',
        message: `An event with this artist at this venue on ${gigData.date} already exists`,
        existingEventId: duplicateEvent.id,
        existingEventTitle: duplicateEvent.title,
        existingStartTime: duplicateEvent.startTime
      })
    };
  }

  // Compute geohash fields from venue location
  const geohashFields = computeGeohashFields(venue);

  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Build public gig event
  const newEvent = {
    id: eventId,
    artistId: artistId,
    // ownerUserId omitted - XOR: this is an artist event
    type: gigData.type || 'public_gig', // Allow 'festival' as well
    date: gigData.date,
    venueId: gigData.venueId,
    isPublic: gigData.isPublic !== undefined ? gigData.isPublic : true, // Default to public
    isAllDay: gigData.isAllDay || false,
    membershipId: membership.membership_id,
    createdAt: now,
    updatedAt: now,
    // Geohash fields for Frontstage geo-spatial queries (computed for all gigs)
    ...geohashFields,
    // Track creation source for analytics
    source: gigData.source || 'backstage_wizard'
  };

  // Optional fields
  if (gigData.title) newEvent.title = gigData.title;
  if (gigData.hasCustomTitle !== undefined) newEvent.hasCustomTitle = gigData.hasCustomTitle;
  if (gigData.description) newEvent.description = gigData.description;
  if (gigData.endDate) newEvent.endDate = gigData.endDate;
  if (gigData.startTime) newEvent.startTime = gigData.startTime;
  if (gigData.endTime) newEvent.endTime = gigData.endTime;
  if (gigData.notes) newEvent.notes = gigData.notes;

  // Public gig specific fields (for future Frontstage features)
  if (gigData.ticketUrl) newEvent.ticketUrl = gigData.ticketUrl;
  if (gigData.ticketPrice) newEvent.ticketPrice = gigData.ticketPrice;
  if (gigData.doorsTime) newEvent.doorsTime = gigData.doorsTime;

  // Fee tracking fields (private - artist backstage only)
  if (gigData.agreedFee !== undefined) newEvent.agreedFee = gigData.agreedFee;
  if (gigData.actualFee !== undefined) newEvent.actualFee = gigData.actualFee;
  if (gigData.datePaid) newEvent.datePaid = gigData.datePaid;
  if (gigData.paymentMethod) newEvent.paymentMethod = gigData.paymentMethod;
  if (gigData.splitBetweenMembers !== undefined) newEvent.splitBetweenMembers = gigData.splitBetweenMembers;
  if (gigData.noFee !== undefined) newEvent.noFee = gigData.noFee;
  if (gigData.distributed !== undefined) newEvent.distributed = gigData.distributed;

  // Check for duplicates (same artist, venue, date - regardless of public/private)
  const duplicateCheck = await dynamodb.query({
    TableName: EVENTS_TABLE,
    IndexName: 'artistId-date-index',
    KeyConditionExpression: 'artistId = :artistId AND #date = :date',
    FilterExpression: 'venueId = :venueId',
    ExpressionAttributeNames: { '#date': 'date' },
    ExpressionAttributeValues: {
      ':artistId': artistId,
      ':date': gigData.date,
      ':venueId': gigData.venueId
    }
  }).promise();

  if (duplicateCheck.Items && duplicateCheck.Items.length > 0) {
    return {
      statusCode: 409,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        error: 'Duplicate gig detected - this artist already has a gig at this venue on this date',
        existingEvent: duplicateCheck.Items[0]
      })
    };
  }

  // Auto-create venue relationship before creating the event
  await ensureVenueRelationship(dynamodb, artistId, gigData.venueId, gigData.date);

  // Create the event — HARD GATE on (venue|artist|date), 2026-07-27 plan
  const gateResult = await putEventGated(dynamodb, newEvent, 'public-gig');
  if (!gateResult.written) {
    return {
      statusCode: 409,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        ...duplicateResponseBody('event', gateResult.existing),
        message: `An event with this artist at this venue on ${gigData.date} already exists`,
        existingEventId: gateResult.existing ? gateResult.existing.refId : null
      })
    };
  }

  console.log('PUBLIC_GIG: Created successfully', {
    eventId,
    artistId,
    venueId: gigData.venueId,
    geohash6: geohashFields.geohash6,
    coordinates: { lat: geohashFields.geoLat, lng: geohashFields.geoLng }
  });

  // Skip notifications for platform admin events
  const skipNotifications = user.platformAdmin;

  if (!skipNotifications) {
    // Trigger gig_added notification
    await triggerNotification(
      { dynamodb, lambda },
      'gig_added',
      artistId,
      user.userId,
      {
        eventId: eventId,
        venueName: gigData.title || venue.name || 'TBA',
        eventDate: gigData.date
      }
    );
  } else {
    console.log('[EVENTS] Skipping notifications for platform admin public gig creation');
  }

  return {
    statusCode: 201,
    headers: getCorsHeaders(event),
    body: JSON.stringify(newEvent)
  };
}

/**
 * POST /api/events/community - Create community event (public endpoint)
 * NO AUTH - anonymous community users can create events
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 */
async function handleCreateCommunityEvent(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;

  console.log('COMMUNITY_EVENT: Create request');

  try {
    const body = JSON.parse(event.body);
    if (hasPrivilegedIngestionFields(body) && !event.__allowScopedIngestion) {
      return { statusCode: 403, headers: getCorsHeaders(event), body: JSON.stringify({ error: 'Scoped ingestion fields require MCP service authentication' }) };
    }
    if (event.__allowScopedIngestion) {
      const scopedError = validateScopedIngestion(body, 'event');
      if (scopedError) return { statusCode: 400, headers: getCorsHeaders(event), body: JSON.stringify({ error: scopedError }) };
    }
    const {
      artistId, artistIds, venueId, date, startTime, endTime, title, isPublic, source, isOpenMic,
      // Enrichment fields (parity with edit_event)
      price, eventUrl, ticketed, ticketInformation, ticketUrl, imageUrl, description, notes,
      // Festival fields (Phase 1a)
      festivalId, festivalName, stageId, billing, billingOrder
    } = body;

    // Support both single artistId and multiple artistIds
    const artistIdsList = artistIds || (artistId ? [artistId] : []);

    // Validation
    if ((!artistIdsList || artistIdsList.length === 0) && !isOpenMic) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'artistId, artistIds, or isOpenMic flag is required' })
      };
    }

    // startTime stays REQUIRED here. Every stored event has a start time.
    // Callers apply the RUNBOOK 5.6 default BEFORE they call this endpoint.
    // This check is the safety net: a caller that drops the field fails loudly
    // instead of storing a quiet default.
    if (!venueId || !date || !startTime) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'venueId, date, and startTime are required' })
      };
    }

    // Get venue details for geolocation
    const venue = await getVenue(dynamodb, venueId);
    if (!venue) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'Venue not found' })
      };
    }

    // Get first artist details for title generation (or use provided title)
    let artist = null;
    if (artistIdsList.length > 0) {
      const artistResult = await dynamodb.get({
        TableName: ARTISTS_TABLE,
        Key: { id: artistIdsList[0] }
      }).promise();

      if (!artistResult.Item) {
        return {
          statusCode: 404,
          headers: getCorsHeaders(event),
          body: JSON.stringify({ error: 'Artist not found' })
        };
      }

      artist = artistResult.Item;
    }

    // Check for duplicate by externalId FIRST (most reliable dedup)
    if (body.externalIds && body.externalIds.length > 0) {
      const duplicateByExtId = await checkForDuplicateByExternalId(dynamodb, body.externalIds);
      if (duplicateByExtId) {
        console.log(`DUPLICATE_PREVENTED (externalId): Event already exists - ${duplicateByExtId.id} (${duplicateByExtId.title})`);
        return {
          statusCode: 409,
          headers: getCorsHeaders(event),
          body: JSON.stringify({
            error: 'Duplicate event detected (externalId match)',
            message: `An event with externalId ${duplicateByExtId.matchedExternalId.source}:${duplicateByExtId.matchedExternalId.id} already exists`,
            existingEventId: duplicateByExtId.id,
            existingEventTitle: duplicateByExtId.title,
            existingDate: duplicateByExtId.date,
            existingStartTime: duplicateByExtId.startTime,
            matchedExternalId: duplicateByExtId.matchedExternalId,
            editionMetadata: editionMetadata(duplicateByExtId)
          })
        };
      }
    }

    // Check for duplicate events (same venue + date + artist - one gig per day)
    if (artistIdsList.length > 0) {
      const duplicateEvent = await checkForDuplicateEvent(dynamodb, venueId, date, artistIdsList);
      if (duplicateEvent) {
        console.log(`DUPLICATE_PREVENTED: Event already exists - ${duplicateEvent.id} (${duplicateEvent.title})`);
        return {
          statusCode: 409,
          headers: getCorsHeaders(event),
          body: JSON.stringify({
            error: 'Duplicate event detected',
            message: `An event with this artist at this venue on ${date} already exists (${duplicateEvent.startTime || 'time unknown'})`,
            existingEventId: duplicateEvent.id,
            existingEventTitle: duplicateEvent.title,
            existingStartTime: duplicateEvent.startTime,
            editionMetadata: editionMetadata(duplicateEvent)
          })
        };
      }
    }

    // Compute geohash fields from venue location
    const geohashFields = computeGeohashFields(venue);

    const now = new Date().toISOString();
    const eventId = crypto.randomUUID();

    // Generate title
    let eventTitle = title;
    if (!eventTitle) {
      if (isOpenMic) {
        eventTitle = `Open Mic @ ${venue.name}`;
      } else if (artist) {
        const artistNames = artistIdsList.length > 1 ? `${artist.name} + ${artistIdsList.length - 1} more` : artist.name;
        eventTitle = `${artistNames} @ ${venue.name}`;
      } else {
        eventTitle = `Event @ ${venue.name}`;
      }
    }

    // Fetch all artist names for multi-artist events
    const allArtistNames = [];
    if (artistIdsList.length > 0) {
      const artistPromises = artistIdsList.map(id =>
        dynamodb.get({ TableName: ARTISTS_TABLE, Key: { id } }).promise()
      );
      const artistResults = await Promise.all(artistPromises);
      artistResults.forEach(result => {
        if (result.Item) {
          allArtistNames.push(result.Item.name);
        }
      });
    }

    // Create main event with primary artist and collaborating artists
    const collaboratingArtistIds = artistIdsList.length > 1 ? artistIdsList.slice(1) : [];
    const newEvent = {
      id: eventId,
      artistId: artistIdsList[0] || null,
      collaboratingArtistIds: collaboratingArtistIds, // Multi-artist support
      venueId: venueId,
      title: eventTitle,
      date: date,
      startTime: startTime,
      // RUNBOOK 5.6: the caller says whether this time came from a source or
      // from the default. The review queue reads this flag.
      ...(body.startTimeDefaulted === true && { startTimeDefaulted: true }),
      endTime: endTime || DEFAULT_END_TIME,
      type: isOpenMic ? 'open-mic' : 'gig',
      isPublic: isPublic !== undefined ? isPublic : true,
      isAllDay: false,

      // Geolocation - only include if venue has coordinates (sparse GSI)
      ...(geohashFields.geohash6 && geohashFields),

      // External IDs for cross-referencing
      external_ids: body.externalIds || [],

      // Enrichment fields (parity with edit_event)
      ...(price !== undefined && { price }),
      ...(eventUrl !== undefined && { eventUrl }),
      ...(ticketed !== undefined && { ticketed }),
      ...(ticketInformation !== undefined && { ticketinformation: ticketInformation }),
      ...(ticketUrl !== undefined && { ticketUrl }),
      ...(imageUrl !== undefined && { imageUrl }),
      ...(description !== undefined && { description }),
      ...(notes !== undefined && { notes }),

      // Festival fields (Phase 1a)
      ...(festivalId !== undefined && { festivalId }),
      ...(festivalName !== undefined && { festivalName }),
      ...(stageId !== undefined && { stageId }),
      ...(billing !== undefined && { billing }),
      ...(billingOrder !== undefined && { billingOrder }),

      ...(event.__allowScopedIngestion && {
        publicationScopes: body.publicationScopes,
        eventKind: body.eventKind,
        ...(body.productionId !== undefined && { productionId: body.productionId }),
        ...(body.productionName !== undefined && { productionName: body.productionName }),
        ...(body.conductorName !== undefined && { conductorName: body.conductorName })
      }),

      // Community event flags
      source: source || 'community_wizard',
      verifiedByArtist: false,  // Ghost checkmark
      verifiedByVenue: false,   // Future feature
      createdByUserId: null,    // Anonymous community builder
      membershipId: null,       // No membership for community events

      // AI import flags (when source is mcp_ai_import)
      ...(source === 'mcp_ai_import' && { aiCreated: true, needsReview: true }),

      createdAt: now,
      updatedAt: now
    };

    // Write to DynamoDB — HARD GATE on (venue|artist|date), 2026-07-27 plan.
    // The OPENMIC key inside the gate also closes the old skip-hole where
    // artist-less events (isOpenMic) had zero duplicate protection.
    const gateResult = await putEventGated(dynamodb, newEvent, source || 'community');
    if (!gateResult.written) {
      return {
        statusCode: 409,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          ...duplicateResponseBody('event', gateResult.existing),
          message: 'Duplicate event: this artist/venue/date combination already exists',
          existingEventId: gateResult.existing ? gateResult.existing.refId : null
        })
      };
    }

    // DEFENSIVE: Read back to verify persistence (prevents silent data loss bug)
    // Addresses issue where put returns success but record not persisted (~1-3% incidence)
    const verifyResult = await dynamodb.get({
      TableName: EVENTS_TABLE,
      Key: { id: eventId },
      ConsistentRead: true // Force strong consistency to catch write failures
    }).promise();

    if (!verifyResult.Item) {
      console.error(`CRITICAL: Event ${eventId} put succeeded but verification read failed - data loss detected`);
      throw new Error('Event creation verification failed - write did not persist');
    }

    console.log(` Community event created: ${eventId} (${eventTitle})`);

    return {
      statusCode: 201,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        message: 'Event created successfully',
        id: eventId,
        event: {
          id: eventId,
          title: newEvent.title,
          date: newEvent.date,
          startTime: newEvent.startTime,
          artistId: newEvent.artistId,
          artistIds: artistIdsList, // Full array of all artist IDs
          artistNames: allArtistNames, // Full array of all artist names
          venueId: newEvent.venueId
        }
      })
    };
  } catch (error) {
    console.error(' Community event creation failed:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Internal server error' })
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
  handleCreatePublicGig,
  handleCreateCommunityEvent,
  EVENTS_TABLE,
  VENUES_TABLE,
  ARTISTS_TABLE,
  USERS_TABLE,
  MEMBERSHIPS_TABLE
};
