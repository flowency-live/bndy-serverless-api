/**
 * DynamoDB stream handler for bndy-events
 *
 * Processes event changes and updates gigging projection fields on artists.
 */

const { computeGiggingProjection, shouldSkipWrite } = require('./gigging-projection');

const ARTISTS_TABLE = 'bndy-artists';
const EVENTS_TABLE = 'bndy-events';

/**
 * Unmarshal a DynamoDB attribute value to a plain JS value.
 * Handles S, N, BOOL, NULL, L, M types.
 */
function unmarshal(value) {
  if (!value) return null;
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) return Number(value.N);
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.NULL !== undefined) return null;
  if (value.L !== undefined) return value.L.map(unmarshal);
  if (value.M !== undefined) {
    const obj = {};
    for (const key of Object.keys(value.M)) {
      obj[key] = unmarshal(value.M[key]);
    }
    return obj;
  }
  return null;
}

/**
 * Extract artist IDs from a DynamoDB stream record image.
 */
function extractArtistIdsFromImage(image) {
  const ids = new Set();

  if (image.artistId?.S) {
    ids.add(image.artistId.S);
  }

  if (image.collaboratingArtistIds?.L) {
    image.collaboratingArtistIds.L.forEach((item) => {
      if (item.S) ids.add(item.S);
    });
  }

  if (image.artistIds?.L) {
    image.artistIds.L.forEach((item) => {
      if (item.S) ids.add(item.S);
    });
  }

  return Array.from(ids);
}

/**
 * Deduplicate artist IDs across all stream records in a batch.
 *
 * @param {Array} records - DynamoDB stream records
 * @returns {string[]} Unique artist IDs
 */
function dedupeArtistIds(records) {
  const allIds = new Set();

  for (const record of records) {
    const image = record.eventName === 'REMOVE'
      ? record.dynamodb?.OldImage
      : record.dynamodb?.NewImage;

    if (!image) continue;

    const ids = extractArtistIdsFromImage(image);
    ids.forEach((id) => allIds.add(id));
  }

  return Array.from(allIds);
}

/**
 * Extract event data from a stream record image for gigging projection.
 * Returns null if the event is not relevant (missing required fields).
 *
 * @param {Object} image - DynamoDB stream record image (marshalled format)
 * @returns {{ id: string, date: string, hidden?: boolean, visibility?: string } | null}
 */
function extractEventFromImage(image) {
  if (!image) return null;

  const id = image.id?.S;
  const date = image.date?.S;

  if (!id || !date) return null;

  return {
    id,
    date,
    hidden: image.hidden?.BOOL,
    visibility: image.visibility?.S,
  };
}

/**
 * Group stream record events by artist ID.
 * Returns a map of artistId -> { inserts: Event[], removes: Set<eventId> }
 *
 * @param {Array} records - DynamoDB stream records
 * @returns {Map<string, { inserts: Array, removes: Set<string> }>}
 */
function groupStreamEventsByArtist(records) {
  const byArtist = new Map();

  for (const record of records) {
    const isRemove = record.eventName === 'REMOVE';
    const image = isRemove ? record.dynamodb?.OldImage : record.dynamodb?.NewImage;

    if (!image) continue;

    const artistIds = extractArtistIdsFromImage(image);
    const eventData = extractEventFromImage(image);

    if (!eventData) continue;

    for (const artistId of artistIds) {
      if (!byArtist.has(artistId)) {
        byArtist.set(artistId, { inserts: [], removes: new Set() });
      }

      const entry = byArtist.get(artistId);

      if (isRemove) {
        entry.removes.add(eventData.id);
      } else {
        entry.inserts.push(eventData);
      }
    }
  }

  return byArtist;
}

/**
 * Merge GSI query results with stream record events.
 * Handles eventual consistency by:
 * - Adding INSERT/MODIFY events that may not be in GSI yet
 * - Removing REMOVE events that may still be in GSI
 *
 * @param {Array} gsiEvents - Events from GSI query (unmarshalled, now includes id)
 * @param {Array} insertedEvents - Events from stream records (INSERT/MODIFY)
 * @param {Set<string>} removedEventIds - Event IDs from stream records (REMOVE)
 * @returns {Array} Merged events for projection computation
 */
