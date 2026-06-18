/**
 * Calendar Handlers for Events Lambda
 *
 * Handles calendar view, subscriptions, and iCal feed operations.
 * Most endpoints require authentication.
 */

const ics = require('ics');
const { verifyMembership } = require('../lib/auth');
const { addDays, subtractDays, generateOccurrences, EVENTS_TABLE, VENUES_TABLE } = require('../lib/event-data');
const { createCalendarToken, getCalendarTokens, revokeCalendarToken, validateToken, updateTokenLastUsed } = require('../calendar-tokens');
const { generateIcalFeed, eventToVEvent } = require('../ical-generator');

// Table constants
const ARTISTS_TABLE = 'bndy-artists';
const USERS_TABLE = 'bndy-users';
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';

/**
 * GET /api/artists/:artistId/calendar - Get calendar view
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 * @param {Object} user - Authenticated user
 */
async function handleGetCalendar(deps, event, user) {
  const { dynamodb, getCorsHeaders } = deps;

  console.log('CALENDAR DEBUG: Start', { user, pathParameters: event.pathParameters, queryStringParameters: event.queryStringParameters });

  const { artistId } = event.pathParameters;
  const { startDate, endDate } = event.queryStringParameters || {};

  if (!startDate || !endDate) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'startDate and endDate required' })
    };
  }

  console.log('CALENDAR DEBUG: Verifying membership', { userId: user.userId, artistId });

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
    console.log('[EVENTS] Platform admin access granted for calendar view');
    // Create a minimal membership object for compatibility
    membership = { user_id: user.userId, artist_id: artistId };
  }

  // Pad date range by 7 days to catch multi-day events
  const paddedStart = subtractDays(startDate, 7);
  const paddedEnd = addDays(endDate, 7);

  console.log('CALENDAR: Querying events', { artistId, userId: user.userId, startDate, endDate });

  // Fetch current artist data for displayColour
  const currentArtistResult = await dynamodb.get({
    TableName: ARTISTS_TABLE,
    Key: { id: artistId }
  }).promise();
  const currentArtistDisplayColour = currentArtistResult.Item?.displayColour || null;

  // Query 1a: Artist events within date range
  const artistEventsResult = await dynamodb.query({
    TableName: EVENTS_TABLE,
    IndexName: 'artistId-date-index',
    KeyConditionExpression: 'artistId = :artistId AND #date BETWEEN :start AND :end',
    ExpressionAttributeNames: { '#date': 'date' },
    ExpressionAttributeValues: {
      ':artistId': artistId,
      ':start': paddedStart,
      ':end': paddedEnd
    }
  }).promise();

  // Query 1b: Recurring events that started BEFORE the range but may have occurrences within it
  const recurringEventsResult = await dynamodb.query({
    TableName: EVENTS_TABLE,
    IndexName: 'artistId-date-index',
    KeyConditionExpression: 'artistId = :artistId AND #date < :start',
    FilterExpression: 'attribute_exists(recurring)',
    ExpressionAttributeNames: { '#date': 'date' },
    ExpressionAttributeValues: {
      ':artistId': artistId,
      ':start': paddedStart
    }
  }).promise();

  // Merge artist events with recurring events, avoiding duplicates
  const artistEventIds = new Set((artistEventsResult.Items || []).map(e => e.id));
  const allArtistEvents = [
    ...(artistEventsResult.Items || []),
    ...(recurringEventsResult.Items || []).filter(e => !artistEventIds.has(e.id))
  ];

  console.log('CALENDAR: Fetched events', {
    inRange: artistEventsResult.Items?.length || 0,
    recurringFromBefore: recurringEventsResult.Items?.length || 0,
    totalArtistEvents: allArtistEvents.length
  });

  // Query 2: Get all band members to show their unavailability
  const membershipsResult = await dynamodb.query({
    TableName: MEMBERSHIPS_TABLE,
    IndexName: 'artist_id-index',
    KeyConditionExpression: 'artist_id = :artistId',
    ExpressionAttributeValues: { ':artistId': artistId }
  }).promise();

  const memberUserIds = (membershipsResult.Items || []).map(m => m.user_id);

  console.log('CALENDAR: Fetching unavailability for band members', { memberUserIds });

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
          ':start': paddedStart,
          ':end': paddedEnd
        }
      }).promise()
    );

    const unavailabilityResults = await Promise.all(unavailabilityPromises);
    allMemberUnavailability = unavailabilityResults.flatMap(result => result.Items || []);

    console.log('CALENDAR: Found member unavailability', { count: allMemberUnavailability.length });
  }

  // Enrich unavailability with user display names
  const userEventsResult = await Promise.all(allMemberUnavailability.map(async (evt) => {
    if (evt.type === 'unavailable' && evt.ownerUserId) {
      try {
        const userResult = await dynamodb.get({
          TableName: USERS_TABLE,
          Key: { cognito_id: evt.ownerUserId }
        }).promise();

        if (userResult.Item) {
          const displayName = userResult.Item.display_name || userResult.Item.username || 'Unknown User';
          console.log('CALENDAR: Enriched unavailability', {
            userId: evt.ownerUserId,
            displayName
          });
          return {
            ...evt,
            displayName
          };
        }
      } catch (error) {
        console.error('CALENDAR: Failed to fetch user display name:', error);
      }
    }
    return evt;
  }));

  // Query 3: User's other artist events
  const otherMembershipsResult = await dynamodb.query({
    TableName: MEMBERSHIPS_TABLE,
    IndexName: 'user_id-index',
    KeyConditionExpression: 'user_id = :userId',
    ExpressionAttributeValues: { ':userId': user.userId }
  }).promise();

  const otherArtistIds = (otherMembershipsResult.Items || [])
    .filter(m => m.artist_id !== artistId)
    .map(m => m.artist_id);

  let otherArtistEvents = [];
  if (otherArtistIds.length > 0) {
    const otherEventsPromises = otherArtistIds.map(id =>
      dynamodb.query({
        TableName: EVENTS_TABLE,
        IndexName: 'artistId-date-index',
        KeyConditionExpression: 'artistId = :artistId AND #date BETWEEN :start AND :end',
        ExpressionAttributeNames: { '#date': 'date' },
        ExpressionAttributeValues: {
          ':artistId': id,
          ':start': paddedStart,
          ':end': paddedEnd
        }
      }).promise()
    );

    const otherEventsResults = await Promise.all(otherEventsPromises);

    // Fetch artist names for other events
    const artistsPromises = otherArtistIds.map(id =>
      dynamodb.get({
        TableName: ARTISTS_TABLE,
        Key: { id }
      }).promise()
    );
    const artistsResults = await Promise.all(artistsPromises);

    otherEventsResults.forEach((result, idx) => {
      const artistName = artistsResults[idx].Item?.name || 'Unknown Artist';
      const artistDisplayColour = artistsResults[idx].Item?.displayColour || null;
      (result.Items || []).forEach(e => {
        otherArtistEvents.push({ ...e, artistName, artistDisplayColour });
      });
    });
  }

  // Query 4: Cross-artist unavailability - fetch events from other artists where band members are involved
  console.log('CALENDAR: Fetching cross-artist unavailability for band members');

  let crossArtistUnavailability = [];
  if (memberUserIds.length > 0) {
    // Get all other memberships for ALL band members (not just current user)
    const allMemberMembershipsPromises = memberUserIds.map(userId =>
      dynamodb.query({
        TableName: MEMBERSHIPS_TABLE,
        IndexName: 'user_id-index',
        KeyConditionExpression: 'user_id = :userId',
        ExpressionAttributeValues: { ':userId': userId }
      }).promise()
    );

    const allMemberMembershipsResults = await Promise.all(allMemberMembershipsPromises);

    // Build a map of userId -> array of other artistIds they belong to
    const userToOtherArtists = {};
    allMemberMembershipsResults.forEach((result, idx) => {
      const userId = memberUserIds[idx];
      const otherArtists = (result.Items || [])
        .filter(m => m.artist_id !== artistId)
        .map(m => m.artist_id);
      if (otherArtists.length > 0) {
        userToOtherArtists[userId] = otherArtists;
      }
    });

    // Get unique list of all other artists that band members belong to
    const allOtherArtistIds = [...new Set(Object.values(userToOtherArtists).flat())];

    console.log('CALENDAR: Band members belong to other artists', {
      userToOtherArtists,
      allOtherArtistIds
    });

    // Fetch events from these other artists
    if (allOtherArtistIds.length > 0) {
      const crossArtistEventsPromises = allOtherArtistIds.map(id =>
        dynamodb.query({
          TableName: EVENTS_TABLE,
          IndexName: 'artistId-date-index',
          KeyConditionExpression: 'artistId = :artistId AND #date BETWEEN :start AND :end',
          ExpressionAttributeNames: { '#date': 'date' },
          ExpressionAttributeValues: {
            ':artistId': id,
            ':start': paddedStart,
            ':end': paddedEnd
          }
        }).promise()
      );

      const crossArtistEventsResults = await Promise.all(crossArtistEventsPromises);

      // Process cross-artist events - create unavailability indicators for members
      crossArtistEventsResults.forEach((result, idx) => {
        const otherArtistId = allOtherArtistIds[idx];
        (result.Items || []).forEach(evt => {
          // SKIP availability events - these should only show in their base artist
          if (evt.type === 'available') {
            return;
          }

          // Find which of our band members are involved in this event
          memberUserIds.forEach(userId => {
            const userOtherArtists = userToOtherArtists[userId] || [];
            if (userOtherArtists.includes(otherArtistId)) {
              // This member has an event in another artist - show as unavailable
              crossArtistUnavailability.push({
                ...evt,
                ownerUserId: userId,
                type: 'unavailable',
                crossArtistEvent: true,
                originalArtistId: otherArtistId
              });
            }
          });
        });
      });

      console.log('CALENDAR: Found cross-artist unavailability', {
        count: crossArtistUnavailability.length
      });

      // Enrich cross-artist unavailability with user display names
      const enrichedCrossArtistUnavailability = await Promise.all(crossArtistUnavailability.map(async (evt) => {
        try {
          const userResult = await dynamodb.get({
            TableName: USERS_TABLE,
            Key: { cognito_id: evt.ownerUserId }
          }).promise();

          if (userResult.Item) {
            const displayName = userResult.Item.display_name || userResult.Item.username || 'Unknown User';
            return {
              ...evt,
              displayName
            };
          }
        } catch (error) {
          console.error('CALENDAR: Failed to fetch user display name for cross-artist event:', error);
        }
        return evt;
      }));

      // Filter cross-artist unavailability: only show to users who DON'T belong to that artist
      const currentUserOtherArtists = otherArtistIds;
      const filteredCrossArtistUnavailability = enrichedCrossArtistUnavailability.filter(evt => {
        return !currentUserOtherArtists.includes(evt.originalArtistId);
      });

      // Add filtered cross-artist unavailability to userEvents
      userEventsResult.push(...filteredCrossArtistUnavailability);

      console.log('CALENDAR: Added cross-artist unavailability to userEvents', {
        total: enrichedCrossArtistUnavailability.length,
        filteredForCurrentUser: filteredCrossArtistUnavailability.length
      });
    }
  }

  // Expand recurring events into occurrences
  const expandRecurring = (events) => events.flatMap(evt =>
    generateOccurrences(evt, startDate, endDate)
  );

  // Post-filter to exact date range
  const filterToRange = (events) => events.filter(e => {
    const eventStart = e.date;
    const eventEnd = e.endDate || e.date;
    return eventStart <= endDate && eventEnd >= startDate;
  });

  // Expand recurring events BEFORE filtering
  const expandedArtistEvents = expandRecurring(allArtistEvents);
  const expandedUserEvents = expandRecurring(userEventsResult || []);
  const expandedOtherArtistEvents = expandRecurring(otherArtistEvents);

  // Collect all unique venueIds from events
  const allFilteredEvents = [
    ...filterToRange(expandedArtistEvents),
    ...filterToRange(expandedUserEvents),
    ...filterToRange(expandedOtherArtistEvents)
  ];

  const venueIds = [...new Set(
    allFilteredEvents
      .filter(e => e.venueId)
      .map(e => e.venueId)
  )];

  // Fetch full venue details
  const venueMap = {};
  if (venueIds.length > 0) {
    const venuePromises = venueIds.map(id =>
      dynamodb.get({
        TableName: VENUES_TABLE,
        Key: { id }
      }).promise()
    );

    const venueResults = await Promise.all(venuePromises);
    venueResults.forEach((result, idx) => {
      if (result.Item) {
        const venue = result.Item;
        venueMap[venueIds[idx]] = {
          name: venue.name,
          address: venue.address,
          city: venue.city,
          latitude: venue.latitude,
          longitude: venue.longitude,
          googlePlaceId: venue.google_place_id
        };
      }
    });
  }

  // Transform events to match frontend interface (type -> eventType) and add venue details
  const transformEvent = (e) => {
    const venueData = e.venueId ? venueMap[e.venueId] : null;
    return {
      ...e,
      eventType: e.type,
      venue: venueData?.name || null,
      venueAddress: venueData?.address || null,
      venueCity: venueData?.city || null,
      venueLatitude: venueData?.latitude || null,
      venueLongitude: venueData?.longitude || null,
      venueGooglePlaceId: venueData?.googlePlaceId || null
    };
  };

  const responseData = {
    artistEvents: filterToRange(expandedArtistEvents).map(e => ({
      ...transformEvent(e),
      artistDisplayColour: currentArtistDisplayColour
    })),
    userEvents: filterToRange(expandedUserEvents).map(transformEvent),
    otherArtistEvents: filterToRange(expandedOtherArtistEvents).map(transformEvent)
  };

  console.log('CALENDAR: Response structure', {
    artistEventsCount: responseData.artistEvents.length,
    userEventsCount: responseData.userEvents.length,
    otherArtistEventsCount: responseData.otherArtistEvents.length,
    artistEventsIsArray: Array.isArray(responseData.artistEvents),
    userEventsIsArray: Array.isArray(responseData.userEvents),
    otherArtistEventsIsArray: Array.isArray(responseData.otherArtistEvents)
  });

  return {
    statusCode: 200,
    headers: getCorsHeaders(event),
    body: JSON.stringify(responseData)
  };
}

