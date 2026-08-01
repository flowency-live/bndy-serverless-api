/**
 * Event Data Utilities for Events Lambda
 *
 * Handles event deduplication, venue relationships, and data helpers.
 * Dependencies injected via deps object for testability.
 */

const crypto = require('crypto');
const { eventUniqueKeys, eventNaturalKeys } = require('./identity');
const { gatedPut, releaseUniqueKeys, duplicateResponseBody } = require('./unique-gate');

// Configuration
const EVENTS_TABLE = 'bndy-events';
const VENUES_TABLE = 'bndy-venues';
const ARTIST_VENUES_TABLE = 'bndy-artist-venues';
const ARTISTS_TABLE = 'bndy-artists';

// Private fee fields to strip from public endpoints
const PRIVATE_FEE_FIELDS = ['agreedFee', 'actualFee', 'datePaid', 'paymentMethod', 'splitBetweenMembers', 'noFee', 'distributed'];

// Date helpers
const addDays = (dateStr, days) => {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
};

const subtractDays = (dateStr, days) => {
  return addDays(dateStr, -days);
};

/**
 * Validate recurring event rules
 * @param {Object} recurring - Recurring rules object
 * @returns {string|null} Error message or null if valid
 */
function validateRecurring(recurring) {
  return validateRecurringInner(recurring);
}

/**
 * Sentinel keys for an event, or [] when the event class isn't gated.
 * Gated: any event with a venueId that is a public-facing gig
 * (type gig/public_gig, or isPublic) — the classes automated importers
 * create. Private calendar entries (practice, availability, unavailability)
 * are NOT gated: two practices at one venue on one day are legitimate.
 * Artist-less public events (open-mic class) get the OPENMIC key — closes
 * the community-route skip-hole from the 2026-07-27 audit.
 */
function eventGateKeys(ev) {
  if (!ev || !ev.venueId) return [];
  const isGig = ev.type === 'gig' || ev.type === 'public_gig' || ev.isPublic === true;
  if (!isGig) return [];
  try {
    return eventUniqueKeys({
      venueId: ev.venueId,
      date: ev.date,
      startTime: ev.startTime,
      artistId: ev.artistId,
      artistIds: ev.artistIds,
      collaboratingArtistIds: ev.collaboratingArtistIds,
    });
  } catch (err) {
    // Unparseable date — surface loudly; silent string-drift is exactly how
    // the old advisory check was bypassed.
    throw new Error(`Event uniqueness key failed: ${err.message}`);
  }
}

/**
 * HARD GATE (2026-07-27): write an event + its (venue|artist|date) sentinels
 * in one transaction. Returns the gatedPut result; when .written is false the
 * caller must return 409 using duplicateResponseBody('event', result.existing).
 */
async function putEventGated(dynamodb, newEvent, source) {
  return gatedPut(dynamodb, {
    tableName: EVENTS_TABLE,
    item: newEvent,
    keys: eventGateKeys(newEvent),
    entityType: 'event',
    source: source || newEvent.source || 'events-lambda',
  });
}

/** Best-effort sentinel release for delete/merge paths. */
async function releaseEventSentinels(dynamodb, eventItem) {
  try {
    const keys = eventGateKeys(eventItem);
    if (keys.length) await releaseUniqueKeys(dynamodb, keys, eventItem.id);
  } catch (e) { /* never block a delete on sentinel cleanup */ }
}

function validateRecurringInner(recurring) {
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
}

/**
 * Fetch venue from database
 * @param {Object} dynamodb - DynamoDB DocumentClient
 * @param {string} venueId - Venue ID
 * @returns {Promise<Object|undefined>} Venue object or undefined
 */
async function getVenue(dynamodb, venueId) {
  const result = await dynamodb.get({
    TableName: VENUES_TABLE,
    Key: { id: venueId }
  }).promise();
  return result.Item;
}

