/**
 * MCP Handlers for Events Lambda
 *
 * Handles MCP (Model Context Protocol) event operations.
 * These endpoints have NO AUTH - they're for MCP tools only.
 */

const { createCancellationRecord } = require('../calendar-cancellations');
const { checkForDuplicateEvent, releaseEventSentinels, eventGateKeys } = require('../lib/event-data');
const { gateMode, rekeyUniqueKeys } = require('../lib/unique-gate');

// Table constants
const EVENTS_TABLE = 'bndy-events';
const VENUES_TABLE = 'bndy-venues';
const ARTISTS_TABLE = 'bndy-artists';

/**
 * GET /api/events/external - Lookup event by external ID
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 */
async function handleGetEventByExternalId(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const source = event.queryStringParameters?.source;
  const externalId = event.queryStringParameters?.id;

  console.log(`[Events] Looking up event by external ID: ${source}:${externalId}`);

  if (!source || !externalId) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
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
        headers: getCorsHeaders(event),
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
      headers: getCorsHeaders(event),
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
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

/**
 * PUT /api/events/:id/mcp - Update event via MCP (NO AUTH)
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 */
async function handleUpdateEventMcp(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
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
      headers: getCorsHeaders(event),
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
    // AUDIT FIX F5 (2026-07-27): this map previously read 'artist_id': 'artist_id'
    // while the actual attribute (and GSI hash key) is 'artistId'. Result:
    // callers sending artistId were silently DROPPED (fake-success no-op that
    // orphaned 97+ events during dedup); callers sending artist_id wrote a
    // useless orphan attribute. Both spellings now map to the real attribute.
    'artistId': 'artistId',    // Reassign event to different artist (for merging duplicates)
    'artist_id': 'artistId',   // back-compat alias — same target attribute
    'venueId': 'venueId',
    'description': 'description',
    'isPublic': 'isPublic',
    // Item 13 (2026-08-11): open mic flag was missing here, so BOTH the MCP
    // edit_event tool AND the curator edit sheet (which delegates to this
    // handler) silently dropped it. The paired `type` attribute is kept in
    // sync below.
    'isOpenMic': 'isOpenMic',
    'ticketed': 'ticketed',
    'ticketUrl': 'ticketUrl',
    'ticketinformation': 'ticketinformation',
    'price': 'price',
    'imageUrl': 'imageUrl',
    'eventUrl': 'eventUrl',
    'notes': 'notes',
    'externalIds': 'external_ids',
    // Feature 12 (2026-08-13): the bill. Without these two, MCP could not set or
    // correct a support act, so every imported multi-act bill stayed single-act.
    'collaboratingArtistIds': 'collaboratingArtistIds',
    'headlineArtistIds': 'headlineArtistIds',
    // Festival fields (Phase 1a)
    'festivalId': 'festivalId',
    'festivalName': 'festivalName',
    'stageId': 'stageId',
    'billing': 'billing',
    'billingOrder': 'billingOrder'
  };

  // Fields that support null -> REMOVE (tri-state: true/false/unset)
  // Clearing these via null means "inherit from venue" or "unknown"
  const clearableFields = new Set(['ticketed', 'price', 'ticketUrl', 'ticketinformation']);
  const removeExpressions = [];

  const mappedDbFields = new Set();
  Object.entries(allowedFields).forEach(([apiField, dbField]) => {
    if (updates[apiField] !== undefined && !mappedDbFields.has(dbField)) {
      mappedDbFields.add(dbField); // guard: artistId + artist_id both target 'artistId' — first wins

      // Handle null values for clearable fields -> REMOVE attribute
      if (updates[apiField] === null && clearableFields.has(dbField)) {
        const placeholder = `#${dbField}`;
        attributeNames[placeholder] = dbField;
        removeExpressions.push(placeholder);
      } else {
        const placeholder = `#${dbField}`;
        const valuePlaceholder = `:${dbField}`;
        attributeNames[placeholder] = dbField;
        attributeValues[valuePlaceholder] = updates[apiField];
        updateExpressions.push(`${placeholder} = ${valuePlaceholder}`);
      }
    }
  });

  // Item 13: the record carries the flag TWICE — `isOpenMic` (boolean, read by
  // bndy-app) and `type` ('open-mic' | 'gig', written by the community create).
  // An isOpenMic edit updates both so no reader ever sees them disagree.
  if (updates.isOpenMic !== undefined) {
    attributeNames['#type'] = 'type';
    attributeValues[':type'] = updates.isOpenMic ? 'open-mic' : 'gig';
    updateExpressions.push('#type = :type');
  }

  // Feature 12: every headline act must be ON the bill, and a gig carries at most
  // four acts. Same rule as the community create, enforced on the edit path too.
  if (updates.headlineArtistIds !== undefined || updates.collaboratingArtistIds !== undefined) {
    const bill = [
      updates.artistId !== undefined ? updates.artistId : existing.Item.artistId,
      ...(updates.collaboratingArtistIds !== undefined
        ? (updates.collaboratingArtistIds || [])
        : (existing.Item.collaboratingArtistIds || []))
    ].filter(Boolean);
    if (bill.length > 4) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'A gig carries at most 4 acts. Use a festival for a bigger bill.', code: 'TOO_MANY_ACTS' })
      };
    }
    const heads = updates.headlineArtistIds !== undefined
      ? (updates.headlineArtistIds || []).filter(Boolean)
      : (existing.Item.headlineArtistIds || []);
    const stray = heads.filter((h) => !bill.includes(h));
    if (stray.length > 0) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'Every headline act must be on the bill', code: 'INVALID_HEADLINERS', strayHeadliners: stray })
      };
    }
  }

  // AUDIT FIX F4 (2026-07-27): updates could previously edit an event INTO
  // being a duplicate with no check. If this update changes any identity
  // field (artist, venue, date) on a public gig, re-run the duplicate check
  // excluding this event.
  const effArtistId = updates.artistId !== undefined ? updates.artistId
    : (updates.artist_id !== undefined ? updates.artist_id : existing.Item.artistId);
  const effVenueId = updates.venueId !== undefined ? updates.venueId : existing.Item.venueId;
  const effDate = updates.date !== undefined ? updates.date : existing.Item.date;
  // GATE FIX 2026-08-13 (feature 12): the identity test previously ignored
  // collaboratingArtistIds. Every sentinel key is (venue|artist|date) and there
  // is ONE PER ACT, so adding a support act creates a new identity that was
  // never gated, and removing one stranded its sentinel forever — that act could
  // then never play that venue on that date again. Now the whole bill counts.
  const effCollabs = updates.collaboratingArtistIds !== undefined
    ? (updates.collaboratingArtistIds || []).filter(Boolean)
    : (existing.Item.collaboratingArtistIds || []);
  const sameSet = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
  const identityChanged = effArtistId !== existing.Item.artistId
    || effVenueId !== existing.Item.venueId
    || effDate !== existing.Item.date
    || !sameSet(effCollabs, existing.Item.collaboratingArtistIds || []);
  const isPublicGig = existing.Item.isPublic === true || existing.Item.type === 'gig' || existing.Item.type === 'public_gig';

  if (identityChanged && isPublicGig && effVenueId && effArtistId) {
    // GATE FIX 2026-07-28: cover collaborators too, not just the primary artist
    const effAllArtists = [effArtistId,
      ...(existing.Item.artistIds || []),
      ...effCollabs].filter(Boolean);
    const dup = await checkForDuplicateEvent(dynamodb, effVenueId, effDate, effAllArtists);
    if (dup && dup.id !== id) {
      const detail = { eventId: id, conflictsWith: dup.id, effArtistId, effVenueId, effDate };
      if (gateMode() === 'enforce') {
        console.warn('[MCP] UPDATE BOUNCED: would create duplicate event', JSON.stringify(detail));
        return {
          statusCode: 409,
          headers: getCorsHeaders(event),
          body: JSON.stringify({
            error: 'Duplicate event',
            code: 'DUPLICATE',
            message: 'This update would make the event a duplicate of an existing event (same artist, venue, date). Merge/delete instead.',
            existingEventId: dup.id
          })
        };
      }
      console.warn('[MCP] UPDATE WOULD_BOUNCE (log mode): duplicate event', JSON.stringify(detail));
    }

    // GATE FIX 2026-07-28: re-key sentinels — claim the new (venue|artist|date)
    // keys + release the old ones atomically. Enforce-mode collision → 409,
    // update NOT performed (the sentinel is the race-proof backstop behind the
    // advisory check above).
    const projected = {
      ...existing.Item,
      artistId: effArtistId,
      venueId: effVenueId,
      date: effDate,
      collaboratingArtistIds: effCollabs,
    };
    const rekey = await rekeyUniqueKeys(dynamodb, {
      oldKeys: eventGateKeys(existing.Item),
      newKeys: eventGateKeys(projected),
      refId: id,
      entityType: 'event',
      source: 'mcp-update'
    });
    if (rekey.changed && rekey.ok === false) {
      return {
        statusCode: 409,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          error: 'Duplicate event',
          code: 'DUPLICATE',
          message: 'The uniqueness gate holds a sentinel for the target (venue|artist|date) — this update would collide with an existing event.',
          existingEventId: rekey.existing ? rekey.existing.refId : null
        })
      };
    }
  }

  // Always update updatedAt
  attributeNames['#updatedAt'] = 'updatedAt';
  attributeValues[':updatedAt'] = new Date().toISOString();
  updateExpressions.push('#updatedAt = :updatedAt');

  if (updateExpressions.length === 1 && removeExpressions.length === 0) { // Only updatedAt, no removes
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'No valid fields to update' })
    };
  }

  // Build UpdateExpression with SET and optional REMOVE clauses
  let updateExpression = `SET ${updateExpressions.join(', ')}`;
  if (removeExpressions.length > 0) {
    updateExpression += ` REMOVE ${removeExpressions.join(', ')}`;
  }

  await dynamodb.update({
    TableName: EVENTS_TABLE,
    Key: { id },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: attributeNames,
    ...(Object.keys(attributeValues).length > 0 && { ExpressionAttributeValues: attributeValues })
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
    headers: getCorsHeaders(event),
    body: JSON.stringify({
      ...updatedEvent,
      externalIds: updatedEvent.external_ids || [],
      venueName
    })
  };
}