/**
 * GET /api/artists/:artistId/events - Get all artist events (no date filter)
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 * @param {Object} user - Authenticated user
 */
async function handleGetAllArtistEvents(deps, event, user) {
  const { dynamodb, getCorsHeaders } = deps;
  const { artistId } = event.pathParameters;

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
    console.log('[EVENTS] Platform admin access granted for all events view');
  }

  console.log('EVENTS: Fetching all events for artist', { artistId });

  // Query all events for this artist (no date filter)
  const eventsResult = await dynamodb.query({
    TableName: EVENTS_TABLE,
    IndexName: 'artistId-date-index',
    KeyConditionExpression: 'artistId = :artistId',
    ExpressionAttributeValues: {
      ':artistId': artistId
    }
  }).promise();

  const events = eventsResult.Items || [];

  // Enrich with venue data if venueId exists
  const venueIds = [...new Set(events.filter(e => e.venueId).map(e => e.venueId))];
  const venueMap = {};

  if (venueIds.length > 0) {
    const venuePromises = venueIds.map(id =>
      dynamodb.get({
        TableName: VENUES_TABLE,
        Key: { id }
      }).promise()
    );

    const venueResults = await Promise.all(venuePromises);
    venueResults.forEach((result, idx) => {
      if (result.Item) {
        const venue = result.Item;
        venueMap[venueIds[idx]] = {
          name: venue.name,
          address: venue.address,
          city: venue.city,
          latitude: venue.latitude,
          longitude: venue.longitude,
          googlePlaceId: venue.google_place_id
        };
      }
    });
  }

  // Transform events to match frontend interface
  const transformedEvents = events.map(e => {
    const venueData = e.venueId ? venueMap[e.venueId] : null;
    return {
      ...e,
      eventType: e.type,
      venue: venueData?.name || null,
      venueAddress: venueData?.address || null,
      venueCity: venueData?.city || null,
      venueLatitude: venueData?.latitude || null,
      venueLongitude: venueData?.longitude || null,
      venueGooglePlaceId: venueData?.googlePlaceId || null
    };
  });

  console.log('EVENTS: Returning all events', { count: transformedEvents.length });

  return {
    statusCode: 200,
    headers: getCorsHeaders(event),
    body: JSON.stringify(transformedEvents)
  };
}

