/**
 * MCP Handlers for Events Lambda
 *
 * Handles MCP (Model Context Protocol) event operations.
 * These endpoints have NO AUTH - they're for MCP tools only.
 */

const { createCancellationRecord } = require('../calendar-cancellations');

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
    'artist_id': 'artist_id',  // Reassign event to different artist (for merging duplicates)
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
    'externalIds': 'external_ids',
    // Festival fields (Phase 1a)
    'festivalId': 'festivalId',
    'festivalName': 'festivalName',
    'stageId': 'stageId',
    'billing': 'billing',
    'billingOrder': 'billingOrder'
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
