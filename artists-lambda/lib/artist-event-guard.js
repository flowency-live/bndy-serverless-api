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
  // Check 1: Primary artist (artistId field) via artistId-date-index
  const primaryQuery = {
    TableName: EVENTS_TABLE,
    IndexName: 'artistId-date-index',
    KeyConditionExpression: 'artistId = :artistId',
    ExpressionAttributeValues: {
      ':artistId': artistId
    },
    Limit: 1  // We only need to know if ANY exist
  };

  const primaryResult = await dynamodb.query(primaryQuery).promise();
  if (primaryResult.Items && primaryResult.Items.length > 0) {
    console.log(`✗ Artist ${artistId} has ${primaryResult.Count}+ events as primary artist`);
    return true;
  }

  // Check 2: Legacy artistIds[] field + collaboratingArtistIds[]
  // These don't have indexes, so we need to scan with filter
  // (This is acceptable for a DELETE guard - deletion is infrequent)
  const scanParams = {
    TableName: EVENTS_TABLE,
    FilterExpression: 'contains(artistIds, :artistId) OR contains(collaboratingArtistIds, :artistId)',
    ExpressionAttributeValues: {
      ':artistId': artistId
    },
    Limit: 1  // We only need to know if ANY exist
  };

  const scanResult = await dynamodb.scan(scanParams).promise();
  if (scanResult.Items && scanResult.Items.length > 0) {
    console.log(`✗ Artist ${artistId} has ${scanResult.Count}+ events in artistIds[] or collaboratingArtistIds[]`);
    return true;
  }

  console.log(`✓ Artist ${artistId} has zero events - safe to delete`);
  return false;
}

module.exports = {
  hasEventsForArtist
};