/**
 * Check for duplicate events by externalId
 * If any externalId (source+id) already exists, returns matching event
 * @param {Object} dynamodb - DynamoDB DocumentClient
 * @param {Array} externalIds - Array of {source, id} objects
 * @returns {Promise<Object|null>} Matching event or null
 */
async function checkForDuplicateByExternalId(dynamodb, externalIds) {
  if (!externalIds || externalIds.length === 0) {
    return null;
  }

  // Scan for events with matching externalIds
  const params = {
    TableName: EVENTS_TABLE,
    FilterExpression: 'attribute_exists(external_ids)',
    ProjectionExpression: 'id, title, external_ids, #date, startTime, venueId',
    ExpressionAttributeNames: {
      '#date': 'date'
    }
  };

  const allItems = [];
  let lastEvaluatedKey = null;

  do {
    if (lastEvaluatedKey) {
      params.ExclusiveStartKey = lastEvaluatedKey;
    }
    const result = await dynamodb.scan(params).promise();
    if (result && result.Items) {
      allItems.push(...result.Items);
    }
    lastEvaluatedKey = result?.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  // Check for matching externalIds
  for (const existingEvent of allItems) {
    const existingExternalIds = existingEvent.external_ids || [];
    for (const newExtId of externalIds) {
      const match = existingExternalIds.find(
        e => e.source === newExtId.source && e.id === newExtId.id
      );
      if (match) {
        return {
          ...existingEvent,
          matchedExternalId: match
        };
      }
    }
  }

  return null;
}

/**
 * Check for duplicate events (same venue + date + artist)
 * An artist can only have ONE event at a venue on a given day
 * Uses venueId-date-index GSI for efficient lookup
 * @param {Object} dynamodb - DynamoDB DocumentClient
 * @param {string} venueId - Venue ID
 * @param {string} date - Event date (YYYY-MM-DD)
 * @param {Array<string>} artistIds - Array of artist IDs
 * @returns {Promise<Object|null>} Matching event or null
 */
async function checkForDuplicateEvent(dynamodb, venueId, date, artistIds) {
  const params = {
    TableName: EVENTS_TABLE,
    IndexName: 'venueId-date-index',
    KeyConditionExpression: 'venueId = :venueId AND #date = :date',
    ExpressionAttributeNames: {
      '#date': 'date'
    },
    ExpressionAttributeValues: {
      ':venueId': venueId,
      ':date': date
    },
    ProjectionExpression: 'id, title, artistId, collaboratingArtistIds, startTime'
  };

  const result = await dynamodb.query(params).promise();

  if (!result || !result.Items || result.Items.length === 0) {
    return null;
  }

  // Check if any existing event has overlapping artists
  for (const existingEvent of result.Items) {
    const existingArtistIds = [
      existingEvent.artistId,
      ...(existingEvent.collaboratingArtistIds || [])
    ].filter(Boolean);

    const overlap = artistIds.some(id => existingArtistIds.includes(id));
    if (overlap) {
      return existingEvent;
    }
  }

  return null;
}

/**
 * Clear availability events for date range (auto-clear when events created)
 * @param {Object} dynamodb - DynamoDB DocumentClient
 * @param {string} artistId - Artist ID
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 */
async function clearAvailabilityForDates(dynamodb, artistId, startDate, endDate) {
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
    console.error('AUTO_CLEAR: Failed to clear availability (non-blocking)', { error: error.message });
  }
}

/**
 * Ensure artist-venue relationship exists (auto-create for Venue CRM)
 * @param {Object} dynamodb - DynamoDB DocumentClient
 * @param {string} artistId - Artist ID
 * @param {string} venueId - Venue ID
 * @param {string} gigDate - Gig date (YYYY-MM-DD)
 */
async function ensureVenueRelationship(dynamodb, artistId, venueId, gigDate) {
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
    console.error('VENUE_CRM: Failed to auto-create venue relationship', {
      error: error.message,
      artistId,
      venueId
    });
  }
}

