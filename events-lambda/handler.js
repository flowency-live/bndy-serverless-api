// BNDY Events Lambda Function - Calendar System
// Handles: Artist events, user unavailability, unified calendar

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const ngeohash = require('ngeohash');
const ics = require('ics');

// Calendar sync modules
const { createCancellationRecord, getCancellationsForArtist } = require('./calendar-cancellations');
const { createCalendarToken, validateToken, getCalendarTokens, revokeCalendarToken, updateTokenLastUsed } = require('./calendar-tokens');
const { generateIcalFeed, eventToVEvent } = require('./ical-generator');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });
const lambda = new AWS.Lambda({ region: 'eu-west-2' });

// Configuration
const EVENTS_TABLE = 'bndy-events';
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';
const ARTISTS_TABLE = 'bndy-artists';
const VENUES_TABLE = 'bndy-venues';
const USERS_TABLE = 'bndy-users';
const ARTIST_VENUES_TABLE = 'bndy-artist-venues';

// JWT Secret - cached after first retrieval
let JWT_SECRET = null;

/**
 * Get JWT secret from SSM Parameter Store with fallback to env var
 */
async function getJWTSecret() {
  if (JWT_SECRET) {
    return JWT_SECRET; // Return cached value
  }

  // Try SSM first
  try {
    const result = await ssm.getParameter({
      Name: '/bndy/auth/jwt-secret',
      WithDecryption: true
    }).promise();
    JWT_SECRET = result.Parameter.Value;
    console.log('[EVENTS] JWT_SECRET loaded from SSM');
    return JWT_SECRET;
  } catch (error) {
    console.error('[EVENTS] Failed to get JWT_SECRET from SSM:', error.message);
    // Fallback to environment variable
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      console.log('[EVENTS] JWT_SECRET loaded from environment variable (fallback)');
      return JWT_SECRET;
    }
    throw new Error('JWT_SECRET not available from SSM or environment');
  }
}

// Allowed CORS origins for frontend access
const ALLOWED_ORIGINS = [
  'https://www.bndy.co.uk',       // Primary domain
  'https://backstage.bndy.co.uk', // Legacy domain
  'https://bndy.co.uk',            // Apex domain
  'https://live.bndy.co.uk',      // Frontstage
  'http://localhost:3000'          // Local development
];

// Module-level variable to store current request event for CORS
let currentEvent = null;

// Get appropriate origin for CORS based on request origin
const getAllowedOrigin = () => {
  const requestOrigin = currentEvent?.headers?.origin || currentEvent?.headers?.Origin;
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
};

// Generate CORS headers with dynamic origin
const getCorsHeaders = () => ({
  'Access-Control-Allow-Origin': getAllowedOrigin(),
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
const requireAuth = async (event) => {
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
    const jwtSecret = await getJWTSecret();
    const session = jwt.verify(sessionToken, jwtSecret);

    // Fetch user to check platformAdmin flag
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: session.userId }
    }).promise();

    const platformAdmin = userResult.Item?.platformAdmin || false;

    return {
      user: {
        ...session,
        platformAdmin
      }
    };
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

// Trigger notification via NotificationsFunction
async function triggerNotification(type, artistId, userId, metadata) {
  const notificationsFunctionName = process.env.NOTIFICATIONS_FUNCTION_NAME;

  if (!notificationsFunctionName) {
    console.log('[NOTIFICATION] NOTIFICATIONS_FUNCTION_NAME not configured, skipping notification');
    return;
  }

  try {
    // Get performer name
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: userId }
    }).promise();

    const performedByName = userResult.Item?.display_name ||
                           userResult.Item?.first_name ||
                           'Unknown User';

    // Query all artist members
    const membershipsResult = await dynamodb.query({
      TableName: MEMBERSHIPS_TABLE,
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      ExpressionAttributeValues: {
        ':artistId': artistId
      }
    }).promise();

    // Filter out the performer - they shouldn't get notified about their own action
    const recipients = (membershipsResult.Items || [])
      .filter(member => member.user_id !== userId)
      .map(member => member.user_id);

    console.log('[NOTIFICATION] Triggering notification:', {
      type,
      artistId: artistId.substring(0, 8) + '...',
      recipientCount: recipients.length
    });

    // Create notification for each recipient
    for (const recipientUserId of recipients) {
      const payload = {
        action: 'create',
        type: type,
        priority: 'normal',
        artistId: artistId,
        performedByUserId: userId,
        performedByName: performedByName,
        recipientUserId: recipientUserId,
        metadata: metadata
      };

      await lambda.invoke({
        FunctionName: notificationsFunctionName,
        InvocationType: 'Event',
        Payload: JSON.stringify(payload)
      }).promise();
    }

    console.log('[NOTIFICATION] Notifications triggered successfully for', recipients.length, 'recipients');
  } catch (error) {
    console.error('[NOTIFICATION] Failed to trigger notification (non-blocking):', error.message);
  }
}

// Date helpers
const addDays = (dateStr, days) => {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
};

const subtractDays = (dateStr, days) => {
  return addDays(dateStr, -days);
};

