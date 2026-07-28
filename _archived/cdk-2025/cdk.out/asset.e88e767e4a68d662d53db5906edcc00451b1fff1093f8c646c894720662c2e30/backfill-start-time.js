const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

const EVENTS_TABLE = 'bndy-events';

async function backfillStartTime() {
  console.log('Scanning for events without startTime...');

  // Scan for events without startTime
  const result = await dynamodb.scan({
    TableName: EVENTS_TABLE,
    FilterExpression: 'attribute_not_exists(startTime)'
  }).promise();

  const eventsToUpdate = result.Items || [];
  console.log(`Found ${eventsToUpdate.length} events without startTime`);

  if (eventsToUpdate.length === 0) {
    console.log('No events to update');
    return;
  }

  // Update each event
  let updated = 0;
  let failed = 0;

  for (const event of eventsToUpdate) {
    try {
      await dynamodb.update({
        TableName: EVENTS_TABLE,
        Key: { id: event.id },
        UpdateExpression: 'SET startTime = :time, updatedAt = :now',
        ExpressionAttributeValues: {
          ':time': '21:00',
          ':now': new Date().toISOString()
        }
      }).promise();

      updated++;
      console.log(`Updated event ${event.id} (${event.date} at ${event.venue || event.title})`);
    } catch (error) {
      failed++;
      console.error(`Failed to update event ${event.id}:`, error.message);
    }
  }

  console.log(`\nBackfill complete:`);
  console.log(`- Updated: ${updated}`);
  console.log(`- Failed: ${failed}`);
}

backfillStartTime().catch(console.error);