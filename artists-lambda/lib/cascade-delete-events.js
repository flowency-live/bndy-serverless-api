// Cascade-delete all events belonging to an artist (any date, public or not).
// Used by the pre-launch cleanup path in handleMCPDeleteArtist.
// Queries the artistId-date-index GSI with pagination, deletes via BatchWrite
// in chunks of 25 with UnprocessedItems retry + backoff, and returns an audit
// list of what was removed (capture-before-prune: caller must log it).

const EVENTS_TABLE = 'bndy-events';
const BATCH_MAX = 25;
const MAX_RETRIES = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch ALL events for an artist via the GSI (paginated, no date bound). */
async function queryAllArtistEvents(dynamodb, artistId) {
  const items = [];
  let lastKey;
  do {
    const res = await dynamodb.query({
      TableName: EVENTS_TABLE,
      IndexName: 'artistId-date-index',
      KeyConditionExpression: 'artistId = :a',
      ExpressionAttributeValues: { ':a': artistId },
      ExclusiveStartKey: lastKey,
    }).promise();
    items.push(...(res.Items || []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

/** BatchWrite-delete ids in chunks of 25, retrying UnprocessedItems with backoff. */
async function batchDeleteEvents(dynamodb, ids) {
  for (let i = 0; i < ids.length; i += BATCH_MAX) {
    let requests = ids.slice(i, i + BATCH_MAX).map((id) => ({ DeleteRequest: { Key: { id } } }));
    let attempt = 0;
    while (requests.length > 0) {
      const res = await dynamodb.batchWrite({ RequestItems: { [EVENTS_TABLE]: requests } }).promise();
      requests = (res.UnprocessedItems && res.UnprocessedItems[EVENTS_TABLE]) || [];
      if (requests.length > 0) {
        attempt += 1;
        if (attempt > MAX_RETRIES) {
          throw new Error(`cascade-delete-events: ${requests.length} deletes still unprocessed after ${MAX_RETRIES} retries`);
        }
        await sleep(100 * 2 ** attempt);
      }
    }
  }
}

/**
 * Delete every event whose artistId matches. Returns { deleted, audit } where
 * audit is a compact record of each removed event for the caller to log.
 */
async function deleteArtistEvents(dynamodb, artistId) {
  const events = await queryAllArtistEvents(dynamodb, artistId);
  if (events.length === 0) return { deleted: 0, audit: [] };
  const audit = events.map((e) => ({
    id: e.id, date: e.date, venueId: e.venueId ?? null, name: e.name ?? null, isPublic: e.isPublic ?? null,
  }));
  await batchDeleteEvents(dynamodb, events.map((e) => e.id));
  return { deleted: events.length, audit };
}

module.exports = { deleteArtistEvents, queryAllArtistEvents, batchDeleteEvents, EVENTS_TABLE };
