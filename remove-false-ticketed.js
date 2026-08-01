/**
 * Migration Script: Remove ticketed: false from all events
 *
 * Problem: Current schema has ticketed: boolean defaulting to false.
 * Existing ticketed: false values are indistinguishable from genuine falses.
 * We need tri-state: true | false | absent (unset).
 *
 * Solution: Strip all existing false values in one-off sweep (treat as unset).
 * Preserve ticketed: true (those are meaningful explicit values).
 *
 * Usage:
 *   DRY RUN: node remove-false-ticketed.js --dry-run
 *   EXECUTE: node remove-false-ticketed.js
 *
 * AWS credentials must be configured (AWS_PROFILE or environment variables)
 */

const AWS = require('aws-sdk');

// Configure AWS
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const TABLE_NAME = 'bndy-events';
const DRY_RUN = process.argv.includes('--dry-run');

async function scanAllEvents() {
  const events = [];
  let lastEvaluatedKey = null;

  console.log('Scanning all events from bndy-events table...');

  do {
    const params = {
      TableName: TABLE_NAME,
      ProjectionExpression: 'id, ticketed, title',
      ExclusiveStartKey: lastEvaluatedKey
    };

    const result = await dynamodb.scan(params).promise();
    events.push(...result.Items);
    lastEvaluatedKey = result.LastEvaluatedKey;

    process.stdout.write(`\rScanned ${events.length} events...`);
  } while (lastEvaluatedKey);

  console.log(`\nTotal events scanned: ${events.length}`);
  return events;
}

async function removeTicketedAttribute(eventId) {
  const params = {
    TableName: TABLE_NAME,
    Key: { id: eventId },
    UpdateExpression: 'REMOVE ticketed',
    ReturnValues: 'UPDATED_OLD'
  };

  return dynamodb.update(params).promise();
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Migration: Remove ticketed: false from events');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'EXECUTE (will modify database)'}`);
  console.log('');

  try {
    const events = await scanAllEvents();

    // Find events with ticketed: false
    const eventsWithFalse = events.filter(e => e.ticketed === false);
    const eventsWithTrue = events.filter(e => e.ticketed === true);
    const eventsWithUnset = events.filter(e => e.ticketed === undefined || e.ticketed === null);

    console.log('');
    console.log('Current state:');
    console.log(`  - Events with ticketed: true  → ${eventsWithTrue.length} (will be PRESERVED)`);
    console.log(`  - Events with ticketed: false → ${eventsWithFalse.length} (will be REMOVED)`);
    console.log(`  - Events with ticketed unset  → ${eventsWithUnset.length} (no change needed)`);
    console.log('');

    if (eventsWithFalse.length === 0) {
      console.log('No events with ticketed: false found. Nothing to do.');
      return;
    }

    if (DRY_RUN) {
      console.log('DRY RUN - Would remove ticketed attribute from these events:');
      eventsWithFalse.slice(0, 10).forEach(e => {
        console.log(`  - ${e.id}: ${e.title || '(no title)'}`);
      });
      if (eventsWithFalse.length > 10) {
        console.log(`  ... and ${eventsWithFalse.length - 10} more`);
      }
      console.log('');
      console.log('Run without --dry-run to execute.');
      return;
    }

    // Execute migration
    console.log('Removing ticketed: false from events...');
    let successCount = 0;
    let errorCount = 0;

    for (const event of eventsWithFalse) {
      try {
        await removeTicketedAttribute(event.id);
        successCount++;
        process.stdout.write(`\rProcessed ${successCount + errorCount}/${eventsWithFalse.length}...`);
      } catch (error) {
        errorCount++;
        console.error(`\nError updating event ${event.id}: ${error.message}`);
      }
    }

    console.log('');
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('  Migration Complete');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  Successfully updated: ${successCount}`);
    console.log(`  Errors: ${errorCount}`);
    console.log(`  Events with ticketed: true preserved: ${eventsWithTrue.length}`);
    console.log('═══════════════════════════════════════════════════════════════════');

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

main();
