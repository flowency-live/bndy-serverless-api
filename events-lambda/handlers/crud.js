/**
 * CRUD Handlers for Events Lambda
 *
 * Handles core Create, Read, Update, Delete operations for events.
 * All endpoints require authentication.
 */

const crypto = require('crypto');
const { verifyMembership } = require('../lib/auth');
const { checkForDuplicateEvent, ensureVenueRelationship, validateRecurring, clearAvailabilityForDates, putEventGated, EVENTS_TABLE } = require('../lib/event-data');
const { duplicateResponseBody } = require('../lib/unique-gate');
const { triggerNotification } = require('../lib/notifications');
const { createCancellationRecord } = require('../calendar-cancellations');

/**
 * POST /api/artists/:artistId/events - Create artist event
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders, lambda }
 * @param {Object} event - Lambda event
 * @param {Object} user - Authenticated user
 */
async function handleCreateArtistEvent(deps, event, user) {
  const { dynamodb, getCorsHeaders, lambda } = deps;
  const { artistId } = event.pathParameters;
  const eventData = JSON.parse(event.body);

  // Check access - member first, then platform admin fallback
  let membership = await verifyMembership(dynamodb, user.userId, artistId);

  if (membership) {
    // User is a member - allow any event type
    console.log('[EVENTS] Member access granted for event creation');
  } else if (user.platformAdmin) {
    // Not a member, but platform admin - restrict to gig events only
    const allowedTypes = ['gig', 'public_gig', 'gig-public', 'gig-private'];
    if (!allowedTypes.includes(eventData.type)) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(event),
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
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Not a member of this artist' })
    };
  }

  // Validate required fields
  if (!eventData.type || !eventData.date) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'type and date are required' })
    };
  }

  // Validate public events require venueId
  if (eventData.isPublic && !eventData.venueId) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Public events must have venueId' })
    };
  }

  // Validate recurring rules if present
  if (eventData.recurring) {
    const recurringError = validateRecurring(eventData.recurring);
    if (recurringError) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: recurringError })
      };
    }
  }

  // Check for duplicate events (same venue + date + artist - one gig per day)
  if (eventData.venueId) {
    const duplicateEvent = await checkForDuplicateEvent(dynamodb, eventData.venueId, eventData.date, [artistId]);
    if (duplicateEvent) {
      console.log(`DUPLICATE_PREVENTED: Event already exists - ${duplicateEvent.id} (${duplicateEvent.title})`);
      return {
        statusCode: 409,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          error: 'Duplicate event detected',
          message: `An event with this artist at this venue on ${eventData.date} already exists`,
          existingEventId: duplicateEvent.id,
          existingEventTitle: duplicateEvent.title,
          existingStartTime: duplicateEvent.startTime
        })
      };
    }
  }

  // Auto-create venue relationship if this is a gig with a venueId
  if (eventData.venueId && (eventData.type === 'gig' || eventData.type === 'public_gig')) {
    await ensureVenueRelationship(dynamodb, artistId, eventData.venueId, eventData.date);
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

  // Fee tracking fields (private - artist backstage only)
  if (eventData.agreedFee !== undefined) newEvent.agreedFee = eventData.agreedFee;
  if (eventData.actualFee !== undefined) newEvent.actualFee = eventData.actualFee;
  if (eventData.datePaid) newEvent.datePaid = eventData.datePaid;
  if (eventData.paymentMethod) newEvent.paymentMethod = eventData.paymentMethod;
  if (eventData.splitBetweenMembers !== undefined) newEvent.splitBetweenMembers = eventData.splitBetweenMembers;
  if (eventData.noFee !== undefined) newEvent.noFee = eventData.noFee;
  if (eventData.distributed !== undefined) newEvent.distributed = eventData.distributed;

  // Sparse GSI keys - only include if present (NOT null)
  if (eventData.venueId) {
    newEvent.venueId = eventData.venueId;
  }

  // HARD GATE (2026-07-27): sentinel transaction on (venue|artist|date).
  // The advisory checkForDuplicateEvent above stays for the friendly 409;
  // this is the race-proof backstop no client can skip.
  const gateResult = await putEventGated(dynamodb, newEvent, 'backstage');
  if (!gateResult.written) {
    return {
      statusCode: 409,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        ...duplicateResponseBody('event', gateResult.existing),
        message: `An event with this artist at this venue on ${eventData.date} already exists`,
        existingEventId: gateResult.existing ? gateResult.existing.refId : null
      })
    };
  }

  console.log('EVENT: Created artist event', { eventId, artistId, type: eventData.type });

  // Auto-clear availability for the date range (silent operation)
  if (eventData.type !== 'available') {
    await clearAvailabilityForDates(dynamodb, artistId, newEvent.date, newEvent.endDate || newEvent.date);
  }

  // Skip notifications for platform admin events
  const skipNotifications = user.platformAdmin;

  if (!skipNotifications) {
    // Trigger notifications for gigs and rehearsals
    if (eventData.type === 'gig' || eventData.type === 'public_gig') {
      await triggerNotification(
        { dynamodb, lambda },
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
        { dynamodb, lambda },
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
    headers: getCorsHeaders(event),
    body: JSON.stringify(newEvent)
  };
}

/**
 * POST /api/users/me/unavailability - Create user unavailability event (artist-agnostic)
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 * @param {Object} user - Authenticated user
 */
async function handleCreateUserUnavailability(deps, event, user) {
  const { dynamodb, getCorsHeaders } = deps;
  const eventData = JSON.parse(event.body);

  // Validate required fields
  if (!eventData.date) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'date is required' })
    };
  }

  // Validate recurring rules if present
  if (eventData.recurring) {
    const recurringError = validateRecurring(eventData.recurring);
    if (recurringError) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(event),
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
    headers: getCorsHeaders(event),
    body: JSON.stringify(unavailableEvent)
  };
}

