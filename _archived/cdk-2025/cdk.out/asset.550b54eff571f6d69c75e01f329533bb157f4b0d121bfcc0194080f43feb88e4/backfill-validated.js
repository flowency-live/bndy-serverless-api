const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

const VENUES_TABLE = 'bndy-venues';

async function backfillValidated() {
  console.log('Scanning all venues...');

  const result = await dynamodb.scan({
    TableName: VENUES_TABLE
  }).promise();

  const venues = result.Items || [];
  console.log(`Found ${venues.length} venues`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const venue of venues) {
    try {
      // Skip if already has validated field set to true
      if (venue.validated === true) {
        skipped++;
        continue;
      }

      await dynamodb.update({
        TableName: VENUES_TABLE,
        Key: { id: venue.id },
        UpdateExpression: 'SET validated = :validated, updated_at = :now',
        ExpressionAttributeValues: {
          ':validated': false,
          ':now': new Date().toISOString()
        }
      }).promise();

      updated++;
      console.log(`Updated venue ${venue.id} (${venue.name}) - set validated=false`);
    } catch (error) {
      failed++;
      console.error(`Failed to update venue ${venue.id}:`, error.message);
    }
  }

  console.log(`\nBackfill complete:`);
  console.log(`- Updated: ${updated}`);
  console.log(`- Skipped (already validated): ${skipped}`);
  console.log(`- Failed: ${failed}`);
}

backfillValidated().catch(console.error);