function mergeEventsWithStreamRecords(gsiEvents, insertedEvents, removedEventIds) {
  const merged = new Map();

  // Add GSI events, filtering out removed ones
  for (const event of gsiEvents) {
    if (event.id && removedEventIds.has(event.id)) {
      continue; // Skip events that were removed in this batch
    }
    merged.set(event.id || event.date, event);
  }

  // Add inserted events (will overwrite GSI events with same id if present)
  for (const event of insertedEvents) {
    merged.set(event.id, event);
  }

  return Array.from(merged.values());
}

/**
 * Query all events for an artist to compute their gigging projection.
 * Includes id for merging with stream records.
 */
async function queryArtistEvents(dynamodb, artistId, today) {
  const params = {
    TableName: EVENTS_TABLE,
    IndexName: 'artistId-date-index',
    KeyConditionExpression: 'artistId = :artistId AND #date >= :today',
    ExpressionAttributeNames: { '#date': 'date' },
    ExpressionAttributeValues: {
      ':artistId': artistId,
      ':today': today,
    },
    ProjectionExpression: 'id, #date, hidden, visibility',
  };

  const result = await dynamodb.query(params).promise();
  return result.Items || [];
}

/**
 * Get current artist projection fields.
 */
async function getArtistProjection(dynamodb, artistId) {
  const params = {
    TableName: ARTISTS_TABLE,
    Key: { id: artistId },
    ProjectionExpression: 'giggingStatus, giggingUntil',
  };

  const result = await dynamodb.get(params).promise();
  return result.Item || {};
}

/**
 * Update artist with new projection fields.
 */
async function updateArtistProjection(dynamodb, artistId, projection) {
  if (projection.giggingStatus === null) {
    const params = {
      TableName: ARTISTS_TABLE,
      Key: { id: artistId },
      UpdateExpression: 'REMOVE giggingStatus, giggingUntil',
      ConditionExpression: 'attribute_exists(id)',
    };
    await dynamodb.update(params).promise();
  } else {
    const params = {
      TableName: ARTISTS_TABLE,
      Key: { id: artistId },
      UpdateExpression: 'SET giggingStatus = :status, giggingUntil = :until',
      ExpressionAttributeValues: {
        ':status': projection.giggingStatus,
        ':until': projection.giggingUntil,
      },
      ConditionExpression: 'attribute_exists(id)',
    };
    await dynamodb.update(params).promise();
  }
}

/**
 * Process a batch of stream records and update affected artists.
 *
 * Handles GSI eventual consistency by merging stream record event data
 * with GSI query results. This ensures:
 * - Newly inserted events are included even if GSI hasn't replicated yet
 * - Removed events are excluded even if GSI still returns them
 *
 * @param {Array} records - DynamoDB stream records
 * @param {Object} dynamodb - DynamoDB DocumentClient instance
 * @param {string} today - Today's date in ISO format (YYYY-MM-DD)
 */
async function processStreamBatch(records, dynamodb, today) {
  const artistIds = dedupeArtistIds(records);

  if (artistIds.length === 0) return;

  // Group stream events by artist for merging with GSI results
  const streamEventsByArtist = groupStreamEventsByArtist(records);

  const promises = artistIds.map(async (artistId) => {
    try {
      const [gsiEvents, currentProjection] = await Promise.all([
        queryArtistEvents(dynamodb, artistId, today),
        getArtistProjection(dynamodb, artistId),
      ]);

      // Get stream events for this artist (may be empty if artist was in collaborators)
      const streamData = streamEventsByArtist.get(artistId) || { inserts: [], removes: new Set() };

      // Merge GSI results with stream record data to handle eventual consistency
      const mergedEvents = mergeEventsWithStreamRecords(
        gsiEvents,
        streamData.inserts.filter(e => e.date >= today), // Only future events
        streamData.removes
      );

      const nextProjection = computeGiggingProjection(mergedEvents, today);

      if (shouldSkipWrite(currentProjection, nextProjection)) {
        return;
      }

      await updateArtistProjection(dynamodb, artistId, nextProjection);
    } catch (error) {
      if (error.code === 'ConditionalCheckFailedException') {
        return;
      }
      console.error(`Failed to update artist ${artistId}:`, error);
    }
  });

  await Promise.all(promises);
}

module.exports = {
  dedupeArtistIds,
  processStreamBatch,
  queryArtistEvents,
  getArtistProjection,
  updateArtistProjection,
};