// Validate recurring event rules
const validateRecurring = (recurring) => {
  if (!recurring) return null;

  const validTypes = ['day', 'week', 'month', 'year'];
  const validDurations = ['forever', 'count', 'until'];

  if (!validTypes.includes(recurring.type)) {
    return 'recurring.type must be one of: day, week, month, year';
  }

  if (typeof recurring.interval !== 'number' || recurring.interval < 1 || recurring.interval > 99) {
    return 'recurring.interval must be a number between 1 and 99';
  }

  if (!validDurations.includes(recurring.duration)) {
    return 'recurring.duration must be one of: forever, count, until';
  }

  if (recurring.duration === 'count') {
    if (typeof recurring.count !== 'number' || recurring.count < 1) {
      return 'recurring.count must be a number greater than 0';
    }
  }

  if (recurring.duration === 'until') {
    if (!recurring.until || !/^\d{4}-\d{2}-\d{2}$/.test(recurring.until)) {
      return 'recurring.until must be a valid date in YYYY-MM-DD format';
    }
  }

  return null;
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

// Helper: Clear availability events for date range (auto-clear when events created)
const clearAvailabilityForDates = async (artistId, startDate, endDate) => {
  try {
    console.log('AUTO_CLEAR: Checking for availability to clear', { artistId, startDate, endDate });

    const result = await dynamodb.query({
      TableName: EVENTS_TABLE,
      IndexName: 'artistId-date-index',
      KeyConditionExpression: 'artistId = :artistId AND #date BETWEEN :start AND :end',
      FilterExpression: '#type = :available',
      ExpressionAttributeNames: { '#date': 'date', '#type': 'type' },
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':start': startDate,
        ':end': endDate,
        ':available': 'available'
      }
    }).promise();

    const availabilityEvents = result.Items || [];

    if (availabilityEvents.length > 0) {
      console.log('AUTO_CLEAR: Deleting availability events', { count: availabilityEvents.length });

      for (const event of availabilityEvents) {
        await dynamodb.delete({
          TableName: EVENTS_TABLE,
          Key: { id: event.id }
        }).promise();
        console.log('AUTO_CLEAR: Deleted availability', { eventId: event.id, date: event.date });
      }
    } else {
      console.log('AUTO_CLEAR: No availability events found to clear');
    }
  } catch (error) {
    // Non-blocking - log error but don't fail the event creation
    console.error('AUTO_CLEAR: Failed to clear availability (non-blocking)', { error: error.message });
  }
};

// Helper: Ensure artist-venue relationship exists (auto-create for Venue CRM)
const ensureVenueRelationship = async (artistId, venueId, gigDate) => {
  try {
    // Check if relationship already exists
    const existingRelationship = await dynamodb.query({
      TableName: ARTIST_VENUES_TABLE,
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      FilterExpression: 'venue_id = :venueId',
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':venueId': venueId
      }
    }).promise();

    if (existingRelationship.Items && existingRelationship.Items.length > 0) {
      console.log('VENUE_CRM: Relationship already exists', { artistId, venueId });

      // Update first_gig_date if this gig is earlier
      const relationship = existingRelationship.Items[0];
      if (!relationship.first_gig_date || gigDate < relationship.first_gig_date) {
        await dynamodb.update({
          TableName: ARTIST_VENUES_TABLE,
          Key: { id: relationship.id },
          UpdateExpression: 'SET first_gig_date = :date, updated_at = :now',
          ExpressionAttributeValues: {
            ':date': gigDate,
            ':now': new Date().toISOString()
          }
        }).promise();
        console.log('VENUE_CRM: Updated first_gig_date', { artistId, venueId, date: gigDate });
      }

      return;
    }

    // Create new artist-venue relationship
    const relationshipId = crypto.randomUUID();
    const now = new Date().toISOString();

    const newRelationship = {
      id: relationshipId,
      artist_id: artistId,
      venue_id: venueId,
      first_gig_date: gigDate,
      managed_on_bndy: false,
      created_at: now,
      updated_at: now
    };

    await dynamodb.put({
      TableName: ARTIST_VENUES_TABLE,
      Item: newRelationship
    }).promise();

    console.log('VENUE_CRM: Auto-created venue relationship', {
      relationshipId,
      artistId,
      venueId,
      firstGigDate: gigDate
    });
  } catch (error) {
    // Log error but don't fail the gig creation
    console.error('VENUE_CRM: Failed to auto-create venue relationship', {
      error: error.message,
      artistId,
      venueId
    });
  }
};

// Generate occurrences from recurring event rules
const generateOccurrences = (event, rangeStart, rangeEnd) => {
  if (!event.recurring) return [event];

  const occurrences = [];
  const start = new Date(event.date);
  const end = new Date(rangeEnd);
  let current = new Date(start);
  let count = 0;

  while (current <= end) {
    if (current >= new Date(rangeStart)) {
      occurrences.push({
        ...event,
        parentEventId: event.id,
        instanceDate: current.toISOString().split('T')[0],
        isRecurringInstance: true,
        date: current.toISOString().split('T')[0]
      });
    }

    // Advance by interval
    if (event.recurring.type === 'day') {
      current.setDate(current.getDate() + event.recurring.interval);
    } else if (event.recurring.type === 'week') {
      current.setDate(current.getDate() + (event.recurring.interval * 7));
    } else if (event.recurring.type === 'month') {
      current.setMonth(current.getMonth() + event.recurring.interval);
    } else if (event.recurring.type === 'year') {
      current.setFullYear(current.getFullYear() + event.recurring.interval);
    }

    count++;

    // Check duration conditions
    if (event.recurring.duration === 'count' && count >= event.recurring.count) break;
    if (event.recurring.duration === 'until' && current > new Date(event.recurring.until)) break;
  }

  return occurrences;
};

