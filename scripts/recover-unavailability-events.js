/**
 * Recovery Script: Find and restore deleted unavailability events
 *
 * Compares the PITR-recovered table (bndy-events-recovery-20260728) with
 * the current bndy-events table to find events that were incorrectly deleted.
 *
 * Unavailability events are legitimate - they represent artist member
 * unavailability dates, not orphaned public gig records.
 *
 * Usage:
 *   DRY RUN:  node scripts/recover-unavailability-events.js
 *   RESTORE:  node scripts/recover-unavailability-events.js --restore
 */

'use strict';

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

const CURRENT_TABLE = 'bndy-events';
const RECOVERY_TABLE = 'bndy-events-recovery-20260728';
const RESTORE_MODE = process.argv.includes('--restore');

async function scanTable(tableName) {
  console.log(`Scanning ${tableName}...`);
  const items = [];
  let lastKey = null;

  do {
    const params = {
      TableName: tableName,
      ExclusiveStartKey: lastKey,
    };

    const result = await dynamodb.scan(params).promise();
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;

    process.stdout.write(`\r  ${items.length} items...`);
  } while (lastKey);

  console.log(`\n  Found ${items.length} items in ${tableName}\n`);
  return items;
}

function isUnavailabilityEvent(event) {
  // Unavailability events typically:
  // - Have type='unavailability' or similar
  // - Have ownerUserId (member who created it)
  // - Have artistId (which band they're unavailable for)
  // - May NOT have a venueId (not a public gig)
  // - May have allowedEventTypes including 'practice' or similar

  // Check for explicit type field
  if (event.type === 'unavailability' || event.type === 'blocked') {
    return true;
  }

  // Check for ownerUserId presence (member-created event)
  if (event.ownerUserId && !event.venueId && !event.isPublic) {
    return true;
  }

  // Check for non-public events with specific allowed types
  if (!event.isPublic && event.allowedEventTypes &&
      (event.allowedEventTypes.includes('practice') ||
       event.allowedEventTypes.includes('unavailable'))) {
    return true;
  }

  return false;
}

async function findDeletedEvents(recoveredEvents, currentEvents) {
  // Build a set of current event IDs for fast lookup
  const currentIds = new Set(currentEvents.map(e => e.id));

  // Find events that exist in recovery but not in current
  const deletedEvents = recoveredEvents.filter(e => !currentIds.has(e.id));

  console.log(`Found ${deletedEvents.length} events that were deleted\n`);

  return deletedEvents;
}

function categorizeDeletedEvents(deletedEvents) {
  const unavailabilityEvents = [];
  const orphanedGigs = [];
  const other = [];

  for (const event of deletedEvents) {
    if (isUnavailabilityEvent(event)) {
      unavailabilityEvents.push(event);
    } else if (event.venueId || event.isPublic) {
      orphanedGigs.push(event);
    } else {
      other.push(event);
    }
  }

  return { unavailabilityEvents, orphanedGigs, other };
}

async function restoreEvents(events) {
  if (events.length === 0) {
    console.log('No events to restore.\n');
    return 0;
  }

  console.log(`Restoring ${events.length} events to ${CURRENT_TABLE}...\n`);

  let restored = 0;
  let failed = 0;

  // Batch write in chunks of 25
  for (let i = 0; i < events.length; i += 25) {
    const batch = events.slice(i, i + 25);

    const params = {
      RequestItems: {
        [CURRENT_TABLE]: batch.map(event => ({
          PutRequest: { Item: event }
        }))
      }
    };

    try {
      await dynamodb.batchWrite(params).promise();
      restored += batch.length;
      process.stdout.write(`\r  Restored ${restored}/${events.length}...`);
    } catch (err) {
      failed += batch.length;
      console.error(`\n  Failed batch: ${err.message}`);
    }
  }

  console.log(`\n\nRestored: ${restored}, Failed: ${failed}\n`);
  return restored;
}

function printReport(categories, deletedEvents) {
  console.log('\n' + '='.repeat(70));
  console.log('  DELETED EVENTS RECOVERY REPORT');
  console.log('='.repeat(70) + '\n');

  console.log(`Total deleted events found: ${deletedEvents.length}`);
  console.log(`  - Unavailability events: ${categories.unavailabilityEvents.length}`);
  console.log(`  - Orphaned gigs (correct deletions): ${categories.orphanedGigs.length}`);
  console.log(`  - Other: ${categories.other.length}`);
  console.log('');

  if (categories.unavailabilityEvents.length > 0) {
    console.log('UNAVAILABILITY EVENTS (should be restored):');
    console.log('-'.repeat(70));

    for (const event of categories.unavailabilityEvents.slice(0, 20)) {
      console.log(`  ID: ${event.id}`);
      console.log(`    Date: ${event.date}`);
      console.log(`    Artist ID: ${event.artistId || 'N/A'}`);
      console.log(`    Owner User ID: ${event.ownerUserId || 'N/A'}`);
      console.log(`    Type: ${event.type || 'N/A'}`);
      console.log(`    Title: ${event.title || 'Untitled'}`);
      console.log('');
    }

    if (categories.unavailabilityEvents.length > 20) {
      console.log(`  ... and ${categories.unavailabilityEvents.length - 20} more\n`);
    }
  }

  if (categories.other.length > 0) {
    console.log('OTHER EVENTS (review manually):');
    console.log('-'.repeat(70));

    for (const event of categories.other.slice(0, 10)) {
      console.log(`  ID: ${event.id}`);
      console.log(`    Date: ${event.date}`);
      console.log(`    Artist ID: ${event.artistId || 'N/A'}`);
      console.log(`    Venue ID: ${event.venueId || 'N/A'}`);
      console.log(`    Owner: ${event.ownerUserId || 'N/A'}`);
      console.log(`    Public: ${event.isPublic || false}`);
      console.log(`    Type: ${event.type || 'N/A'}`);
      console.log('');
    }

    if (categories.other.length > 10) {
      console.log(`  ... and ${categories.other.length - 10} more\n`);
    }
  }

  console.log('='.repeat(70) + '\n');
}

async function main() {
  console.log('');
  console.log('='.repeat(70));
  console.log('  UNAVAILABILITY EVENTS RECOVERY');
  console.log('='.repeat(70));
  console.log(`Mode: ${RESTORE_MODE ? 'RESTORE' : 'DRY RUN'}`);
  console.log('');

  // Step 1: Scan both tables
  const recoveredEvents = await scanTable(RECOVERY_TABLE);
  const currentEvents = await scanTable(CURRENT_TABLE);

  // Step 2: Find deleted events
  const deletedEvents = await findDeletedEvents(recoveredEvents, currentEvents);

  if (deletedEvents.length === 0) {
    console.log('No deleted events found. Nothing to recover.\n');
    return;
  }

  // Step 3: Categorize
  const categories = categorizeDeletedEvents(deletedEvents);

  // Step 4: Print report
  printReport(categories, deletedEvents);

  // Step 5: Restore unavailability events (+ other non-gig events)
  const toRestore = [...categories.unavailabilityEvents, ...categories.other];

  if (RESTORE_MODE) {
    const restored = await restoreEvents(toRestore);
    console.log(`Restored ${restored} events to ${CURRENT_TABLE}\n`);
  } else {
    console.log(`DRY RUN: Would restore ${toRestore.length} events`);
    console.log(`Run with --restore to actually restore them.\n`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
