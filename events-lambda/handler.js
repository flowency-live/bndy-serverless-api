// BNDY Events Lambda Function - Calendar System
// Handles: Artist events, user unavailability, unified calendar

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const ngeohash = require('ngeohash');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

// Configuration
const JWT_SECRET = process.env.JWT_SECRET;
const EVENTS_TABLE = 'bndy-events';
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';
const ARTISTS_TABLE = 'bndy-artists';
const VENUES_TABLE = 'bndy-venues';
const USERS_TABLE = 'bndy-users';

// CORS headers
const getCorsHeaders = () => ({
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': 'https://backstage.bndy.co.uk, https://live.bndy.co.uk',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Credentials': 'true'
});

// Parse cookies from event
const parseCookies = (cookieHeader) => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, value] = cookie.trim().split('=');
    cookies[name] = value;
    return cookies;
  }, {});
};

// Authentication middleware
const requireAuth = (event) => {
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
    return {
      statusCode: 401,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Not authenticated' })
    };
  }

  try {
    const session = jwt.verify(sessionToken, JWT_SECRET);
    return { session };
  } catch (error) {
    console.error('AUTH: Invalid session token:', error.message);
    return {
      statusCode: 401,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Invalid session' })
    };
  }
};

// Verify user is member of artist
const verifyMembership = async (userId, artistId) => {
  const result = await dynamodb.query({
    TableName: MEMBERSHIPS_TABLE,
    IndexName: 'user_id-index',
    KeyConditionExpression: 'user_id = :userId',
    FilterExpression: 'artist_id = :artistId',
    ExpressionAttributeValues: {
      ':userId': userId,
      ':artistId': artistId
    }
  }).promise();

  return result.Items && result.Items.length > 0 ? result.Items[0] : null;
};

// Date helpers
const addDays = (dateStr, days) => {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
};

const subtractDays = (dateStr, days) => {
  return addDays(dateStr, -days);
};

// Helper: Fetch venue from database
const getVenue = async (venueId) => {
  const result = await dynamodb.get({
    TableName: VENUES_TABLE,
    Key: { id: venueId }
  }).promise();
  return result.Item;
};

// Helper: Compute geohash fields from venue location
const computeGeohashFields = (venue) => {
  if (!venue || !venue.latitude || !venue.longitude) {
    return {
      geohash6: null,
      geohash4: null,
      geoLat: null,
      geoLng: null
    };
  }

  return {
    geohash6: ngeohash.encode(venue.latitude, venue.longitude, 6),
    geohash4: ngeohash.encode(venue.latitude, venue.longitude, 4),
    geoLat: venue.latitude,
    geoLng: venue.longitude
  };
};

