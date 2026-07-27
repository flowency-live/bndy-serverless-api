// Cleanup Script: Delete events, artists, venues created in the past 48 hours
// For cleaning up source runner test data

const AWS = require('aws-sdk');

AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const HOURS_AGO = 48;
const cutoffDate = new Date(Date.now() - HOURS_AGO * 60 * 60 * 1000).toISOString();

console.log(`Cutoff: ${cutoffDate} (${HOURS_AGO} hours ago)\n`);

async function scanTable(tableName, idField = 'id') {
  console.log(`Scanning ${tableName}...`);
  const items = [];
  let lastEvaluatedKey = null;

  do {
    const params = {
      TableName: tableName,
      FilterExpression: 'createdAt >= :cutoff',
      ExpressionAttributeValues: { ':cutoff': cutoffDate },
    };

    if (lastEvaluatedKey) {
      params.ExclusiveStartKey = lastEvaluatedKey;
    }

    const result = await dynamodb.scan(params).promise();
    items.push(...result.Items);
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(`  Found ${items.length} items created after ${cutoffDate}\n`);
  return items;
}

async function deleteItems(tableName, items, idField = 'id') {
  if (items.length === 0) return { deleted: 0, failed: 0 };

  let deleted = 0;
  let failed = 0;

  for (const item of items) {
    try {
      await dynamodb.delete({
        TableName: tableName,
        Key: { [idField]: item[idField] }
      }).promise();
      deleted++;
    } catch (error) {
      console.error(`  ✗ Failed: ${item[idField]} - ${error.message}`);
      failed++;
    }
  }

  return { deleted, failed };
}

async function main() {
  // Find items
  const events = await scanTable('bndy-events');
  const artists = await scanTable('bndy-artists');
  const venues = await scanTable('bndy-venues');

  console.log('Summary of items to delete:');
  console.log(`  Events:  ${events.length}`);
  console.log(`  Artists: ${artists.length}`);
  console.log(`  Venues:  ${venues.length}`);
  console.log('');

  if (events.length === 0 && artists.length === 0 && venues.length === 0) {
    console.log('Nothing to delete!');
    return;
  }

  // Show sample of what we're deleting
  if (events.length > 0) {
    console.log('Sample events to delete:');
    events.slice(0, 5).forEach(e => {
      console.log(`  ${e.id} | ${e.date} | ${e.venueName || ''} | ${e.artistName || ''} | created: ${e.createdAt}`);
    });
    if (events.length > 5) console.log(`  ... and ${events.length - 5} more`);
    console.log('');
  }

  if (artists.length > 0) {
    console.log('Sample artists to delete:');
    artists.slice(0, 5).forEach(a => {
      console.log(`  ${a.id} | ${a.name} | created: ${a.createdAt}`);
    });
    if (artists.length > 5) console.log(`  ... and ${artists.length - 5} more`);
    console.log('');
  }

  if (venues.length > 0) {
    console.log('Sample venues to delete:');
    venues.slice(0, 5).forEach(v => {
      console.log(`  ${v.id} | ${v.name} | created: ${v.createdAt}`);
    });
    if (venues.length > 5) console.log(`  ... and ${venues.length - 5} more`);
    console.log('');
  }

  // Delete
  console.log('Deleting...\n');

  const eventsResult = await deleteItems('bndy-events', events);
  console.log(`Events:  deleted ${eventsResult.deleted}, failed ${eventsResult.failed}`);

  const artistsResult = await deleteItems('bndy-artists', artists);
  console.log(`Artists: deleted ${artistsResult.deleted}, failed ${artistsResult.failed}`);

  const venuesResult = await deleteItems('bndy-venues', venues);
  console.log(`Venues:  deleted ${venuesResult.deleted}, failed ${venuesResult.failed}`);

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