/**
 * POST /api/artists/{artistId}/calendar/subscribe
 * Create a new calendar subscription token
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 * @param {Object} user - Authenticated user
 */
async function handleCreateCalendarSubscription(deps, event, user) {
  const { dynamodb, getCorsHeaders } = deps;
  const { artistId } = event.pathParameters;

  // Verify membership
  const membership = await verifyMembership(dynamodb, user.userId, artistId);
  if (!membership) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Not a member of this artist' })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const scope = body.scope || 'full';

    const result = await createCalendarToken({
      userId: user.userId,
      artistId,
      scope
    });

    console.log('CALENDAR_SYNC: Created subscription token', { artistId, scope, tokenPrefix: result.token.substring(0, 10) });

    return {
      statusCode: 201,
      headers: getCorsHeaders(event),
      body: JSON.stringify(result)
    };
  } catch (error) {
    console.error('CALENDAR_SYNC: Error creating subscription', error);
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: error.message })
    };
  }
}

/**
 * GET /api/artists/{artistId}/calendar/subscriptions
 * List all active calendar subscriptions for user
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 * @param {Object} user - Authenticated user
 */
async function handleGetCalendarSubscriptions(deps, event, user) {
  const { dynamodb, getCorsHeaders } = deps;
  const { artistId } = event.pathParameters;

  // Verify membership
  const membership = await verifyMembership(dynamodb, user.userId, artistId);
  if (!membership) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Not a member of this artist' })
    };
  }

  try {
    const subscriptions = await getCalendarTokens(user.userId, artistId);

    // Add subscription URLs to each token
    const withUrls = subscriptions.map(sub => ({
      ...sub,
      subscriptionUrl: `https://api.bndy.co.uk/api/calendar/ical/${sub.token}`,
      webcalUrl: `webcal://api.bndy.co.uk/api/calendar/ical/${sub.token}`
    }));

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ subscriptions: withUrls })
    };
  } catch (error) {
    console.error('CALENDAR_SYNC: Error listing subscriptions', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: error.message })
    };
  }
}