// GET /api/artists/:artistId/calendar - Unified calendar (3 sources)
const handleGetCalendar = async (event, session) => {
  console.log('CALENDAR DEBUG: Start', { session, pathParameters: event.pathParameters, queryStringParameters: event.queryStringParameters });

  const { artistId } = event.pathParameters;
  const { startDate, endDate } = event.queryStringParameters || {};

  if (!startDate || !endDate) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'startDate and endDate required' })
    };
  }

  console.log('CALENDAR DEBUG: Verifying membership', { userId: session.userId, artistId });

  // Verify membership
  const membership = await verifyMembership(session.userId, artistId);
  if (!membership) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Not a member of this artist' })
    };
  }

  // Pad date range by 7 days to catch multi-day events
  const paddedStart = subtractDays(startDate, 7);
  const paddedEnd = addDays(endDate, 7);

  console.log('CALENDAR: Querying events', { artistId, userId: session.userId, startDate, endDate });

  // Fetch current artist data for displayColour
  const currentArtistResult = await dynamodb.get({
    TableName: ARTISTS_TABLE,
    Key: { id: artistId }
  }).promise();
  const currentArtistDisplayColour = currentArtistResult.Item?.displayColour || null;

  // Query 1: Artist events
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
  const userEventsResult = await Promise.all(allMemberUnavailability.map(async (event) => {
    if (event.type === 'unavailable' && event.ownerUserId) {
      try {
        const userResult = await dynamodb.get({
          TableName: USERS_TABLE,
          Key: { cognito_id: event.ownerUserId }
        }).promise();

        if (userResult.Item) {
          const displayName = userResult.Item.display_name || userResult.Item.username || 'Unknown User';
          console.log('CALENDAR: Enriched unavailability', {
            userId: event.ownerUserId,
            displayName
          });
          return {
            ...event,
            displayName
          };
        }
      } catch (error) {
        console.error('CALENDAR: Failed to fetch user display name:', error);
      }
    }
    return event;
  }));

  // Query 3: User's other artist events
  const otherMembershipsResult = await dynamodb.query({
    TableName: MEMBERSHIPS_TABLE,
    IndexName: 'user_id-index',
    KeyConditionExpression: 'user_id = :userId',
    ExpressionAttributeValues: { ':userId': session.userId }
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
  // This shows members as unavailable when they have events in other artists
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
        (result.Items || []).forEach(event => {
          // Find which of our band members are involved in this event
          // by checking if they belong to this other artist
          memberUserIds.forEach(userId => {
            const userOtherArtists = userToOtherArtists[userId] || [];
            if (userOtherArtists.includes(otherArtistId)) {
              // This member has an event in another artist - show as unavailable
              // Only show to members who DON'T belong to that other artist
              crossArtistUnavailability.push({
                ...event,
                ownerUserId: userId,
                type: 'unavailable',
                // Mark this as cross-artist so it can be filtered by current user's memberships
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
      const enrichedCrossArtistUnavailability = await Promise.all(crossArtistUnavailability.map(async (event) => {
        try {
          const userResult = await dynamodb.get({
            TableName: USERS_TABLE,
            Key: { cognito_id: event.ownerUserId }
          }).promise();

          if (userResult.Item) {
            const displayName = userResult.Item.display_name || userResult.Item.username || 'Unknown User';
            return {
              ...event,
              displayName
            };
          }
        } catch (error) {
          console.error('CALENDAR: Failed to fetch user display name for cross-artist event:', error);
        }
        return event;
      }));

      // Filter cross-artist unavailability: only show to users who DON'T belong to that artist
      const currentUserOtherArtists = otherArtistIds;
      const filteredCrossArtistUnavailability = enrichedCrossArtistUnavailability.filter(event => {
        // Only show if current user is NOT a member of the original artist
        return !currentUserOtherArtists.includes(event.originalArtistId);
      });

      // Add filtered cross-artist unavailability to userEvents
      userEventsResult.push(...filteredCrossArtistUnavailability);

      console.log('CALENDAR: Added cross-artist unavailability to userEvents', {
        total: enrichedCrossArtistUnavailability.length,
        filteredForCurrentUser: filteredCrossArtistUnavailability.length
      });
    }
  }

  // Post-filter to exact date range
  const filterToRange = (events) => events.filter(e => {
    const eventStart = e.date;
    const eventEnd = e.endDate || e.date;
    return eventStart <= endDate && eventEnd >= startDate;
  });

  // Collect all unique venueIds from events
  const allFilteredEvents = [
    ...filterToRange(artistEventsResult.Items || []),
    ...filterToRange(userEventsResult || []),
    ...filterToRange(otherArtistEvents)
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
      venueLatitude: venueData?.latitude || null,
      venueLongitude: venueData?.longitude || null,
      venueGooglePlaceId: venueData?.googlePlaceId || null
    };
  };

  const responseData = {
    artistEvents: filterToRange(artistEventsResult.Items || []).map(e => ({
      ...transformEvent(e),
      artistDisplayColour: currentArtistDisplayColour
    })),
    userEvents: filterToRange(userEventsResult || []).map(transformEvent),
    otherArtistEvents: filterToRange(otherArtistEvents).map(transformEvent) // Already has artistDisplayColour
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
    headers: getCorsHeaders(),
    body: JSON.stringify(responseData)
  };
};

// POST /api/artists/:artistId/events - Create artist event
const handleCreateArtistEvent = async (event, session) => {
  const { artistId } = event.pathParameters;
  const eventData = JSON.parse(event.body);

  // Verify membership
  const membership = await verifyMembership(session.userId, artistId);
  if (!membership) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Not a member of this artist' })
    };
  }

  // Validate required fields
  if (!eventData.type || !eventData.date) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'type and date are required' })
    };
  }

  // Validate public events require venueId
  if (eventData.isPublic && !eventData.venueId) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Public events must have venueId' })
    };
  }

  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Build event object - omit sparse GSI keys when null
  const newEvent = {
    id: eventId,
    artistId: artistId,
    // ownerUserId omitted (not null) for sparse GSI - XOR: artist event
    type: eventData.type,
    date: eventData.date,
    isPublic: eventData.isPublic || false,
    isAllDay: eventData.isAllDay || false,
    membershipId: membership.membership_id,
    createdAt: now,
    updatedAt: now
  };

  // Optional fields - only include if present
  if (eventData.title) newEvent.title = eventData.title;
  if (eventData.endDate) newEvent.endDate = eventData.endDate;
  if (eventData.startTime) newEvent.startTime = eventData.startTime;
  if (eventData.endTime) newEvent.endTime = eventData.endTime;
  if (eventData.location) newEvent.location = eventData.location;
  if (eventData.notes) newEvent.notes = eventData.notes;

  // Sparse GSI keys - only include if present (NOT null)
  if (eventData.venueId) {
    newEvent.venueId = eventData.venueId;
    // TODO: Fetch venue location and compute geohash for Frontstage
    // if (venue.geoLat && venue.geoLng) {
    //   newEvent.geoLat = venue.geoLat;
    //   newEvent.geoLng = venue.geoLng;
    //   newEvent.geohash6 = computeGeohash(venue.geoLat, venue.geoLng, 6);
    //   newEvent.geohash4 = computeGeohash(venue.geoLat, venue.geoLng, 4);
    // }
  }

  await dynamodb.put({
    TableName: EVENTS_TABLE,
    Item: newEvent
  }).promise();

  console.log('EVENT: Created artist event', { eventId, artistId, type: eventData.type });

  return {
    statusCode: 201,
    headers: getCorsHeaders(),
    body: JSON.stringify(newEvent)
  };
};

