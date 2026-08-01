/**
 * Delete Orphan Sentinels - Clean up sentinel rows for deleted events
 */
const AWS = require('aws-sdk');
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const UNIQUE_KEYS_TABLE = 'bndy-unique-keys';
const EVENTS_TABLE = 'bndy-events';

async function scanAll(tableName, params = {}) {
  const items = [];
  let lastKey = null;
  do {
    const scanParams = { TableName: tableName, ...params };
    if (lastKey) scanParams.ExclusiveStartKey = lastKey;
    const result = await dynamodb.scan(scanParams).promise();
    items.push(...result.Items);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function batchGetEvents(eventIds) {
  const existing = new Set();
  const chunks = [];
  for (let i = 0; i < eventIds.length; i += 100) {
    chunks.push(eventIds.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    const keys = chunk.map(id => ({ id }));
    const result = await dynamodb.batchGet({
      RequestItems: {
        [EVENTS_TABLE]: {
          Keys: keys,
          ProjectionExpression: 'id'
        }
      }
    }).promise();

    for (const item of result.Responses[EVENTS_TABLE] || []) {
      existing.add(item.id);
    }
  }

  return existing;
}

async function main() {
  console.log('Finding orphan sentinels...\n');

  // Get all event sentinels
  const allRows = await scanAll(UNIQUE_KEYS_TABLE, {
    FilterExpression: 'begins_with(#k, :prefix)',
    ExpressionAttributeNames: { '#k': 'key' },
    ExpressionAttributeValues: { ':prefix': 'event#' }
  });

  console.log(`Found ${allRows.length} event sentinel rows`);

  // Get unique event IDs
  const eventIds = [...new Set(allRows.map(r => r.refId).filter(Boolean))];
  console.log(`Unique event IDs: ${eventIds.length}`);

  // Check which events exist
  const existingEvents = await batchGetEvents(eventIds);
  console.log(`Events still existing: ${existingEvents.size}`);

  // Find orphans
  const orphanRows = allRows.filter(r => r.refId && !existingEvents.has(r.refId));
  console.log(`\nOrphan sentinel rows to delete: ${orphanRows.length}`);

  if (orphanRows.length === 0) {
    console.log('No orphans to delete!');
    return;
  }

  // Delete orphans
  console.log('\nDeleting orphan sentinels...\n');

  let deleted = 0;
  let failed = 0;

  for (const row of orphanRows) {
    try {
      await dynamodb.delete({
        TableName: UNIQUE_KEYS_TABLE,
        Key: { key: row.key }
      }).promise();
      deleted++;
      process.stdout.write(`\rDeleted ${deleted}/${orphanRows.length}`);
    } catch (err) {
      failed++;
      console.error(`\nFailed to delete ${row.key}: ${err.message}`);
    }
  }

  console.log(`\n\n=== SUMMARY ===`);
  console.log(`Deleted: ${deleted}`);
  console.log(`Failed: ${failed}`);
  console.log(`\nOrphan event IDs released:`);

  const releasedEventIds = [...new Set(orphanRows.map(r => r.refId))];
  for (const eventId of releasedEventIds) {
    console.log(`  - ${eventId}`);
  }
}

main().catch(console.error);