/**
 * GET /api/artists/:artistId/events/:id - Get single event
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 * @param {Object} user - Authenticated user
 */
async function handleGetEvent(deps, event, user) {
  const { dynamodb, getCorsHeaders } = deps;
  const { artistId, id } = event.pathParameters;

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
    console.log('[EVENTS] Platform admin access granted for event view');
  }

  const result = await dynamodb.get({
    TableName: EVENTS_TABLE,
    Key: { id }
  }).promise();

  if (!result.Item) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Event not found' })
    };
  }

  return {
    statusCode: 200,
    headers: getCorsHeaders(event),
    body: JSON.stringify(result.Item)
  };
}

/**
 * PUT /api/artists/:artistId/events/:id - Update event
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 * @param {Object} user - Authenticated user
 */
async function handleUpdateEvent(deps, event, user) {
  const { dynamodb, getCorsHeaders } = deps;
  const { artistId, id } = event.pathParameters;
  const updates = JSON.parse(event.body);

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
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Event not found' })
    };
  }

  const existingEvent = existing.Item;

  // Permission check: user events only editable by owner
  if (existingEvent.type === 'unavailable' && existingEvent.ownerUserId !== user.userId) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Can only edit your own unavailability' })
    };
  }

  // Artist events editable by any member (can add role checks later)

  // Build update expression
  const updateExpressions = [];
  const attributeNames = {};
  const attributeValues = {};

  const allowedFields = ['type', 'title', 'date', 'endDate', 'startTime', 'endTime', 'venueId', 'location', 'notes', 'isPublic', 'isAllDay', 'agreedFee', 'actualFee', 'datePaid', 'paymentMethod', 'splitBetweenMembers', 'noFee', 'distributed'];

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
      headers: getCorsHeaders(event),
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
    headers: getCorsHeaders(event),
    body: JSON.stringify(updated.Item)
  };
}

/**
 * DELETE /api/artists/:artistId/events/:id - Delete event
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders, lambda }
 * @param {Object} event - Lambda event
 * @param {Object} user - Authenticated user
 */
async function handleDeleteEvent(deps, event, user) {
  const { dynamodb, getCorsHeaders, lambda } = deps;
  const { artistId, id } = event.pathParameters;
  const { deleteAll, instanceDate } = event.queryStringParameters || {};

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
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Event not found' })
    };
  }

  const existingEvent = existing.Item;

  // Permission check: user events only deletable by owner
  if (existingEvent.type === 'unavailable') {
    if (existingEvent.ownerUserId !== user.userId) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'Can only delete your own unavailability' })
      };
    }
    // For unavailability events, skip the artistId check (they don't have artistId)
  } else {
    // Permission check: artist events must belong to the artist context
    if (existingEvent.artistId && existingEvent.artistId !== artistId) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          error: 'Cannot delete events from a different artist context',
          eventArtistId: existingEvent.artistId,
          currentArtistId: artistId
        })
      };
    }
  }

  // Handle recurring event single occurrence deletion
  // If event has recurring AND deleteAll is not true AND instanceDate is provided,
  // add the date to excludeDates instead of deleting the whole event
  const isRecurring = existingEvent.recurring && existingEvent.recurring.type && existingEvent.recurring.type !== 'none';
  const shouldDeleteSingleOccurrence = isRecurring && deleteAll !== 'true' && instanceDate;

  if (shouldDeleteSingleOccurrence) {
    // Add instanceDate to excludeDates array
    const currentExcludeDates = existingEvent.excludeDates || [];
    if (!currentExcludeDates.includes(instanceDate)) {
      const updatedExcludeDates = [...currentExcludeDates, instanceDate];

      await dynamodb.update({
        TableName: EVENTS_TABLE,
        Key: { id },
        UpdateExpression: 'SET excludeDates = :excludeDates, updatedAt = :updatedAt',
        ExpressionAttributeValues: {
          ':excludeDates': updatedExcludeDates,
          ':updatedAt': new Date().toISOString()
        }
      }).promise();

      console.log('EVENT: Excluded single occurrence from recurring event', {
        eventId: id,
        excludedDate: instanceDate,
        totalExcluded: updatedExcludeDates.length
      });

      return {
        statusCode: 200,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          message: 'Occurrence excluded',
          excludedDate: instanceDate
        })
      };
    }

    // Date was already excluded
    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        message: 'Occurrence was already excluded',
        excludedDate: instanceDate
      })
    };
  }

  // Delete the entire event
  await dynamodb.delete({
    TableName: EVENTS_TABLE,
    Key: { id }
  }).promise();

  console.log('EVENT: Deleted event', { eventId: id, deleteAll: deleteAll === 'true' });

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
        { dynamodb, lambda },
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
        { dynamodb, lambda },
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
    headers: getCorsHeaders(event),
    body: JSON.stringify({ success: true, id })
  };
}

module.exports = {
  handleCreateArtistEvent,
  handleCreateUserUnavailability,
  handleGetEvent,
  handleUpdateEvent,
  handleDeleteEvent,
  EVENTS_TABLE
};