/**
 * Update event count for one or more artists (non-blocking side effect)
 * Uses atomic ADD operation for thread safety
 * @param {Object} dynamodb - DynamoDB DocumentClient
 * @param {Array<string>} artistIds - Artist IDs to update
 * @param {number} delta - Change amount (+1 for create, -1 for delete)
 * @param {string} eventDate - Event date (YYYY-MM-DD) to determine future/past
 */
async function updateArtistEventCounts(dynamodb, artistIds, delta, eventDate) {
  if (!artistIds || artistIds.length === 0) return;

  const uniqueArtistIds = [...new Set(artistIds.filter(Boolean))];
  const today = new Date().toISOString().split('T')[0];
  const isFuture = eventDate >= today;
  const countField = isFuture ? 'futureEventCount' : 'pastEventCount';

  for (const artistId of uniqueArtistIds) {
    try {
      const params = {
        TableName: ARTISTS_TABLE,
        Key: { id: artistId },
        UpdateExpression: `ADD ${countField} :delta`,
        ConditionExpression: 'attribute_exists(id)'
      };

      if (delta > 0) {
        params.ExpressionAttributeValues = { ':delta': delta };
      } else {
        // Prevent negative counts
        params.ConditionExpression = `attribute_exists(id) AND (attribute_not_exists(${countField}) OR ${countField} >= :min)`;
        params.ExpressionAttributeValues = { ':delta': delta, ':min': 1 };
      }

      await dynamodb.update(params).promise();
      console.log('EVENT_COUNT: Updated', { artistId, delta, countField, eventDate });
    } catch (error) {
      if (error.code === 'ConditionalCheckFailedException') {
        console.log('EVENT_COUNT: Skipped (artist not found or count already zero)', { artistId, delta, countField });
      } else {
        console.error('EVENT_COUNT: Failed (non-blocking)', { artistId, delta, countField, error: error.message });
      }
    }
  }
}

/**
 * Strip private fee fields from events for public endpoints
 * @param {Object} event - Event object
 * @returns {Object} Sanitized event
 */
function stripPrivateFields(event) {
  const sanitized = { ...event };
  PRIVATE_FEE_FIELDS.forEach(field => delete sanitized[field]);
  return sanitized;
}

/**
 * Generate occurrences from recurring event rules
 * @param {Object} event - Recurring event
 * @param {string} rangeStart - Range start date (YYYY-MM-DD)
 * @param {string} rangeEnd - Range end date (YYYY-MM-DD)
 * @returns {Array<Object>} Array of occurrence objects
 */
function generateOccurrences(event, rangeStart, rangeEnd) {
  if (!event.recurring) return [event];

  const occurrences = [];
  const start = new Date(event.date);
  const end = new Date(rangeEnd);
  let current = new Date(start);
  let count = 0;

  // Dates to exclude (deleted single occurrences)
  const excludeDates = new Set(event.excludeDates || []);

  while (current <= end) {
    const currentDateStr = current.toISOString().split('T')[0];

    // Skip excluded dates (deleted single occurrences)
    if (current >= new Date(rangeStart) && !excludeDates.has(currentDateStr)) {
      occurrences.push({
        ...event,
        parentEventId: event.id,
        instanceDate: currentDateStr,
        isRecurringInstance: true,
        date: currentDateStr
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
}

module.exports = {
  // Date helpers
  addDays,
  subtractDays,
  validateRecurring,
  // Hard uniqueness gate (2026-07-27 plan)
  putEventGated,
  releaseEventSentinels,
  eventGateKeys,
  // Venue operations
  getVenue,
  ensureVenueRelationship,
  // Artist event counts
  updateArtistEventCounts,
  // Duplicate detection
  checkForDuplicateByExternalId,
  checkForDuplicateEvent,
  // Availability
  clearAvailabilityForDates,
  // Event helpers
  stripPrivateFields,
  generateOccurrences,
  // Constants
  EVENTS_TABLE,
  VENUES_TABLE,
  ARTIST_VENUES_TABLE,
  PRIVATE_FEE_FIELDS
};
