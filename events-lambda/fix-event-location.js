/**
 * Fix Event Location Script
 *
 * This script updates events that have stale location coordinates
 * after a venue's location was corrected.
 *
 * Usage: node scripts/fix-event-location.js <venueId>
 *
 * Example: node scripts/fix-event-location.js 2f267d08-9a64-4c86-a9d3-b95e3d68f173
 */

const AWS = require('aws-sdk');
const ngeohash = require('ngeohash');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

const EVENTS_TABLE = 'bndy-events';
const VENUES_TABLE = 'bndy-venues';

// Compute geohash fields from venue location (copied from events-lambda)
const computeGeohashFields = (venue) => {
  if (!venue || !venue.latitude || !venue.longitude) {
    return {
      geohash6: null,
      geohash4: null,
      geoLat: null,
      geoLng: null
    };
  }

  return {
    geohash6: ngeohash.encode(venue.latitude, venue.longitude, 6),
    geohash4: ngeohash.encode(venue.latitude, venue.longitude, 4),
    geoLat: venue.latitude,
    geoLng: venue.longitude
  };
};

async function getVenue(venueId) {
  const result = await dynamodb.get({
    TableName: VENUES_TABLE,
    Key: { id: venueId }
  }).promise();

  return result.Item;
}

async function getEventsForVenue(venueId) {
  // Query using the venueId-date-index GSI
  // Note: This GSI uses camelCase 'venueId'
  const result = await dynamodb.query({
    TableName: EVENTS_TABLE,
    IndexName: 'venueId-date-index',
    KeyConditionExpression: 'venueId = :venueId',
    ExpressionAttributeValues: {
      ':venueId': venueId
    }
  }).promise();

  return result.Items || [];
}

async function updateEventLocation(eventId, geohashFields) {
  const now = new Date().toISOString();

  await dynamodb.update({
    TableName: EVENTS_TABLE,
    Key: { id: eventId },
    UpdateExpression: 'SET geoLat = :lat, geoLng = :lng, geohash6 = :gh6, geohash4 = :gh4, updatedAt = :now',
    ExpressionAttributeValues: {
      ':lat': geohashFields.geoLat,
      ':lng': geohashFields.geoLng,
      ':gh6': geohashFields.geohash6,
      ':gh4': geohashFields.geohash4,
      ':now': now
    }
  }).promise();
}

async function main() {
  const venueId = process.argv[2];

  if (!venueId) {
    console.error('Usage: node scripts/fix-event-location.js <venueId>');
    console.error('Example: node scripts/fix-event-location.js 2f267d08-9a64-4c86-a9d3-b95e3d68f173');
    process.exit(1);
  }

  console.log(`\n=== Fix Event Location Script ===`);
  console.log(`Venue ID: ${venueId}\n`);

  // 1. Get venue
  console.log('1. Fetching venue...');
  const venue = await getVenue(venueId);

  if (!venue) {
    console.error(`ERROR: Venue not found: ${venueId}`);
    process.exit(1);
  }

  console.log(`   Found: ${venue.name}`);
  console.log(`   Address: ${venue.address}`);
  console.log(`   Current coords: ${venue.latitude}, ${venue.longitude}`);

  // 2. Compute new geohash fields
  console.log('\n2. Computing geohash fields...');
  const geohashFields = computeGeohashFields(venue);
  console.log(`   geoLat: ${geohashFields.geoLat}`);
  console.log(`   geoLng: ${geohashFields.geoLng}`);
  console.log(`   geohash6: ${geohashFields.geohash6}`);
  console.log(`   geohash4: ${geohashFields.geohash4}`);

  // 3. Get events for this venue
  console.log('\n3. Querying events for this venue...');
  const events = await getEventsForVenue(venueId);
  console.log(`   Found ${events.length} event(s)`);

  if (events.length === 0) {
    console.log('\n   No events to update.');
    return;
  }

  // 4. Show events and their current coords
  console.log('\n4. Events to update:');
  for (const event of events) {
    const needsUpdate = event.geoLat !== geohashFields.geoLat || event.geoLng !== geohashFields.geoLng;
    console.log(`   - ${event.id}`);
    console.log(`     Title: ${event.title || 'N/A'}`);
    console.log(`     Date: ${event.date}`);
    console.log(`     Current: ${event.geoLat}, ${event.geoLng}`);
    console.log(`     Needs update: ${needsUpdate ? 'YES' : 'NO'}`);
  }

  // 5. Ask for confirmation (in DRY_RUN mode by default)
  const dryRun = !process.argv.includes('--apply');

  if (dryRun) {
    console.log('\n=== DRY RUN MODE ===');
    console.log('No changes made. Run with --apply to update events.');
    return;
  }

  // 6. Update events
  console.log('\n5. Updating events...');
  let updated = 0;
  let skipped = 0;

  for (const event of events) {
    const needsUpdate = event.geoLat !== geohashFields.geoLat || event.geoLng !== geohashFields.geoLng;

    if (!needsUpdate) {
      console.log(`   Skipping ${event.id} (already correct)`);
      skipped++;
      continue;
    }

    try {
      await updateEventLocation(event.id, geohashFields);
      console.log(`   Updated ${event.id}`);
      updated++;
    } catch (error) {
      console.error(`   ERROR updating ${event.id}:`, error.message);
    }
  }

  console.log(`\n=== Complete ===`);
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
}

main().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
