/**
 * Artist Event Guard (Fix #6b, 2026-07-29)
 *
 * Prevents artist deletion when events still reference the artist.
 * This prevents orphan events with dead artistIds that render as "Artist" in the frontend.
 */

const EVENTS_TABLE = 'bndy-events';

/**
 * Check if any events reference this artist in ANY of the three artist fields:
 * - artistId (primary artist)
 * - artistIds[] (legacy multi-artist field)
 * - collaboratingArtistIds[] (collaborating artists)
 *
 * Returns true if ANY events reference the artist.
 */
async function hasEventsForArtist(dynamodb, artistId) {
  const result = await countEventsForArtist(dynamodb, artistId);
  return result.totalCount > 0;
}

/**
 * Count all events referencing this artist across all artist fields.
 * Returns { totalCount, eventIds } for use in 409 responses and force delete.
 */
async function countEventsForArtist(dynamodb, artistId) {
  const eventIds = [];

  // Check 1: Primary artist (artistId field) via artistId-date-index
  const primaryQuery = {
    TableName: EVENTS_TABLE,
    IndexName: 'artistId-date-index',
    KeyConditionExpression: 'artistId = :artistId',
    ExpressionAttributeValues: {
      ':artistId': artistId
    },
    ProjectionExpression: 'id'
  };

  let primaryResult = await dynamodb.query(primaryQuery).promise();
  eventIds.push(...(primaryResult.Items || []).map(e => e.id));

  // Handle pagination for primary query
  while (primaryResult.LastEvaluatedKey) {
    primaryQuery.ExclusiveStartKey = primaryResult.LastEvaluatedKey;
    primaryResult = await dynamodb.query(primaryQuery).promise();
    eventIds.push(...(primaryResult.Items || []).map(e => e.id));
  }

  // Check 2: Legacy artistIds[] field + collaboratingArtistIds[]
  const scanParams = {
    TableName: EVENTS_TABLE,
    FilterExpression: 'contains(artistIds, :artistId) OR contains(collaboratingArtistIds, :artistId)',
    ExpressionAttributeValues: {
      ':artistId': artistId
    },
    ProjectionExpression: 'id'
  };

  let scanResult = await dynamodb.scan(scanParams).promise();
  eventIds.push(...(scanResult.Items || []).map(e => e.id));

  // Handle pagination for scan
  while (scanResult.LastEvaluatedKey) {
    scanParams.ExclusiveStartKey = scanResult.LastEvaluatedKey;
    scanResult = await dynamodb.scan(scanParams).promise();
    eventIds.push(...(scanResult.Items || []).map(e => e.id));
  }

  // Dedupe event IDs (in case same event appears in multiple fields)
  const uniqueEventIds = [...new Set(eventIds)];
  const totalCount = uniqueEventIds.length;

  if (totalCount > 0) {
    console.log(`✗ Artist ${artistId} has ${totalCount} events`);
  } else {
    console.log(`✓ Artist ${artistId} has zero events - safe to delete`);
  }

  return { totalCount, eventIds: uniqueEventIds };
}

module.exports = {
  hasEventsForArtist,
  countEventsForArtist
};