// POST /api/users/me/unavailability - Create user unavailability event (artist-agnostic)
const handleCreateUserUnavailability = async (event, session) => {
  const eventData = JSON.parse(event.body);

  // Validate required fields
  if (!eventData.date) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'date is required' })
    };
  }

  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Build user event - omit sparse GSI keys (artistId, venueId, geohash6, membershipId)
  const unavailableEvent = {
    id: eventId,
    // artistId omitted (not null) for sparse GSI - XOR: user event
    ownerUserId: session.userId,
    type: 'unavailable',
    title: eventData.title || 'Unavailable',
    date: eventData.date,
    isPublic: false,
    isAllDay: true,
    // membershipId omitted - this is a user event, not artist-specific
    createdAt: now,
    updatedAt: now
  };

  // Optional fields - only include if present
  if (eventData.endDate) unavailableEvent.endDate = eventData.endDate;

  // User events never have: venueId, geohash, location, startTime, endTime (all-day only)

  await dynamodb.put({
    TableName: EVENTS_TABLE,
    Item: unavailableEvent
  }).promise();

  console.log('EVENT: Created user unavailability', { eventId, userId: session.userId });

  return {
    statusCode: 201,
    headers: getCorsHeaders(),
    body: JSON.stringify(unavailableEvent)
  };
};

// GET /api/artists/:artistId/events/:id - Get single event
const handleGetEvent = async (event, session) => {
  const { artistId, id } = event.pathParameters;

  // Verify membership
  const membership = await verifyMembership(session.userId, artistId);
  if (!membership) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Not a member of this artist' })
    };
  }

  const result = await dynamodb.get({
    TableName: EVENTS_TABLE,
    Key: { id }
  }).promise();

  if (!result.Item) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Event not found' })
    };
  }

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify(result.Item)
  };
};

