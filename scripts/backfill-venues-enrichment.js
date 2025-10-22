// Backfill script to enrich all existing venues
// Usage:
//   node scripts/backfill-venues-enrichment.js [startBatch] [numBatches]
//
// Examples:
//   node scripts/backfill-venues-enrichment.js           # Process batches 0-4 (first 50 venues)
//   node scripts/backfill-venues-enrichment.js 5 5       # Process batches 5-9 (venues 50-99)
//   node scripts/backfill-venues-enrichment.js 0 all     # Process ALL batches (careful!)

const AWS = require('../venues-lambda/node_modules/aws-sdk');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const lambda = new AWS.Lambda({ region: 'eu-west-2' });

const VENUES_PER_BATCH = 10;
const DELAY_BETWEEN_VENUES_MS = 2000; // 2 seconds between each venue
const DELAY_BETWEEN_BATCHES_MS = 60000; // 60 seconds between batches
const DEFAULT_NUM_BATCHES = 5; // Process 5 batches by default (50 venues)

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

  // Parse command line arguments
  const args = process.argv.slice(2);
  const startBatch = args[0] ? parseInt(args[0]) : 0;
  const numBatchesArg = args[1] || DEFAULT_NUM_BATCHES;
  const processAll = numBatchesArg === 'all';

  const totalBatches = Math.ceil(venues.length / VENUES_PER_BATCH);
  const numBatches = processAll ? totalBatches - startBatch : parseInt(numBatchesArg);
  const endBatch = Math.min(startBatch + numBatches, totalBatches);
  const actualBatches = endBatch - startBatch;

  console.log(`Total batches available: ${totalBatches}`);
  console.log(`Processing batches: ${startBatch + 1}-${endBatch} (${actualBatches} batches)`);

  const venuesToProcess = Math.min(actualBatches * VENUES_PER_BATCH, venues.length - (startBatch * VENUES_PER_BATCH));
  console.log(`Venues to process: ${venuesToProcess}\n`);

  // Recalculate cost estimate for this run
  const estimatedGoogleCostRun = venuesToProcess * googleSearchesPerVenue * 0.005;
  const estimatedClaudeCostRun = venuesToProcess * claudeCallsPerVenue * 0.003;
  const totalEstimatedCostRun = estimatedGoogleCostRun + estimatedClaudeCostRun;

  console.log('COST ESTIMATE FOR THIS RUN:');
  console.log(`  Google Searches: ${venuesToProcess * googleSearchesPerVenue} searches (~$${estimatedGoogleCostRun.toFixed(2)})`);
  console.log(`  Claude API calls: ${venuesToProcess} calls (~$${estimatedClaudeCostRun.toFixed(2)})`);
  console.log(`  TOTAL ESTIMATED: ~$${totalEstimatedCostRun.toFixed(2)}\n`);

  const estimatedTime = actualBatches * ((VENUES_PER_BATCH * DELAY_BETWEEN_VENUES_MS) + DELAY_BETWEEN_BATCHES_MS);
  const estimatedMinutes = Math.ceil(estimatedTime / 60000);
  console.log(`Estimated runtime: ~${estimatedMinutes} minutes\n`);

  let totalSucceeded = 0;
  let totalFailed = 0;

  // Process batches
  for (let batchIdx = startBatch; batchIdx < endBatch; batchIdx++) {
    const startIdx = batchIdx * VENUES_PER_BATCH;
    const endIdx = Math.min(startIdx + VENUES_PER_BATCH, venues.length);
    const batchVenues = venues.slice(startIdx, endIdx);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`BATCH ${batchIdx + 1}/${totalBatches} (venues ${startIdx + 1}-${endIdx})`);
    console.log(`${'='.repeat(60)}\n`);

    let batchSucceeded = 0;
    let batchFailed = 0;

    for (let i = 0; i < batchVenues.length; i++) {
      const venue = batchVenues[i];
      const globalIndex = startIdx + i + 1;

      console.log(`[${globalIndex}/${venues.length}] ${venue.name} (${venue.id})`);

      const result = await triggerEnrichment(venue.id);

      if (result.success) {
        batchSucceeded++;
        console.log(`  Success`);
      } else {
        batchFailed++;
        console.log(`  FAILED: ${result.error}`);
      }

      if (i < batchVenues.length - 1) {
        await sleep(DELAY_BETWEEN_VENUES_MS);
      }
    }

    totalSucceeded += batchSucceeded;
    totalFailed += batchFailed;

    console.log(`\nBatch ${batchIdx + 1} complete: ${batchSucceeded} succeeded, ${batchFailed} failed`);

    if (batchIdx < endBatch - 1) {
      console.log(`\nWaiting ${DELAY_BETWEEN_BATCHES_MS / 1000}s before next batch...`);
      await sleep(DELAY_BETWEEN_BATCHES_MS);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('BACKFILL SESSION COMPLETE');
  console.log(`${'='.repeat(60)}`);
  console.log(`Batches processed: ${actualBatches}`);
  console.log(`Total triggered: ${totalSucceeded + totalFailed}`);
  console.log(`Succeeded: ${totalSucceeded}`);
  console.log(`Failed: ${totalFailed}`);
  console.log(`Success rate: ${((totalSucceeded / (totalSucceeded + totalFailed)) * 100).toFixed(1)}%`);

  const remaining = venues.length - (endBatch * VENUES_PER_BATCH);
  if (remaining > 0) {
    console.log(`\nVenues remaining: ${remaining}`);
    console.log(`\nTo continue, run:`);
    console.log(`  node scripts/backfill-venues-enrichment.js ${endBatch} ${DEFAULT_NUM_BATCHES}`);
  }

  console.log('\nNote: Enrichment happens asynchronously. Check CloudWatch logs and DynamoDB for results.');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
