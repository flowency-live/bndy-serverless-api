// Backfill script to add name_lower and name_prefix fields to existing artists
// Run this AFTER the GSI has been created and is ACTIVE

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

function generateNameSearchFields(name) {
  const nameLower = name.toLowerCase().trim();
  const namePrefix = nameLower.substring(0, 2);
  return { name_lower: nameLower, name_prefix: namePrefix };
}

async function backfillSearchFields() {
  console.log('[BACKFILL] Fetching all artists from bndy-artists table...');

  try {
    const result = await dynamodb.scan({ TableName: 'bndy-artists' }).promise();
    const artists = result.Items;

    console.log(`[BACKFILL] Found ${artists.length} artists to update`);
    console.log('');

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const artist of artists) {
      // Skip if already has search fields
      if (artist.name_lower && artist.name_prefix) {
        console.log(`[SKIP] ${artist.name} - already has search fields`);
        skipped++;
        continue;
      }

      try {
        const searchFields = generateNameSearchFields(artist.name);

        await dynamodb.update({
          TableName: 'bndy-artists',
          Key: { id: artist.id },
          UpdateExpression: 'SET name_lower = :name_lower, name_prefix = :name_prefix',
          ExpressionAttributeValues: {
            ':name_lower': searchFields.name_lower,
            ':name_prefix': searchFields.name_prefix
          }
        }).promise();

        console.log(`[OK] ${artist.name} -> prefix: "${searchFields.name_prefix}", lower: "${searchFields.name_lower}"`);
        updated++;
      } catch (error) {
        console.error(`[ERROR] Failed to update ${artist.name}:`, error.message);
        errors++;
      }
    }

    console.log('');
    console.log('='.repeat(60));
    console.log('[BACKFILL] Complete!');
    console.log(`  Total artists: ${artists.length}`);
    console.log(`  Updated: ${updated}`);
    console.log(`  Skipped (already had fields): ${skipped}`);
    console.log(`  Errors: ${errors}`);
    console.log('='.repeat(60));
    console.log('');
    console.log('[NEXT STEPS]');
    console.log('1. Verify GSI status is ACTIVE: aws dynamodb describe-table --table-name bndy-artists --region eu-west-2 --query "Table.GlobalSecondaryIndexes[?IndexName==\'name-search-index\'].IndexStatus"');
    console.log('2. Deploy updated Lambda function');
    console.log('3. Test artist search: curl "https://api.bndy.co.uk/api/artists/search?name=the"');
    console.log('4. Check CloudWatch logs for "using GSI Query" message');

  } catch (error) {
    console.error('[BACKFILL] Fatal error:', error);
    process.exit(1);
  }
}

// Run the backfill
backfillSearchFields().catch(error => {
  console.error('[BACKFILL] Unhandled error:', error);
  process.exit(1);
});