// PUT /api/artists/:artistId/events/:id - Update event
const handleUpdateEvent = async (event, session) => {
  const { artistId, id } = event.pathParameters;
  const updates = JSON.parse(event.body);

  // Verify membership
  const membership = await verifyMembership(session.userId, artistId);
  if (!membership) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Not a member of this artist' })
    };
  }

  // Get existing event
  const existing = await dynamodb.get({
    TableName: EVENTS_TABLE,
    Key: { id }
  }).promise();

  if (!existing.Item) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Event not found' })
    };
  }

  const existingEvent = existing.Item;

  // Permission check: user events only editable by owner
  if (existingEvent.type === 'unavailable' && existingEvent.ownerUserId !== session.userId) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Can only edit your own unavailability' })
    };
  }

  // Artist events editable by any member (can add role checks later)

  // Build update expression
  const updateFields = {};
  const updateExpressions = [];
  const attributeNames = {};
  const attributeValues = {};

  const allowedFields = ['type', 'title', 'date', 'endDate', 'startTime', 'endTime', 'venueId', 'location', 'notes', 'isPublic', 'isAllDay'];

  allowedFields.forEach(field => {
    if (updates[field] !== undefined) {
      const placeholder = `#${field}`;
      const valuePlaceholder = `:${field}`;
      attributeNames[placeholder] = field;
      attributeValues[valuePlaceholder] = updates[field];
      updateExpressions.push(`${placeholder} = ${valuePlaceholder}`);
    }
  });

  // Always update updatedAt
  attributeNames['#updatedAt'] = 'updatedAt';
  attributeValues[':updatedAt'] = new Date().toISOString();
  updateExpressions.push('#updatedAt = :updatedAt');

  if (updateExpressions.length === 1) { // Only updatedAt
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'No valid fields to update' })
    };
  }

  await dynamodb.update({
    TableName: EVENTS_TABLE,
    Key: { id },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames: attributeNames,
    ExpressionAttributeValues: attributeValues
  }).promise();

  // Fetch updated event
  const updated = await dynamodb.get({
    TableName: EVENTS_TABLE,
    Key: { id }
  }).promise();

  console.log('EVENT: Updated event', { eventId: id });

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify(updated.Item)
  };
};

// DELETE /api/artists/:artistId/events/:id - Delete event
const handleDeleteEvent = async (event, session) => {
  const { artistId, id } = event.pathParameters;

  // Verify membership
  const membership = await verifyMembership(session.userId, artistId);
  if (!membership) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Not a member of this artist' })
    };
  }

  // Get existing event for permission check
  const existing = await dynamodb.get({
    TableName: EVENTS_TABLE,
    Key: { id }
  }).promise();

  if (!existing.Item) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Event not found' })
    };
  }

  const existingEvent = existing.Item;

  // Permission check: user events only deletable by owner
  if (existingEvent.type === 'unavailable' && existingEvent.ownerUserId !== session.userId) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Can only delete your own unavailability' })
    };
  }

  // Permission check: artist events must belong to the artist context
  if (existingEvent.artistId && existingEvent.artistId !== artistId) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        error: 'Cannot delete events from a different artist context',
        eventArtistId: existingEvent.artistId,
        currentArtistId: artistId
      })
    };
  }

  await dynamodb.delete({
    TableName: EVENTS_TABLE,
    Key: { id }
  }).promise();

  console.log('EVENT: Deleted event', { eventId: id });

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({ success: true, id })
  };
};