// GET /api/artists/:artistId/calendar - Unified calendar (3 sources)
const handleGetCalendar = async (event, user) => {
  console.log('CALENDAR DEBUG: Start', { user, pathParameters: event.pathParameters, queryStringParameters: event.queryStringParameters });

  const { artistId } = event.pathParameters;
  const { startDate, endDate } = event.queryStringParameters || {};

  if (!startDate || !endDate) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'startDate and endDate required' })
    };
  }

  console.log('CALENDAR DEBUG: Verifying membership', { userId: user.userId, artistId });

  // Check access - platform admin OR member
  let membership = null;
  if (!user.platformAdmin) {
    membership = await verifyMembership(user.userId, artistId);
    if (!membership) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
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
          // SKIP availability events - these should only show in their base artist
          if (event.type === 'available') {
            return;
          }

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

  // Expand recurring events into occurrences
  const expandRecurring = (events) => events.flatMap(event =>
    generateOccurrences(event, startDate, endDate)
  );

  // Post-filter to exact date range
  const filterToRange = (events) => events.filter(e => {
    const eventStart = e.date;
    const eventEnd = e.endDate || e.date;
    return eventStart <= endDate && eventEnd >= startDate;
  });

  // Expand recurring events BEFORE filtering
  const expandedArtistEvents = expandRecurring(artistEventsResult.Items || []);
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
    otherArtistEvents: filterToRange(expandedOtherArtistEvents).map(transformEvent) // Already has artistDisplayColour
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

// GET /api/artists/:artistId/events - Get all artist events (no date filter)
const handleGetAllArtistEvents = async (event, user) => {
  const { artistId } = event.pathParameters;

  // Check access - platform admin OR member
  if (!user.platformAdmin) {
    const membership = await verifyMembership(user.userId, artistId);
    if (!membership) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
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
    headers: getCorsHeaders(),
    body: JSON.stringify(transformedEvents)
  };
};

// POST /api/artists/:artistId/events - Create artist event
const handleCreateArtistEvent = async (event, user) => {
  const { artistId } = event.pathParameters;
  const eventData = JSON.parse(event.body);

  // Check access - member first, then platform admin fallback
  let membership = await verifyMembership(user.userId, artistId);

  if (membership) {
    // User is a member - allow any event type
    console.log('[EVENTS] Member access granted for event creation');
  } else if (user.platformAdmin) {
    // Not a member, but platform admin - restrict to gig events only
    const allowedTypes = ['gig', 'public_gig', 'gig-public', 'gig-private'];
    if (!allowedTypes.includes(eventData.type)) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
        body: JSON.stringify({
          error: 'Platform admins can only create gig events',
          allowedTypes
        })
      };
    }
    console.log('[EVENTS] Platform admin access granted for gig creation');
    // Create a minimal membership object for compatibility
    membership = { user_id: user.userId, artist_id: artistId, membership_id: 'platform-admin' };
  } else {
    // Not a member and not platform admin - deny access
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

  // Validate recurring rules if present
  if (eventData.recurring) {
    const recurringError = validateRecurring(eventData.recurring);
    if (recurringError) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: recurringError })
      };
    }
  }

  // Auto-create venue relationship if this is a gig with a venueId
  if (eventData.venueId && (eventData.type === 'gig' || eventData.type === 'public_gig')) {
    await ensureVenueRelationship(artistId, eventData.venueId, eventData.date);
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
  if (eventData.recurring) newEvent.recurring = eventData.recurring;

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

  // Auto-clear availability for the date range (silent operation)
  if (eventData.type !== 'available') {
    await clearAvailabilityForDates(artistId, newEvent.date, newEvent.endDate || newEvent.date);
  }

  // Skip notifications for platform admin events
  const skipNotifications = user.platformAdmin;

  if (!skipNotifications) {
    // Trigger notifications for gigs and rehearsals
    if (eventData.type === 'gig' || eventData.type === 'public_gig') {
      await triggerNotification(
        'gig_added',
        artistId,
        user.userId,
        {
          eventId: eventId,
          venueName: eventData.title || eventData.location || 'TBA',
          eventDate: eventData.date
        }
      );
    } else if (eventData.type === 'practice') {
      await triggerNotification(
        'rehearsal_added',
        artistId,
        user.userId,
        {
          eventId: eventId,
          eventDate: eventData.date,
          startTime: eventData.startTime
        }
      );
    }
  } else {
    console.log('[EVENTS] Skipping notifications for platform admin event creation');
  }

  return {
    statusCode: 201,
    headers: getCorsHeaders(),
    body: JSON.stringify(newEvent)
  };
};

// POST /api/users/me/unavailability - Create user unavailability event (artist-agnostic)
const handleCreateUserUnavailability = async (event, user) => {
  const eventData = JSON.parse(event.body);

  // Validate required fields
  if (!eventData.date) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'date is required' })
    };
  }

  // Validate recurring rules if present
  if (eventData.recurring) {
    const recurringError = validateRecurring(eventData.recurring);
    if (recurringError) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: recurringError })
      };
    }
  }

  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Build user event - omit sparse GSI keys (artistId, venueId, geohash6, membershipId)
  const unavailableEvent = {
    id: eventId,
    // artistId omitted (not null) for sparse GSI - XOR: user event
    ownerUserId: user.userId,
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
  if (eventData.recurring) unavailableEvent.recurring = eventData.recurring;

  // User events never have: venueId, geohash, location, startTime, endTime (all-day only)

  await dynamodb.put({
    TableName: EVENTS_TABLE,
    Item: unavailableEvent
  }).promise();

  console.log('EVENT: Created user unavailability', { eventId, userId: user.userId });

  return {
    statusCode: 201,
    headers: getCorsHeaders(),
    body: JSON.stringify(unavailableEvent)
  };
};