/**
 * DELETE /api/artists/{artistId}/calendar/subscriptions/{token}
 * Revoke a calendar subscription token
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 * @param {Object} user - Authenticated user
 */
async function handleRevokeCalendarSubscription(deps, event, user) {
  const { dynamodb, getCorsHeaders } = deps;
  const { artistId, token } = event.pathParameters;

  // Verify membership
  const membership = await verifyMembership(dynamodb, user.userId, artistId);
  if (!membership) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Not a member of this artist' })
    };
  }

  try {
    await revokeCalendarToken(token, user.userId);

    console.log('CALENDAR_SYNC: Revoked subscription token', { artistId, tokenPrefix: token.substring(0, 10) });

    return {
      statusCode: 204,
      headers: getCorsHeaders(event),
      body: ''
    };
  } catch (error) {
    console.error('CALENDAR_SYNC: Error revoking subscription', error);
    const statusCode = error.message.includes('not found') ? 404 :
                       error.message.includes('Unauthorized') ? 403 : 500;
    return {
      statusCode,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: error.message })
    };
  }
}

/**
 * GET /api/calendar/ical/{token}
 * Public iCal feed endpoint (token-based auth, no session required)
 * This is used by calendar apps (Google Calendar, Apple Calendar, Outlook)
 * @param {Object} deps - Dependencies { dynamodb }
 * @param {Object} event - Lambda event
 */