// POST /api/artists/:artistId/events/check-conflicts - Check for conflicting events
const handleCheckConflicts = async (event, session) => {
  const { artistId } = event.pathParameters;
  const eventData = JSON.parse(event.body);

  // Verify membership
  const membership = await verifyMembership(session.userId, artistId);
  if (!membership) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Not a member of this artist' })
    };
  }

  if (!eventData.date) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
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

  const allEvents = [...(artistEventsResult.Items || []), ...allMemberUnavailability];

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
    headers: getCorsHeaders(),
    body: JSON.stringify({
      hasConflicts: enrichedConflicts.length > 0,
      conflicts: enrichedConflicts
    })
  };
};

// POST /api/public-gigs/create - Create public gig with venue resolution
const handleCreatePublicGig = async (event, session) => {
  const { artistId } = event.pathParameters;
  const gigData = JSON.parse(event.body);

  console.log('PUBLIC_GIG: Create request', { artistId, gigData });

  // Verify membership
  const membership = await verifyMembership(session.userId, artistId);
  if (!membership) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Not a member of this artist' })
    };
  }

  // Validate required fields for public gig
  if (!gigData.venueId) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'venueId is required for public gigs' })
    };
  }

  if (!gigData.date) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'date is required' })
    };
  }

  // Fetch venue to get location for geohash computation
  const venue = await getVenue(gigData.venueId);
  if (!venue) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Venue not found' })
    };
  }

  // Validate venue has coordinates (required for public events)
  if (!venue.latitude || !venue.longitude) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        error: 'Venue must have valid coordinates for public gigs',
        venueId: gigData.venueId
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
  if (gigData.description) newEvent.description = gigData.description;
  if (gigData.endDate) newEvent.endDate = gigData.endDate;
  if (gigData.startTime) newEvent.startTime = gigData.startTime;
  if (gigData.endTime) newEvent.endTime = gigData.endTime;
  if (gigData.notes) newEvent.notes = gigData.notes;

  // Public gig specific fields (for future Frontstage features)
  if (gigData.ticketUrl) newEvent.ticketUrl = gigData.ticketUrl;
  if (gigData.ticketPrice) newEvent.ticketPrice = gigData.ticketPrice;
  if (gigData.doorsTime) newEvent.doorsTime = gigData.doorsTime;

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
      headers: getCorsHeaders(),
      body: JSON.stringify({
        error: 'Duplicate gig detected - this artist already has a gig at this venue on this date',
        existingEvent: duplicateCheck.Items[0]
      })
    };
  }

  // Create the event
  await dynamodb.put({
    TableName: EVENTS_TABLE,
    Item: newEvent
  }).promise();

  console.log('PUBLIC_GIG: Created successfully', {
    eventId,
    artistId,
    venueId: gigData.venueId,
    geohash6: geohashFields.geohash6,
    coordinates: { lat: geohashFields.geoLat, lng: geohashFields.geoLng }
  });

  return {
    statusCode: 201,
    headers: getCorsHeaders(),
    body: JSON.stringify(newEvent)
  };
};

// GET /api/events/public/geo - Public geo query (NO AUTH)
const handleGetPublicEventsGeo = async (event) => {
  const { geohash, startDate, endDate } = event.queryStringParameters || {};

  if (!geohash || !startDate || !endDate) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
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
    headers: getCorsHeaders(),
    body: JSON.stringify({ events: lightweightEvents })
  };
};

// POST /api/events/batch - Batch fetch with joins (NO AUTH)
const handleBatchEventsWithJoins = async (event) => {
  const { eventIds } = JSON.parse(event.body || '{}');

  if (!eventIds || !Array.isArray(eventIds) || eventIds.length === 0) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'eventIds array required' })
    };
  }

  if (eventIds.length > 100) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
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
      latitude: venueMap[e.venueId].latitude,
      longitude: venueMap[e.venueId].longitude
    } : null
  }));

  console.log('BATCH_EVENTS: Returning enriched events', { count: enrichedEvents.length });

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({ events: enrichedEvents })
  };
};

// GET /api/venues/:venueId/events - Get venue events (NO AUTH)
const handleGetVenueEvents = async (event) => {
  const { venueId } = event.pathParameters;
  const { startDate, endDate } = event.queryStringParameters || {};

  if (!startDate || !endDate) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
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
    headers: getCorsHeaders(),
    body: JSON.stringify({ events: enrichedEvents })
  };
};