// GET /api/artists/:artistId/events/:id - Get single event
const handleGetEvent = async (event, user) => {
  const { artistId, id } = event.pathParameters;

  // Check access - platform admin OR member
  if (!user.platformAdmin) {
    const membership = await verifyMembership(user.userId, artistId);
    if (!membership) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Not a member of this artist' })
      };
    }
  } else {
    console.log('[EVENTS] Platform admin access granted for event view');
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
const handleUpdateEvent = async (event, user) => {
  const { artistId, id } = event.pathParameters;
  const updates = JSON.parse(event.body);

  // Check access - platform admin OR member
  if (!user.platformAdmin) {
    const membership = await verifyMembership(user.userId, artistId);
    if (!membership) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Not a member of this artist' })
      };
    }
  } else {
    console.log('[EVENTS] Platform admin access granted for event update');
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
  if (existingEvent.type === 'unavailable' && existingEvent.ownerUserId !== user.userId) {
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

// GET /api/events/by-external-id - Lookup event by external ID (public endpoint)
const handleGetEventByExternalId = async (event) => {
  const source = event.queryStringParameters?.source;
  const externalId = event.queryStringParameters?.id;

  console.log(`[Events] Looking up event by external ID: ${source}:${externalId}`);

  if (!source || !externalId) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'source and id query parameters are required' })
    };
  }

  try {
    // Paginated scan to find event with matching externalId
    let matchingEvent = null;
    let lastEvaluatedKey = undefined;

    do {
      const scanParams = {
        TableName: EVENTS_TABLE,
        ExclusiveStartKey: lastEvaluatedKey
      };

      const result = await dynamodb.scan(scanParams).promise();

      // Find event with matching externalId in this batch
      matchingEvent = result.Items.find(evt => {
        const externalIds = evt.external_ids || [];
        return externalIds.some(ext => ext.source === source && ext.id === externalId);
      });

      if (matchingEvent) break;

      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    if (!matchingEvent) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({
          found: false,
          source,
          externalId,
          message: `No event found with external ID ${source}:${externalId}`
        })
      };
    }

    // Get venue and artist details
    let venueName = null;
    let artistName = null;

    if (matchingEvent.venueId) {
      const venueResult = await dynamodb.get({
        TableName: VENUES_TABLE,
        Key: { id: matchingEvent.venueId }
      }).promise();
      venueName = venueResult.Item?.name || null;
    }

    if (matchingEvent.artistId) {
      const artistResult = await dynamodb.get({
        TableName: ARTISTS_TABLE,
        Key: { id: matchingEvent.artistId }
      }).promise();
      artistName = artistResult.Item?.name || null;
    }

    const eventResponse = {
      id: matchingEvent.id,
      title: matchingEvent.title,
      date: matchingEvent.date,
      startTime: matchingEvent.startTime,
      endTime: matchingEvent.endTime,
      artistId: matchingEvent.artistId,
      artistName,
      venueId: matchingEvent.venueId,
      venueName,
      type: matchingEvent.type,
      isPublic: matchingEvent.isPublic,
      externalIds: matchingEvent.external_ids || [],
      source: matchingEvent.source,
      createdAt: matchingEvent.createdAt,
      updatedAt: matchingEvent.updatedAt
    };

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        found: true,
        source,
        externalId,
        event: eventResponse
      })
    };
  } catch (error) {
    console.error('[ERROR] External ID lookup failed:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

// PUT /api/events/:id/mcp - Update event via MCP (NO AUTH)
const handleUpdateEventMcp = async (event) => {
  const { id } = event.pathParameters;
  const updates = JSON.parse(event.body || '{}');

  console.log('[MCP] Updating event', { eventId: id, updates });

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

  // Build update expression
  const updateExpressions = [];
  const attributeNames = {};
  const attributeValues = {};

  // Fields that MCP can update (apiField: dbField)
  const allowedFields = {
    'title': 'title',
    'date': 'date',
    'startTime': 'startTime',
    'endTime': 'endTime',
    'venueId': 'venueId',
    'description': 'description',
    'isPublic': 'isPublic',
    'ticketed': 'ticketed',
    'ticketUrl': 'ticketUrl',
    'ticketinformation': 'ticketinformation',
    'price': 'price',
    'imageUrl': 'imageUrl',
    'eventUrl': 'eventUrl',
    'notes': 'notes',
    'externalIds': 'external_ids'
  };

  Object.entries(allowedFields).forEach(([apiField, dbField]) => {
    if (updates[apiField] !== undefined) {
      const placeholder = `#${dbField}`;
      const valuePlaceholder = `:${dbField}`;
      attributeNames[placeholder] = dbField;
      attributeValues[valuePlaceholder] = updates[apiField];
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

  // Fetch updated event with venue details
  const updated = await dynamodb.get({
    TableName: EVENTS_TABLE,
    Key: { id }
  }).promise();

  const updatedEvent = updated.Item;

  // Get venue name if venueId exists
  let venueName = null;
  if (updatedEvent.venueId) {
    const venueResult = await dynamodb.get({
      TableName: VENUES_TABLE,
      Key: { id: updatedEvent.venueId }
    }).promise();
    venueName = venueResult.Item?.name || null;
  }

  console.log('[MCP] Event updated successfully', { eventId: id });

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({
      ...updatedEvent,
      externalIds: updatedEvent.external_ids || [],
      venueName
    })
  };
};

// GET /api/events/:id/mcp - Get event by ID via MCP (NO AUTH)
// Public read-only endpoint for MCP tools to fetch event details
const handleGetEventMcp = async (event) => {
  const { id } = event.pathParameters;

  console.log('[MCP] Getting event', { eventId: id });

  // Get event from database
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

  const eventItem = result.Item;

  // Get venue details if venueId exists
  let venueName = null;
  let venueCity = null;
  if (eventItem.venueId) {
    const venueResult = await dynamodb.get({
      TableName: VENUES_TABLE,
      Key: { id: eventItem.venueId }
    }).promise();
    if (venueResult.Item) {
      venueName = venueResult.Item.name || null;
      venueCity = venueResult.Item.city || null;
    }
  }

  // Get artist name if artistId exists
  let artistName = null;
  if (eventItem.artistId) {
    const artistResult = await dynamodb.get({
      TableName: ARTISTS_TABLE,
      Key: { id: eventItem.artistId }
    }).promise();
    artistName = artistResult.Item?.name || null;
  }

  // Get collaborating artist names for multi-artist events
  const collaboratingArtistIds = eventItem.collaboratingArtistIds || [];
  let collaboratingArtistNames = [];
  if (collaboratingArtistIds.length > 0) {
    const results = await Promise.all(
      collaboratingArtistIds.map(id => dynamodb.get({
        TableName: ARTISTS_TABLE,
        Key: { id }
      }).promise())
    );
    collaboratingArtistNames = results.filter(r => r.Item).map(r => r.Item.name);
  }

  // Build full arrays for multi-artist support
  const artistIds = [eventItem.artistId, ...collaboratingArtistIds].filter(Boolean);
  const artistNames = [artistName, ...collaboratingArtistNames].filter(Boolean);

  console.log('[MCP] Event retrieved successfully', { eventId: id, artistCount: artistIds.length });

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({
      id: eventItem.id,
      title: eventItem.title,
      date: eventItem.date,
      startTime: eventItem.startTime,
      endTime: eventItem.endTime,
      artistId: eventItem.artistId,
      artistName,
      artistIds,
      artistNames,
      venueId: eventItem.venueId,
      venueName,
      venueCity,
      description: eventItem.description,
      ticketed: eventItem.ticketed,
      ticketUrl: eventItem.ticketUrl,
      ticketinformation: eventItem.ticketinformation,
      price: eventItem.price,
      imageUrl: eventItem.imageUrl,
      eventUrl: eventItem.eventUrl,
      notes: eventItem.notes,
      isPublic: eventItem.isPublic,
      source: eventItem.source,
      externalIds: eventItem.external_ids || [],
      aiCreated: eventItem.aiCreated,
      needsReview: eventItem.needsReview,
      createdAt: eventItem.createdAt,
      updatedAt: eventItem.updatedAt
    })
  };
};

// POST /api/artists/:artistId/events/:id/leave - Leave a multi-artist event
// Allows a collaborating artist to remove themselves without deleting the event
const handleLeaveEvent = async (event) => {
  const { artistId, id } = event.pathParameters;

  console.log('LEAVE_EVENT: Request received', { artistId, eventId: id });

  try {
    // Get the existing event
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
    const collaboratingArtistIds = existingEvent.collaboratingArtistIds || [];

    // Check if artist is the primary artist (cannot leave, must delete)
    if (existingEvent.artistId === artistId) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({
          error: 'Primary artist cannot leave event. Use delete to remove the event entirely.'
        })
      };
    }

    // Check if artist is in the collaborating list
    if (!collaboratingArtistIds.includes(artistId)) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Artist is not part of this event' })
      };
    }

    // Remove artist from collaboratingArtistIds
    const updatedCollaboratingIds = collaboratingArtistIds.filter(id => id !== artistId);

    await dynamodb.update({
      TableName: EVENTS_TABLE,
      Key: { id },
      UpdateExpression: 'SET collaboratingArtistIds = :ids, updatedAt = :now',
      ExpressionAttributeValues: {
        ':ids': updatedCollaboratingIds,
        ':now': new Date().toISOString()
      }
    }).promise();

    console.log('LEAVE_EVENT: Artist removed from event', { artistId, eventId: id, remainingCollaborators: updatedCollaboratingIds.length });

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        message: `Artist ${artistId} has left the event`,
        eventId: id,
        remainingCollaborators: updatedCollaboratingIds
      })
    };
  } catch (error) {
    console.error('LEAVE_EVENT: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Failed to leave event' })
    };
  }
};

