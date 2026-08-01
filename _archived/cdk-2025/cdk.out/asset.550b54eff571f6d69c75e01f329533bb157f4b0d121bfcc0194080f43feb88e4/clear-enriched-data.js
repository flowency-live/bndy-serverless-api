const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

async function clearEnrichedData() {
  console.log('Loading venues to clear...\n');

  const venuesToClear = require('C:/tmp/venues-to-clear.json');

  // Combine all unique venue IDs
  const allVenueIds = new Set([
    ...venuesToClear.aiCreated.map(v => v.id),
    ...venuesToClear.enrichedHighConfidence.map(v => v.id)
  ]);

  console.log(`Total venues to clear: ${allVenueIds.size}\n`);
  console.log('This will:');
  console.log('  - Remove website field');
  console.log('  - Remove social_media_urls field');
  console.log('  - Remove enrichment_status field');
  console.log('  - Remove enrichment_data field');
  console.log('  - Remove enrichment_date field\n');

  let cleared = 0;
  let failed = 0;

  for (const venueId of allVenueIds) {
    try {
      // First get the venue to show what we're clearing
      const getResult = await dynamodb.get({
        TableName: 'bndy-venues',
        Key: { id: venueId }
      }).promise();

      const venue = getResult.Item;
      if (!venue) {
        console.log(`[SKIP] Venue ${venueId} not found`);
        continue;
      }

      console.log(`[${cleared + 1}/${allVenueIds.size}] Clearing: ${venue.name}`);
      console.log(`  Website: ${venue.website || 'none'}`);
      console.log(`  Social: ${venue.social_media_urls ? venue.social_media_urls.length + ' URLs' : 'none'}`);

      // Build update expression to remove all enrichment fields
      const updateParams = {
        TableName: 'bndy-venues',
        Key: { id: venueId },
        UpdateExpression: 'REMOVE website, social_media_urls, enrichment_status, enrichment_data, enrichment_date',
        ReturnValues: 'UPDATED_NEW'
      };

      await dynamodb.update(updateParams).promise();
      cleared++;
      console.log(`  ✓ Cleared\n`);

    } catch (error) {
      console.error(`[ERROR] Failed to clear ${venueId}:`, error.message);
      failed++;
    }

    // Rate limiting - don't hammer DynamoDB
    if (cleared % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  console.log('\n=== CLEANUP COMPLETE ===');
  console.log(`Total venues processed: ${allVenueIds.size}`);
  console.log(`Successfully cleared: ${cleared}`);
  console.log(`Failed: ${failed}`);
}

clearEnrichedData().catch(console.error);
