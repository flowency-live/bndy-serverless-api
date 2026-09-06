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
 * Query all events for an artist to compute their gigging projection.
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
    ProjectionExpression: '#date, hidden, visibility',
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
 * @param {Array} records - DynamoDB stream records
 * @param {Object} dynamodb - DynamoDB DocumentClient instance
 * @param {string} today - Today's date in ISO format (YYYY-MM-DD)
 */
async function processStreamBatch(records, dynamodb, today) {
  const artistIds = dedupeArtistIds(records);

  if (artistIds.length === 0) return;

  const promises = artistIds.map(async (artistId) => {
    try {
      const [events, currentProjection] = await Promise.all([
        queryArtistEvents(dynamodb, artistId, today),
        getArtistProjection(dynamodb, artistId),
      ]);

      const nextProjection = computeGiggingProjection(events, today);

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