// DELETE /api/artists/:artistId/events/:id - Delete event
const handleDeleteEvent = async (event, user) => {
  const { artistId, id } = event.pathParameters;

  // Check access - platform admin OR member
  if (!user.platformAdmin) {
    const membership = await verifyMembership(user.userId, artistId);
    if (!membership) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Not a member of this artist' })
      };
    }
  } else {
    console.log('[EVENTS] Platform admin access granted for event deletion');
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
  if (existingEvent.type === 'unavailable') {
    if (existingEvent.ownerUserId !== user.userId) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Can only delete your own unavailability' })
      };
    }
    // For unavailability events, skip the artistId check (they don't have artistId)
  } else {
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
  }

  await dynamodb.delete({
    TableName: EVENTS_TABLE,
    Key: { id }
  }).promise();

  console.log('EVENT: Deleted event', { eventId: id });

  // Create cancellation record for calendar sync (RFC 5545 METHOD:CANCEL)
  // This allows calendar apps to properly remove the event on next sync
  try {
    await createCancellationRecord(existingEvent, user.userId);
    console.log('EVENT: Created cancellation record for calendar sync', { eventId: id });
  } catch (cancelErr) {
    console.error('EVENT: Failed to create cancellation record (non-fatal)', cancelErr);
  }

  // Skip notifications for platform admin events
  const skipNotifications = user.platformAdmin;

  if (!skipNotifications) {
    // Trigger notifications for deleted gigs and rehearsals
    if (existingEvent.type === 'gig' || existingEvent.type === 'public_gig') {
      await triggerNotification(
        'gig_removed',
        artistId,
        user.userId,
        {
          venueName: existingEvent.title || existingEvent.location || 'TBA',
          eventDate: existingEvent.date
        }
      );
    } else if (existingEvent.type === 'practice') {
      await triggerNotification(
        'rehearsal_removed',
        artistId,
        user.userId,
        {
          eventDate: existingEvent.date
        }
      );
    }
  } else {
    console.log('[EVENTS] Skipping notifications for platform admin event deletion');
  }

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

  // No auth required - public endpoint for conflict checking (read-only operation)
  // Community users need to check conflicts when creating events

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
    headers: getCorsHeaders(),
    body: JSON.stringify({
      hasConflicts: enrichedConflicts.length > 0,
      conflicts: enrichedConflicts
    })
  };
};

