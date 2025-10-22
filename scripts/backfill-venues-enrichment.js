// Backfill script to enrich all existing venues
// Usage: node scripts/backfill-venues-enrichment.js

const AWS = require('aws-sdk');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const lambda = new AWS.Lambda({ region: 'eu-west-2' });

const RATE_LIMIT_MS = 2000; // 2 seconds between invocations (30 per minute)
const BATCH_SIZE = 10; // Process 10 venues, then pause

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getAllVenues() {
  const params = {
    TableName: 'bndy-venues',
    FilterExpression: 'attribute_not_exists(enrichment_status)'
  };

  const items = [];
  let lastEvaluatedKey = null;

  do {
    if (lastEvaluatedKey) {
      params.ExclusiveStartKey = lastEvaluatedKey;
    }

    const result = await dynamodb.scan(params).promise();
    items.push(...result.Items);
    lastEvaluatedKey = result.LastEvaluatedKey;

    console.log(`Fetched ${items.length} venues so far...`);
  } while (lastEvaluatedKey);

  return items;
}

async function triggerEnrichment(venueId) {
  try {
    await lambda.invoke({
      FunctionName: 'venue-enrichment-lambda',
      InvocationType: 'Event', // Async
      Payload: JSON.stringify({ body: JSON.stringify({ venueId }) })
    }).promise();
    return { success: true };
  } catch (error) {
    console.error(`Failed to trigger enrichment for ${venueId}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function main() {
  console.log('Starting venue enrichment backfill...\n');

  // Fetch all venues without enrichment_status
  console.log('Fetching venues from DynamoDB...');
  const venues = await getAllVenues();
  console.log(`Found ${venues.length} venues to enrich\n`);

  if (venues.length === 0) {
    console.log('No venues to enrich. Exiting.');
    return;
  }

  // Estimate costs
  const googleSearchesPerVenue = 2; // general + facebook
  const claudeCallsPerVenue = 1;
  const estimatedGoogleCost = venues.length * googleSearchesPerVenue * 0.005; // $5 per 1000 searches
  const estimatedClaudeCost = venues.length * claudeCallsPerVenue * 0.003; // ~$3 per 1000 calls
  const totalEstimatedCost = estimatedGoogleCost + estimatedClaudeCost;

  console.log('COST ESTIMATE:');
  console.log(`  Google Searches: ${venues.length * googleSearchesPerVenue} searches (~$${estimatedGoogleCost.toFixed(2)})`);
  console.log(`  Claude API calls: ${venues.length} calls (~$${estimatedClaudeCost.toFixed(2)})`);
  console.log(`  TOTAL ESTIMATED: ~$${totalEstimatedCost.toFixed(2)}\n`);

  console.log(`Processing ${venues.length} venues with ${RATE_LIMIT_MS}ms delay between each...\n`);

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < venues.length; i++) {
    const venue = venues[i];

    console.log(`[${i + 1}/${venues.length}] Triggering enrichment for: ${venue.name} (${venue.id})`);

    const result = await triggerEnrichment(venue.id);
    processed++;

    if (result.success) {
      succeeded++;
      console.log(`  Success! (${succeeded} succeeded, ${failed} failed)`);
    } else {
      failed++;
      console.log(`  FAILED: ${result.error} (${succeeded} succeeded, ${failed} failed)`);
    }

    // Rate limiting
    if (i < venues.length - 1) {
      await sleep(RATE_LIMIT_MS);
    }

    // Progress update every batch
    if (processed % BATCH_SIZE === 0) {
      console.log(`\nProgress: ${processed}/${venues.length} (${((processed/venues.length)*100).toFixed(1)}%)`);
      console.log(`Success rate: ${succeeded}/${processed} (${((succeeded/processed)*100).toFixed(1)}%)\n`);
    }
  }

  console.log('\n=== BACKFILL COMPLETE ===');
  console.log(`Total processed: ${processed}`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed: ${failed}`);
  console.log(`Success rate: ${((succeeded/processed)*100).toFixed(1)}%`);
  console.log('\nNote: Enrichment happens asynchronously. Check CloudWatch logs and DynamoDB for results.');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