// GET /api/events/public - Get ALL public events in date range (NO AUTH)
const handleGetAllPublicEvents = async (event) => {
  const { startDate, endDate } = event.queryStringParameters || {};

  // Default to today if no startDate provided
  const today = new Date().toISOString().split('T')[0];
  const start = startDate || today;
  const end = endDate || '2099-12-31';

  console.log('PUBLIC_ALL: Query received', { startDate: start, endDate: end });

  try {
    // Scan table with FilterExpression (no GSI needed - simple and works for 250 events/weekend)
    const result = await dynamodb.scan({
      TableName: EVENTS_TABLE,
      FilterExpression: 'isPublic = :true AND #date BETWEEN :start AND :end',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: {
        ':true': true,
        ':start': start,
        ':end': end
      }
    }).promise();

    const allEvents = result.Items || [];

    console.log('PUBLIC_ALL: Found events', { count: allEvents.length });

    // Return full event data (clustering on client will handle display)
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({ events: allEvents })
    };
  } catch (error) {
    console.error('PUBLIC_ALL: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Failed to fetch events' })
    };
  }
};

// Main handler
exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  // HTTP API v2 compatibility
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;

  console.log('EVENTS: Request received', { method, path, pathParameters: event.pathParameters });

  // OPTIONS for CORS
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: ''
    };
  }

  try {
    // Route requests
    const routeKey = `${method} ${path}`;

    // PUBLIC ROUTES (NO AUTH REQUIRED) - Check these BEFORE auth
    if (routeKey.match(/GET \/api\/events\/public\/geo/)) {
      return await handleGetPublicEventsGeo(event);
    }

    if (routeKey.match(/GET \/api\/events\/public$/)) {
      return await handleGetAllPublicEvents(event);
    }

    if (routeKey.match(/POST \/api\/events\/batch/)) {
      return await handleBatchEventsWithJoins(event);
    }

    if (routeKey.match(/GET \/api\/venues\/[^/]+\/events/)) {
      return await handleGetVenueEvents(event);
    }

    // AUTHENTICATED ROUTES - Require auth for everything else
    const authResult = requireAuth(event);
    if (authResult.statusCode === 401) {
      return authResult;
    }
    const { session } = authResult;

    // Unified calendar
    if (routeKey.match(/GET \/api\/artists\/[^/]+\/calendar/)) {
      return await handleGetCalendar(event, session);
    }

    // Create artist event
    if (routeKey.match(/POST \/api\/artists\/[^/]+\/events$/) && !path.includes('/user')) {
      return await handleCreateArtistEvent(event, session);
    }

    // Create user unavailability (artist-agnostic)
    if (routeKey.match(/POST \/api\/users\/me\/unavailability/)) {
      return await handleCreateUserUnavailability(event, session);
    }

    // Get single event
    if (routeKey.match(/GET \/api\/artists\/[^/]+\/events\/[^/]+$/) && !path.includes('/check-conflicts')) {
      return await handleGetEvent(event, session);
    }

    // Update event
    if (routeKey.match(/PUT \/api\/artists\/[^/]+\/events\/[^/]+/)) {
      return await handleUpdateEvent(event, session);
    }

    // Delete event
    if (routeKey.match(/DELETE \/api\/artists\/[^/]+\/events\/[^/]+/)) {
      return await handleDeleteEvent(event, session);
    }

    // Check conflicts
    if (routeKey.match(/POST \/api\/artists\/[^/]+\/events\/check-conflicts/)) {
      return await handleCheckConflicts(event, session);
    }

    // Create public gig (new dedicated endpoint)
    if (routeKey.match(/POST \/api\/artists\/[^/]+\/public-gigs/)) {
      return await handleCreatePublicGig(event, session);
    }

    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Route not found', routeKey })
    };

  } catch (error) {
    console.error('EVENTS: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: error.message })
    };
  }
};