// POST /api/public-gigs/create - Create public gig with venue resolution
const handleCreatePublicGig = async (event, user) => {
  const { artistId } = event.pathParameters;
  const gigData = JSON.parse(event.body);

  console.log('PUBLIC_GIG: Create request', { artistId, gigData });

  // Check access - platform admin OR member
  let membership = null;
  if (!user.platformAdmin) {
    membership = await verifyMembership(user.userId, artistId);
    if (!membership) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
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

  // Auto-create venue relationship before creating the event
  await ensureVenueRelationship(artistId, gigData.venueId, gigData.date);

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

  // Skip notifications for platform admin events
  const skipNotifications = user.platformAdmin;

  if (!skipNotifications) {
    // Trigger gig_added notification
    await triggerNotification(
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
      city: venueMap[e.venueId].city,
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
    const enrichedEvents = allEvents.map(e => {
      // Build full artistIds array (primary + collaborating)
      const eventArtistIds = e.artistId ? [e.artistId] : [];
      if (e.collaboratingArtistIds && Array.isArray(e.collaboratingArtistIds)) {
        eventArtistIds.push(...e.collaboratingArtistIds);
      }
      // Build artistNames array from artistIds
      const eventArtistNames = eventArtistIds.map(id => artistMap[id]?.name).filter(Boolean);

      return {
        ...e,
        artistName: artistMap[e.artistId]?.name,
        artistIds: eventArtistIds.length > 0 ? eventArtistIds : undefined,
        artistNames: eventArtistNames.length > 0 ? eventArtistNames : undefined,
        venueName: venueMap[e.venueId]?.name,
        venue: venueMap[e.venueId] ? {
          city: venueMap[e.venueId].city
        } : null
      };
    });

    console.log('PUBLIC_ALL: Enriched events with artist and venue data');

    // Return full event data (clustering on client will handle display)
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({ events: enrichedEvents })
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

// GET /api/artists/:artistId/public-events - Get public events for an artist (NO AUTH)
const handleGetArtistPublicEvents = async (event) => {
  console.log('ARTIST_PUBLIC_EVENTS: Handler invoked', { pathParameters: event.pathParameters, queryStringParameters: event.queryStringParameters });

  if (!event.pathParameters || !event.pathParameters.artistId) {
    console.error('ARTIST_PUBLIC_EVENTS: Missing artistId in pathParameters');
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
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
    const enrichedEvents = events.map(e => {
      const venue = venueMap[e.venueId];
      return {
        ...e,
        venueName: venue?.name || e.venueName || 'Unknown Venue',
        venueCity: venue?.city || null
      };
    });

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({ events: enrichedEvents })
    };
  } catch (error) {
    console.error('ARTIST_PUBLIC_EVENTS: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Failed to fetch artist events' })
    };
  }
};

// GET /api/artists/:artistId/public-availability - Get artist availability (NO AUTH)
const handleGetArtistAvailability = async (event) => {
  console.log('ARTIST_AVAILABILITY: Handler invoked', { pathParameters: event.pathParameters, queryStringParameters: event.queryStringParameters });

  if (!event.pathParameters || !event.pathParameters.artistId) {
    console.error('ARTIST_AVAILABILITY: Missing artistId in pathParameters');
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
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
    // Query availability events for this artist
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

    const availability = result.Items || [];

    console.log('ARTIST_AVAILABILITY: Found availability', { artistId, count: availability.length });

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({ availability })
    };
  } catch (error) {
    console.error('ARTIST_AVAILABILITY: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Failed to fetch artist availability' })
    };
  }
};

// POST /api/artists/:artistId/events/toggle-availability - Toggle availability for a date
const handleToggleAvailability = async (event, user) => {
  const { artistId } = event.pathParameters;
  const { date, notes } = JSON.parse(event.body);

  console.log('TOGGLE_AVAILABILITY: Request received', { artistId, date, userId: user.userId });

  // Check access - platform admin OR member
  if (!user.platformAdmin) {
    const membership = await verifyMembership(user.userId, artistId);
    if (!membership) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
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
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Valid date in YYYY-MM-DD format is required' })
    };
  }

  // Validate date is in the future or today
  const today = new Date().toISOString().split('T')[0];
  if (date < today) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
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
        headers: getCorsHeaders(),
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
        headers: getCorsHeaders(),
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
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Failed to toggle availability' })
    };
  }
};

// POST /api/artists/:artistId/events/bulk-availability - Bulk set availability
const handleBulkAvailability = async (event, user) => {
  const { artistId } = event.pathParameters;
  const { startDate, endDate, rules, notes } = JSON.parse(event.body);

  console.log('BULK_AVAILABILITY: Request received', { artistId, startDate, endDate, rules, userId: user.userId });

  // Check access - platform admin OR member
  if (!user.platformAdmin) {
    const membership = await verifyMembership(user.userId, artistId);
    if (!membership) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
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
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'startDate, endDate, and rules array are required' })
    };
  }

  // Validate date range
  const today = new Date().toISOString().split('T')[0];
  if (startDate < today) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Cannot mark past dates as available' })
    };
  }

  if (endDate < startDate) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
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
      headers: getCorsHeaders(),
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
      headers: getCorsHeaders(),
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
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Failed to bulk set availability' })
    };
  }
};

// ============================================================================
// COMMUNITY WIZARD ENDPOINT (Public, No Auth Required)
// ============================================================================

