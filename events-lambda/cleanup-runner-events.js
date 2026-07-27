// Cleanup Script: Delete events created by the KLMA source runner
// These are duplicates that were created before the dedup fix

const AWS = require('aws-sdk');

AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const SOURCE_TO_DELETE = 'klma-stoke-gig-list';

async function findRunnerEvents() {
  console.log(`Finding events with source='${SOURCE_TO_DELETE}'...\n`);

  const allEvents = [];
  let lastEvaluatedKey = null;

  do {
    const params = {
      TableName: 'bndy-events',
      FilterExpression: '#source = :source',
      ExpressionAttributeNames: { '#source': 'source', '#date': 'date' },
      ExpressionAttributeValues: { ':source': SOURCE_TO_DELETE },
      ProjectionExpression: 'id, venueId, venueName, artistId, artistName, #date, startTime, title, createdAt, #source',
    };

    if (lastEvaluatedKey) {
      params.ExclusiveStartKey = lastEvaluatedKey;
    }

    const result = await dynamodb.scan(params).promise();
    allEvents.push(...result.Items);
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(`Found ${allEvents.length} events with source='${SOURCE_TO_DELETE}':\n`);

  for (const event of allEvents) {
    console.log(`  ${event.id} | ${event.date} | ${event.venueName || event.venueId} | ${event.artistName || event.artistId}`);
  }

  return allEvents;
}

async function deleteEvents(events) {
  if (events.length === 0) {
    console.log('No events to delete.');
    return { deleted: 0, failed: 0 };
  }

  console.log(`\nDeleting ${events.length} events...\n`);

  let deleted = 0;
  let failed = 0;

  for (const event of events) {
    try {
      await dynamodb.delete({
        TableName: 'bndy-events',
        Key: { id: event.id }
      }).promise();

      console.log(`✓ Deleted: ${event.id}`);
      deleted++;
    } catch (error) {
      console.error(`✗ Failed to delete ${event.id}:`, error.message);
      failed++;
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Deleted: ${deleted}`);
  console.log(`Failed: ${failed}`);
  console.log(`${'='.repeat(50)}`);

  return { deleted, failed };
}

async function main() {
  const events = await findRunnerEvents();

  if (events.length === 0) {
    console.log('\nNo runner events found. Already clean!');
    return;
  }

  // Ask for confirmation
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.question(`\nDelete these ${events.length} events? (yes/no): `, async (answer) => {
    rl.close();

    if (answer.toLowerCase() === 'yes') {
      await deleteEvents(events);
    } else {
      console.log('Aborted.');
    }

    process.exit(0);
  });
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
