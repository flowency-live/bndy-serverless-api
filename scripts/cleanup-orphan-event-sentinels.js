/**
 * One-off cleanup: Delete orphan event sentinels (Fix #5a, 2026-07-29)
 *
 * Problem: Event f40fccde-d448-4514-8bc4-6cb7f52cc6d8 no longer exists but its
 * sentinels in bndy-unique-keys are still live, blocking legitimate creates.
 *
 * Root cause: Event deleted via a path that didn't release sentinels (CLI cleanup,
 * or deletion between backfill and enforce).
 *
 * Fix: Scan ALL event# rows in bndy-unique-keys, verify each refId exists in
 * bndy-events, delete orphans.
 */

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

const UNIQUE_KEYS_TABLE = 'bndy-unique-keys';
const EVENTS_TABLE = 'bndy-events';

// Batch get helper - splits into chunks of 100 (DynamoDB limit)
async function batchGetEvents(eventIds) {
  const results = new Map();
  const chunks = [];

  // Split into chunks of 100
  for (let i = 0; i < eventIds.length; i += 100) {
    chunks.push(eventIds.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    const params = {
      RequestItems: {
        [EVENTS_TABLE]: {
          Keys: chunk.map(id => ({ id }))
        }
      }
    };

    const result = await dynamodb.batchGet(params).promise();
    const items = result.Responses[EVENTS_TABLE] || [];

    items.forEach(item => {
      results.set(item.id, item);
    });
  }

  return results;
}

async function scanAllEventSentinels() {
  console.log('Scanning bndy-unique-keys for all event# sentinels...\n');

  const sentinels = [];
  let lastKey = undefined;
  let scannedCount = 0;

  do {
    const params = {
      TableName: UNIQUE_KEYS_TABLE,
      FilterExpression: 'begins_with(#key, :prefix)',
      ExpressionAttributeNames: { '#key': 'key' },
      ExpressionAttributeValues: { ':prefix': 'event#' },
      ExclusiveStartKey: lastKey
    };

    const result = await dynamodb.scan(params).promise();
    scannedCount += result.Count;

    sentinels.push(...result.Items);
    lastKey = result.LastEvaluatedKey;

    process.stdout.write(`\rScanned ${scannedCount} event sentinels...`);
  } while (lastKey);

  console.log(`\n\nFound ${sentinels.length} event sentinels\n`);
  return sentinels;
}

async function findOrphans(sentinels) {
  console.log('Checking which events still exist...\n');

  // Extract unique event IDs from sentinels
  const eventIds = [...new Set(sentinels.map(s => s.refId))];
  console.log(`Unique events referenced: ${eventIds.length}`);

  // Batch get all events
  const existingEvents = await batchGetEvents(eventIds);
  console.log(`Events that exist: ${existingEvents.size}`);

  // Find orphans (sentinels where event doesn't exist)
  const orphans = sentinels.filter(s => !existingEvents.has(s.refId));

  return { orphans, existingEvents, totalSentinels: sentinels.length };
}

async function deleteOrphans(orphans, dryRun = false) {
  if (orphans.length === 0) {
    console.log('\n✅ No orphan sentinels found - all clean!\n');
    return { deleted: 0, keys: [] };
  }

  console.log(`\n⚠️  Found ${orphans.length} orphan sentinels\n`);

  if (dryRun) {
    console.log('DRY RUN - would delete the following orphan sentinels:');
    orphans.forEach(o => {
      console.log(`  - ${o.key} (refId: ${o.refId}, entityType: ${o.entityType})`);
    });
    return { deleted: 0, keys: orphans.map(o => o.key) };
  }

  console.log('Deleting orphan sentinels...\n');

  const deletedKeys = [];
  let deleted = 0;

  // Delete in batches of 25 (DynamoDB batchWrite limit)
  for (let i = 0; i < orphans.length; i += 25) {
    const batch = orphans.slice(i, i + 25);

    const params = {
      RequestItems: {
        [UNIQUE_KEYS_TABLE]: batch.map(o => ({
          DeleteRequest: { Key: { key: o.key } }
        }))
      }
    };

    await dynamodb.batchWrite(params).promise();

    deleted += batch.length;
    deletedKeys.push(...batch.map(o => o.key));

    process.stdout.write(`\rDeleted ${deleted}/${orphans.length} orphan sentinels...`);
  }

  console.log('\n');
  return { deleted, keys: deletedKeys };
}

async function generateReport(orphans, deletedKeys) {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ORPHAN EVENT SENTINELS CLEANUP REPORT');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Group orphans by event ID
  const byEvent = new Map();
  orphans.forEach(o => {
    if (!byEvent.has(o.refId)) {
      byEvent.set(o.refId, []);
    }
    byEvent.get(o.refId).push(o.key);
  });

  console.log(`Total orphan sentinels deleted: ${deletedKeys.length}`);
  console.log(`Orphaned events: ${byEvent.size}\n`);

  console.log('Orphaned events and their released sentinel keys:\n');

  for (const [eventId, keys] of byEvent.entries()) {
    console.log(`Event: ${eventId} (${keys.length} sentinels released)`);
    keys.forEach(k => console.log(`  - ${k}`));
    console.log('');
  }

  console.log('═══════════════════════════════════════════════════════════\n');

  // Check for the specific known orphan
  const knownOrphan = 'f40fccde-d448-4514-8bc4-6cb7f52cc6d8';
  if (byEvent.has(knownOrphan)) {
    console.log(`✅ VERIFIED: Known orphan ${knownOrphan} cleaned up`);
    console.log(`   Released keys: ${byEvent.get(knownOrphan).join(', ')}\n`);
  }

  return { orphanedEvents: byEvent.size, totalSentinels: deletedKeys.length };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
  }

  try {
    // Step 1: Scan all event sentinels
    const sentinels = await scanAllEventSentinels();

    // Step 2: Find orphans
    const { orphans, existingEvents, totalSentinels } = await findOrphans(sentinels);

    // Step 3: Delete orphans
    const { deleted, keys } = await deleteOrphans(orphans, dryRun);

    // Step 4: Generate report
    if (deleted > 0 || orphans.length > 0) {
      await generateReport(orphans, keys);
    }

    console.log('✅ Cleanup complete!\n');

    if (!dryRun && deleted > 0) {
      console.log('⚠️  IMPORTANT: The blocked creates can now be re-run:');
      console.log('   - Eaton Park (HOifh16xNRfedOMgSkG1) @ The Bush on 2026-08-01');
      console.log('   - The Vanz (7a16a3b6-ed61-4d0f-8191-1d89fdcf440f) @ The Bush on 2026-08-01\n');
    }

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run cleanup
console.log('Starting orphan event sentinel cleanup...\n');
main();