// POST /api/events/community - Create community event (public endpoint)
const handleCreateCommunityEvent = async (event) => {
  console.log('COMMUNITY_EVENT: Create request');

  try {
    const body = JSON.parse(event.body);
    const {
      artistId, artistIds, venueId, date, startTime, endTime, title, isPublic, source, isOpenMic,
      // Enrichment fields (parity with edit_event)
      price, eventUrl, ticketed, ticketInformation, ticketUrl, imageUrl, description, notes
    } = body;

    // Support both single artistId and multiple artistIds
    const artistIdsList = artistIds || (artistId ? [artistId] : []);

    // Validation
    if ((!artistIdsList || artistIdsList.length === 0) && !isOpenMic) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'artistId, artistIds, or isOpenMic flag is required' })
      };
    }

    if (!venueId || !date || !startTime) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'venueId, date, and startTime are required' })
      };
    }

    // Get venue details for geolocation
    const venue = await getVenue(venueId);
    if (!venue) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
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
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: 'Artist not found' })
        };
      }

      artist = artistResult.Item;
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
      endTime: endTime || '00:00',
      type: isOpenMic ? 'open-mic' : 'gig',
      isPublic: isPublic !== undefined ? isPublic : true,
      isAllDay: false,

      // Geolocation
      ...geohashFields,

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

    await dynamodb.put({
      TableName: EVENTS_TABLE,
      Item: newEvent
    }).promise();

    console.log(` Community event created: ${eventId} (${eventTitle})`);

    return {
      statusCode: 201,
      headers: getCorsHeaders(),
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
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

// CALENDAR SYNC HANDLERS
// ============================================

/**
 * POST /api/artists/{artistId}/calendar/subscribe
 * Create a new calendar subscription token
 */
const handleCreateCalendarSubscription = async (event, user) => {
  const { artistId } = event.pathParameters;

  // Verify membership
  const membership = await verifyMembership(user.userId, artistId);
  if (!membership) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
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
      headers: getCorsHeaders(),
      body: JSON.stringify(result)
    };
  } catch (error) {
    console.error('CALENDAR_SYNC: Error creating subscription', error);
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: error.message })
    };
  }
};

/**
 * GET /api/artists/{artistId}/calendar/subscriptions
 * List all active calendar subscriptions for user
 */
const handleGetCalendarSubscriptions = async (event, user) => {
  const { artistId } = event.pathParameters;

  // Verify membership
  const membership = await verifyMembership(user.userId, artistId);
  if (!membership) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
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
      headers: getCorsHeaders(),
      body: JSON.stringify({ subscriptions: withUrls })
    };
  } catch (error) {
    console.error('CALENDAR_SYNC: Error listing subscriptions', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: error.message })
    };
  }
};

/**
 * DELETE /api/artists/{artistId}/calendar/subscriptions/{token}
 * Revoke a calendar subscription token
 */
const handleRevokeCalendarSubscription = async (event, user) => {
  const { artistId, token } = event.pathParameters;

  // Verify membership
  const membership = await verifyMembership(user.userId, artistId);
  if (!membership) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Not a member of this artist' })
    };
  }

  try {
    await revokeCalendarToken(token, user.userId);

    console.log('CALENDAR_SYNC: Revoked subscription token', { artistId, tokenPrefix: token.substring(0, 10) });

    return {
      statusCode: 204,
      headers: getCorsHeaders(),
      body: ''
    };
  } catch (error) {
    console.error('CALENDAR_SYNC: Error revoking subscription', error);
    const statusCode = error.message.includes('not found') ? 404 :
                       error.message.includes('Unauthorized') ? 403 : 500;
    return {
      statusCode,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: error.message })
    };
  }
};

/**
 * GET /api/calendar/ical/{token}
 * Public iCal feed endpoint (token-based auth, no session required)
 * This is used by calendar apps (Google Calendar, Apple Calendar, Outlook)
 */
const handleGetIcalFeed = async (event) => {
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
    // Public gigs: isPublic=true AND type is gig-related
    // Rehearsals: type='rehearsal'
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
};

/**
 * GET /api/artists/{artistId}/events/{id}/ical
 * Download single event as iCal file
 */