async function handleGetIcalFeed(deps, event) {
  const { dynamodb } = deps;
  const { token } = event.pathParameters;

  try {
    // Validate token
    const tokenData = await validateToken(token);
    if (!tokenData) {
      return {
        statusCode: 401,
        headers: {
          'Content-Type': 'text/plain',
          'Access-Control-Allow-Origin': '*'
        },
        body: 'Invalid or revoked token'
      };
    }

    // Update last used timestamp (non-blocking)
    updateTokenLastUsed(token).catch(err =>
      console.error('CALENDAR_SYNC: Failed to update lastUsedAt', err)
    );

    const { artistId } = tokenData;

    // Query artist events
    const artistEventsResult = await dynamodb.query({
      TableName: EVENTS_TABLE,
      IndexName: 'artistId-date-index',
      KeyConditionExpression: 'artistId = :artistId AND #date >= :today',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':today': new Date().toISOString().split('T')[0]
      }
    }).promise();

    // Filter to only public gigs and rehearsals
    const events = (artistEventsResult.Items || []).filter(e => {
      const isPublicGig = e.isPublic === true && ['gig', 'public_gig', 'gig-public', 'festival', 'open-mic'].includes(e.type);
      const isRehearsal = e.type === 'rehearsal';
      return isPublicGig || isRehearsal;
    });

    // No cancellations in feed - only relevant if user had the event before deletion
    const cancellations = [];

    // Get artist name for calendar title
    const artistResult = await dynamodb.get({
      TableName: ARTISTS_TABLE,
      Key: { id: artistId }
    }).promise();
    const artistName = artistResult.Item?.name || 'BNDY Calendar';

    // Generate iCal feed
    const icalContent = generateIcalFeed(events, cancellations, `${artistName} Calendar`);

    console.log('CALENDAR_SYNC: Generated iCal feed', {
      artistId,
      eventCount: events.length
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${artistName.replace(/[^a-z0-9]/gi, '-')}-calendar.ics"`,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'max-age=300' // 5 minute cache
      },
      body: icalContent
    };
  } catch (error) {
    console.error('CALENDAR_SYNC: Error generating iCal feed', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*'
      },
      body: 'Error generating calendar feed'
    };
  }
}

