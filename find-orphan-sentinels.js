/**
 * Find Orphan Sentinels - Scan bndy-unique-keys for event# rows
 * where the referenced event no longer exists in bndy-events
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
  console.log('Scanning bndy-unique-keys for event# rows...');

  // Get all rows that are event sentinels (key starts with 'event#')
  const allRows = await scanAll(UNIQUE_KEYS_TABLE, {
    FilterExpression: 'begins_with(#k, :prefix)',
    ExpressionAttributeNames: { '#k': 'key' },
    ExpressionAttributeValues: { ':prefix': 'event#' }
  });

  console.log(`Found ${allRows.length} event sentinel rows\n`);

  // Extract unique event IDs from refId field
  const eventIds = [...new Set(allRows.map(r => r.refId).filter(Boolean))];
  console.log(`Unique event IDs referenced: ${eventIds.length}`);

  // Check which events exist
  console.log('Checking which events still exist...\n');
  const existingEvents = await batchGetEvents(eventIds);
  console.log(`Events found in bndy-events: ${existingEvents.size}`);

  // Find orphans
  const orphanRows = allRows.filter(r => r.refId && !existingEvents.has(r.refId));
  const orphanEventIds = [...new Set(orphanRows.map(r => r.refId))];

  console.log(`\n=== ORPHAN SENTINEL SUMMARY ===`);
  console.log(`Total orphan sentinel rows: ${orphanRows.length}`);
  console.log(`Orphan event IDs: ${orphanEventIds.length}`);

  if (orphanRows.length > 0) {
    console.log(`\n=== ORPHAN SENTINELS (blocking creates) ===\n`);

    // Group by event ID for cleaner output
    const byEvent = {};
    for (const row of orphanRows) {
      if (!byEvent[row.refId]) byEvent[row.refId] = [];
      byEvent[row.refId].push(row.key);
    }

    for (const [eventId, keys] of Object.entries(byEvent)) {
      console.log(`Event ID: ${eventId} (MISSING)`);
      console.log(`  Keys blocking:`);
      for (const key of keys) {
        console.log(`    - ${key}`);
      }
      console.log();
    }

    console.log('\n=== DELETE COMMANDS ===');
    console.log('Run these to release orphan sentinels:\n');

    for (const row of orphanRows) {
      console.log(`aws dynamodb delete-item --table-name ${UNIQUE_KEYS_TABLE} --key '{"key":{"S":"${row.key}"}}'`);
    }
  }

  // Output JSON for automation
  console.log('\n=== JSON OUTPUT ===');
  console.log(JSON.stringify({
    summary: {
      totalEventSentinels: allRows.length,
      uniqueEventIds: eventIds.length,
      existingEvents: existingEvents.size,
      orphanSentinelRows: orphanRows.length,
      orphanEventIds: orphanEventIds.length
    },
    orphans: orphanRows.map(r => ({
      key: r.key,
      refId: r.refId,
      createdAt: r.createdAt
    }))
  }, null, 2));
}

main().catch(console.error);