/**
 * DELETE /api/events/:id/mcp - Delete event via MCP (NO AUTH)
 * Allows deletion of ANY event record via MCP
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 */
async function handleDeleteEventMcp(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const { id } = event.pathParameters;

  console.log('[MCP] Deleting event', { eventId: id });

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

  // Delete the event
  await dynamodb.delete({
    TableName: EVENTS_TABLE,
    Key: { id }
  }).promise();

  // Release uniqueness sentinels so the (venue|artist|date) key is claimable again
  await releaseEventSentinels(dynamodb, existingEvent);

  // Best-effort calendar cancellation record so calendar subscribers remove it (non-fatal)
  try {
    await createCancellationRecord(existingEvent, 'mcp-system');
  } catch (cancelErr) {
    console.error('[MCP] Failed to create cancellation record (non-fatal)', cancelErr);
  }

  console.log('[MCP] Event deleted', { eventId: id });

  return {
    statusCode: 200,
    headers: getCorsHeaders(event),
    body: JSON.stringify({ message: 'Event deleted', id })
  };
}

/**
 * GET /api/events/:id/mcp - Get event by ID via MCP (NO AUTH)
 * Public read-only endpoint for MCP tools to fetch event details
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 */
async function handleGetEventMcp(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
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
      headers: getCorsHeaders(event),
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
      collaboratingArtistIds.map(artistId => dynamodb.get({
        TableName: ARTISTS_TABLE,
        Key: { id: artistId }
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
    headers: getCorsHeaders(event),
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
}

/**
 * POST /api/artists/:artistId/events/:id/leave - Leave a multi-artist event
 * Allows a collaborating artist to remove themselves without deleting the event
 * @param {Object} deps - Dependencies { dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 */
async function handleLeaveEvent(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
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
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'Event not found' })
      };
    }

    const existingEvent = existing.Item;
    const collaboratingArtistIds = existingEvent.collaboratingArtistIds || [];

    // Check if artist is the primary artist (cannot leave, must delete)
    if (existingEvent.artistId === artistId) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          error: 'Primary artist cannot leave event. Use delete to remove the event entirely.'
        })
      };
    }

    // Check if artist is in the collaborating list
    if (!collaboratingArtistIds.includes(artistId)) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'Artist is not part of this event' })
      };
    }

    // Remove artist from collaboratingArtistIds
    const updatedCollaboratingIds = collaboratingArtistIds.filter(collabId => collabId !== artistId);
    // Feature 12 fix 2026-08-13: this route removed the act but never released
    // its uniqueness sentinel. The key is (venue|artist|date), one per act, so a
    // departed act kept holding that slot and could never be booked at that venue
    // on that date again by anyone. Release before the write, and drop the act
    // from the headline set so no card names an act that is not playing.
    await rekeyUniqueKeys(dynamodb, {
      oldKeys: eventGateKeys(existingEvent),
      newKeys: eventGateKeys({ ...existingEvent, collaboratingArtistIds: updatedCollaboratingIds }),
      refId: id,
      entityType: 'event',
      source: 'leave-event'
    });

    const remainingHeadliners = (existingEvent.headlineArtistIds || []).filter(h => h !== artistId);
    const nextHeadliners = remainingHeadliners.length > 0
      ? remainingHeadliners
      : [existingEvent.artistId].filter(Boolean);

    await dynamodb.update({
      TableName: EVENTS_TABLE,
      Key: { id },
      UpdateExpression: 'SET collaboratingArtistIds = :ids, headlineArtistIds = :heads, updatedAt = :now',
      ExpressionAttributeValues: {
        ':ids': updatedCollaboratingIds,
        ':heads': nextHeadliners,
        ':now': new Date().toISOString()
      }
    }).promise();

    console.log('LEAVE_EVENT: Artist removed from event', { artistId, eventId: id, remainingCollaborators: updatedCollaboratingIds.length });

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
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
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Failed to leave event' })
    };
  }
}

module.exports = {
  handleGetEventByExternalId,
  handleUpdateEventMcp,
  handleDeleteEventMcp,
  handleGetEventMcp,
  handleLeaveEvent,
  EVENTS_TABLE,
  VENUES_TABLE,
  ARTISTS_TABLE
};
