// Duplicate Event Audit Script
// Finds events with same venue + date + artist + time

const AWS = require('aws-sdk');

AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

async function findDuplicateEvents() {
  console.log('Scanning all events for duplicates...\n');

  // Scan all events
  const allEvents = [];
  let lastEvaluatedKey = null;

  do {
    const params = {
      TableName: 'bndy-events',
      ProjectionExpression: 'id, venueId, venueName, artistId, artistIds, artistName, #date, startTime, title, createdAt, #source',
      ExpressionAttributeNames: {
        '#date': 'date',
        '#source': 'source'
      }
    };

    if (lastEvaluatedKey) {
      params.ExclusiveStartKey = lastEvaluatedKey;
    }

    const result = await dynamodb.scan(params).promise();
    allEvents.push(...result.Items);
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(`Total events scanned: ${allEvents.length}\n`);

  // Group events by venue + date + artist + time
  const eventGroups = {};

  for (const event of allEvents) {
    // Get all artist IDs for this event
    const artistIds = event.artistIds || (event.artistId ? [event.artistId] : []);

    for (const artistId of artistIds) {
      // Create a composite key
      const key = `${event.venueId}|${event.date}|${artistId}|${event.startTime}`;

      if (!eventGroups[key]) {
        eventGroups[key] = [];
      }
      eventGroups[key].push(event);
    }
  }

  // Find duplicates (groups with more than 1 event)
  const duplicates = Object.entries(eventGroups)
    .filter(([key, events]) => events.length > 1)
    .sort((a, b) => b[1].length - a[1].length); // Sort by most duplicates first

  console.log(`Found ${duplicates.length} duplicate groups\n`);
  console.log('=' .repeat(80));

  let totalDuplicateEvents = 0;

  for (const [key, events] of duplicates) {
    const [venueId, date, artistId, startTime] = key.split('|');
    const firstEvent = events[0];

    console.log(`\nVENUE: ${firstEvent.venueName || venueId}`);
    console.log(`DATE: ${date} @ ${startTime}`);
    console.log(`ARTIST: ${firstEvent.artistName || artistId}`);
    console.log(`DUPLICATES: ${events.length} events`);
    console.log('-'.repeat(40));

    for (const event of events) {
      console.log(`  ID: ${event.id}`);
      console.log(`  Title: ${event.title || 'N/A'}`);
      console.log(`  Source: ${event.source || 'unknown'}`);
      console.log(`  Created: ${event.createdAt || 'unknown'}`);
      console.log('');
    }

    totalDuplicateEvents += events.length - 1; // Count extra events beyond the first
  }

  console.log('=' .repeat(80));
  console.log(`\nSUMMARY:`);
  console.log(`Total events: ${allEvents.length}`);
  console.log(`Duplicate groups: ${duplicates.length}`);
  console.log(`Extra duplicate events to remove: ${totalDuplicateEvents}`);

  // Generate deletion candidates (keep the oldest, delete newer ones)
  console.log('\n\nDELETION CANDIDATES (keeping oldest event in each group):');
  console.log('=' .repeat(80));

  const toDelete = [];

  for (const [key, events] of duplicates) {
    // Sort by createdAt to keep oldest
    const sorted = events.sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt) : new Date(0);
      const dateB = b.createdAt ? new Date(b.createdAt) : new Date(0);
      return dateA - dateB;
    });

    const [keep, ...remove] = sorted;

    console.log(`\nKEEP: ${keep.id} (${keep.title || 'N/A'}) - created ${keep.createdAt || 'unknown'}`);
    for (const event of remove) {
      console.log(`  DELETE: ${event.id} (${event.title || 'N/A'}) - created ${event.createdAt || 'unknown'}`);
      toDelete.push(event.id);
    }
  }

  console.log('\n' + '=' .repeat(80));
  console.log(`\nTotal events to delete: ${toDelete.length}`);
  console.log('\nEvent IDs to delete:');
  console.log(JSON.stringify(toDelete, null, 2));

  return { duplicates: duplicates.length, toDelete };
}

findDuplicateEvents()
  .then(result => {
    console.log('\nAudit complete.');
    process.exit(0);
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
