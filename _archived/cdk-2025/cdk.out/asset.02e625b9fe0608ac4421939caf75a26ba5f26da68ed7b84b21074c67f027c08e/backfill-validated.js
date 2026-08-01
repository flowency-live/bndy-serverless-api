const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

const ARTISTS_TABLE = 'bndy-artists';

async function backfillValidated() {
  console.log('Scanning all artists...');

  const result = await dynamodb.scan({
    TableName: ARTISTS_TABLE
  }).promise();

  const artists = result.Items || [];
  console.log(`Found ${artists.length} artists`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const artist of artists) {
    try {
      // Skip if already has validated field set to true
      if (artist.validated === true) {
        skipped++;
        continue;
      }

      await dynamodb.update({
        TableName: ARTISTS_TABLE,
        Key: { id: artist.id },
        UpdateExpression: 'SET validated = :validated, updated_at = :now',
        ExpressionAttributeValues: {
          ':validated': false,
          ':now': new Date().toISOString()
        }
      }).promise();

      updated++;
      console.log(`Updated artist ${artist.id} (${artist.name}) - set validated=false`);
    } catch (error) {
      failed++;
      console.error(`Failed to update artist ${artist.id}:`, error.message);
    }
  }

  console.log(`\nBackfill complete:`);
  console.log(`- Updated: ${updated}`);
  console.log(`- Skipped (already validated): ${skipped}`);
  console.log(`- Failed: ${failed}`);
}

backfillValidated().catch(console.error);