const handleGetEventIcal = async (event, user) => {
  const { artistId, id } = event.pathParameters;

  // Verify membership or check if event is public
  const membership = await verifyMembership(user.userId, artistId);

  // Get the event
  const eventResult = await dynamodb.get({
    TableName: EVENTS_TABLE,
    Key: { id }
  }).promise();

  if (!eventResult.Item) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Event not found' })
    };
  }

  const eventData = eventResult.Item;

  // Check access: must be member OR event must be public
  if (!membership && !eventData.isPublic) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
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
        ...getCorsHeaders(),
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`
      },
      body: icalContent
    };
  } catch (error) {
    console.error('CALENDAR_SYNC: Error generating event iCal', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Error generating calendar file' })
    };
  }
};

// Main handler
exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  // Store event for CORS headers
  currentEvent = event;

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
    if (routeKey.match(/GET \/api\/events\/by-external-id/)) {
      return await handleGetEventByExternalId(event);
    }

    if (routeKey.match(/GET \/api\/events\/public\/geo/)) {
      return await handleGetPublicEventsGeo(event);
    }

    if (routeKey.match(/GET \/api\/events\/public$/)) {
      return await handleGetAllPublicEvents(event);
    }

    if (routeKey.match(/GET \/api\/artists\/[^/]+\/public-events/)) {
      return await handleGetArtistPublicEvents(event);
    }

    if (routeKey.match(/GET \/api\/artists\/[^/]+\/public-availability/)) {
      return await handleGetArtistAvailability(event);
    }

    if (routeKey.match(/POST \/api\/events\/batch/)) {
      return await handleBatchEventsWithJoins(event);
    }

    if (routeKey.match(/GET \/api\/venues\/[^/]+\/events/)) {
      return await handleGetVenueEvents(event);
    }

    // Community event creation (public, no auth required)
    if (routeKey.match(/POST \/api\/events\/community/)) {
      return await handleCreateCommunityEvent(event);
    }

    // Integration API: Find-or-create event (API key required)
    if (routeKey.match(/POST \/api\/integration\/events$/)) {
      return await handleIntegrationFindOrCreateEvent(event);
    }

    // MCP event update (public, no auth required)
    if (routeKey.match(/PUT \/api\/events\/[^/]+\/mcp$/)) {
      return await handleUpdateEventMcp(event);
    }

    // MCP event read (public, no auth required)
    if (routeKey.match(/GET \/api\/events\/[^/]+\/mcp$/)) {
      return await handleGetEventMcp(event);
    }

    // Check conflicts (public, no auth required - read-only operation)
    if (routeKey.match(/POST \/api\/artists\/[^/]+\/events\/check-conflicts/)) {
      return await handleCheckConflicts(event, null);
    }

    // iCal feed (token-based auth, no session required)
    // Calendar apps like Google Calendar, Apple Calendar, Outlook use this
    if (routeKey.match(/GET \/api\/calendar\/ical\/[^/]+$/)) {
      return await handleGetIcalFeed(event);
    }

    // AUTHENTICATED ROUTES - Require auth for everything else
    const authResult = await requireAuth(event);
    if (authResult.statusCode === 401) {
      return authResult;
    }
    const { user } = authResult;

    // ============================================
    // CALENDAR SYNC ROUTES (must come BEFORE generic /calendar route)
    // ============================================

    // Create calendar subscription
    if (routeKey.match(/POST \/api\/artists\/[^/]+\/calendar\/subscribe$/)) {
      return await handleCreateCalendarSubscription(event, user);
    }

    // List calendar subscriptions
    if (routeKey.match(/GET \/api\/artists\/[^/]+\/calendar\/subscriptions$/)) {
      return await handleGetCalendarSubscriptions(event, user);
    }

    // Revoke calendar subscription
    if (routeKey.match(/DELETE \/api\/artists\/[^/]+\/calendar\/subscriptions\/[^/]+$/)) {
      return await handleRevokeCalendarSubscription(event, user);
    }

    // Download single event as iCal
    if (routeKey.match(/GET \/api\/artists\/[^/]+\/events\/[^/]+\/ical$/)) {
      return await handleGetEventIcal(event, user);
    }

    // Unified calendar (GENERIC - must come AFTER specific calendar routes)
    if (routeKey.match(/GET \/api\/artists\/[^/]+\/calendar$/)) {
      return await handleGetCalendar(event, user);
    }

    // Get all artist events (no date filter)
    if (routeKey.match(/GET \/api\/artists\/[^/]+\/events$/) && !path.includes('/check-conflicts')) {
      return await handleGetAllArtistEvents(event, user);
    }

    // Toggle availability
    if (routeKey.match(/POST \/api\/artists\/[^/]+\/events\/toggle-availability/)) {
      return await handleToggleAvailability(event, user);
    }

    // Bulk set availability
    if (routeKey.match(/POST \/api\/artists\/[^/]+\/events\/bulk-availability/)) {
      return await handleBulkAvailability(event, user);
    }

    // Create artist event
    if (routeKey.match(/POST \/api\/artists\/[^/]+\/events$/) && !path.includes('/user') && !path.includes('/toggle-availability') && !path.includes('/bulk-availability')) {
      return await handleCreateArtistEvent(event, user);
    }

    // Create user unavailability (artist-agnostic)
    if (routeKey.match(/POST \/api\/users\/me\/unavailability/)) {
      return await handleCreateUserUnavailability(event, user);
    }

    // Get single event
    if (routeKey.match(/GET \/api\/artists\/[^/]+\/events\/[^/]+$/) && !path.includes('/check-conflicts')) {
      return await handleGetEvent(event, user);
    }

    // Update event
    if (routeKey.match(/PUT \/api\/artists\/[^/]+\/events\/[^/]+/)) {
      return await handleUpdateEvent(event, user);
    }

    // Leave event (multi-artist support - remove self from collaborating)
    if (routeKey.match(/POST \/api\/artists\/[^/]+\/events\/[^/]+\/leave/)) {
      return await handleLeaveEvent(event);
    }

    // Delete event
    if (routeKey.match(/DELETE \/api\/artists\/[^/]+\/events\/[^/]+/)) {
      return await handleDeleteEvent(event, user);
    }

    // Create public gig (new dedicated endpoint)
    if (routeKey.match(/POST \/api\/artists\/[^/]+\/public-gigs/)) {
      return await handleCreatePublicGig(event, user);
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

// ============================================================================
// INTEGRATION API ENDPOINTS (API Key Required)
// ============================================================================

// CORS headers for integration API (allows x-api-key header)
const getIntegrationHeaders = () => ({
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,x-api-key',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Credentials': 'false'
});

// Validate API key from request headers
const validateApiKey = (event) => {
  const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'];
  if (!apiKey) return false;
  const validKeys = (process.env.INTEGRATION_API_KEYS || '').split(',').filter(Boolean);
  return validKeys.includes(apiKey);
};

/**
 * Integration API: Find or Create Event
 *
 * Checks for existing event by artistId + date + venueId (existing duplicate check logic).
 * Returns existing if found, creates new if not.
 *
 * Request: { artistId, venueId, date, title?, startTime?, endTime?, ticketUrl?, ticketPrice?, description? }
 * Response: { success, event, isNew, matchMethod }
 */
const handleIntegrationFindOrCreateEvent = async (event) => {
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
    const eventId = require('crypto').randomUUID();

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
};