/**
 * GET /api/artists/{artistId}/events/{id}/ical
 * Download single event as iCal file
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 * @param {Object} user - Authenticated user
 */
async function handleGetEventIcal(deps, event, user) {
  const { dynamodb, getCorsHeaders } = deps;
  const { artistId, id } = event.pathParameters;

  // Verify membership or check if event is public
  const membership = await verifyMembership(dynamodb, user.userId, artistId);

  // Get the event
  const eventResult = await dynamodb.get({
    TableName: EVENTS_TABLE,
    Key: { id }
  }).promise();

  if (!eventResult.Item) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Event not found' })
    };
  }

  const eventData = eventResult.Item;

  // Check access: must be member OR event must be public
  if (!membership && !eventData.isPublic) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Not authorized to access this event' })
    };
  }

  try {
    // Convert to iCal format
    const vevent = eventToVEvent(eventData);

    // Generate single-event calendar
    const { error: icsError, value: icalContent } = ics.createEvent(vevent);

    if (icsError) {
      throw icsError;
    }

    const filename = `${(eventData.title || 'event').replace(/[^a-z0-9]/gi, '-')}.ics`;

    return {
      statusCode: 200,
      headers: {
        ...getCorsHeaders(event),
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      },
      body: icalContent
    };
  } catch (error) {
    console.error('CALENDAR_SYNC: Error generating event iCal', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Error generating calendar file' })
    };
  }
}

module.exports = {
  handleGetCalendar,
  handleGetAllArtistEvents,
  handleCreateCalendarSubscription,
  handleGetCalendarSubscriptions,
  handleRevokeCalendarSubscription,
  handleGetIcalFeed,
  handleGetEventIcal,
  EVENTS_TABLE,
  VENUES_TABLE,
  ARTISTS_TABLE,
  USERS_TABLE,
  MEMBERSHIPS_TABLE
};
