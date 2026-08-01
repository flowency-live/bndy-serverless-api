const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const lambda = new AWS.Lambda({ region: 'eu-west-2' });

const BATCH_SIZE = 10;
const DELAY_BETWEEN_VENUES = 3000; // 3 seconds
const DELAY_BETWEEN_BATCHES = 10000; // 10 seconds

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getVenuesWithoutFacebook() {
  const params = { TableName: 'bndy-venues' };
  const result = await dynamodb.scan(params).promise();

  return result.Items.filter(v => {
    const hasFacebook = v.social_media_urls?.some(url =>
      typeof url === 'string' && url.includes('facebook.com')
    );
    return !hasFacebook;
  });
}

async function enrichVenue(venueId) {
  const response = await lambda.invoke({
    FunctionName: 'venue-enrichment-lambda',
    InvocationType: 'RequestResponse',
    Payload: JSON.stringify({ body: JSON.stringify({ venueId }) })
  }).promise();

  const result = JSON.parse(response.Payload);
  return JSON.parse(result.body);
}

async function main() {
  console.log('Finding venues without Facebook URLs...\n');
  const venues = await getVenuesWithoutFacebook();

  console.log(`Found ${venues.length} venues without Facebook URLs\n`);

  const batches = [];
  for (let i = 0; i < venues.length; i += BATCH_SIZE) {
    batches.push(venues.slice(i, i + BATCH_SIZE));
  }

  console.log(`Processing ${batches.length} batches of ${BATCH_SIZE} venues\n`);

  let stats = { autoUpdated: 0, needsReview: 0, noResults: 0, failed: 0 };

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    console.log(`Batch ${batchIdx + 1}/${batches.length}:`);

    for (let i = 0; i < batch.length; i++) {
      const venue = batch[i];
      process.stdout.write(`  [${i + 1}/${batch.length}] ${venue.name}... `);

      try {
        const result = await enrichVenue(venue.id);

        if (result.status === 'auto_updated') {
          stats.autoUpdated++;
          console.log('✓');
        } else if (result.status === 'flagged_for_review') {
          stats.needsReview++;
          console.log('⚠');
        } else if (result.status === 'no_results') {
          stats.noResults++;
          console.log('○');
        } else {
          console.log(`(${result.status})`);
        }

        if (i < batch.length - 1) await sleep(DELAY_BETWEEN_VENUES);
      } catch (error) {
        stats.failed++;
        console.log(`✗ ${error.message}`);
      }
    }

    if (batchIdx < batches.length - 1) {
      console.log(`\n  Waiting ${DELAY_BETWEEN_BATCHES / 1000}s...\n`);
      await sleep(DELAY_BETWEEN_BATCHES);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('COMPLETE');
  console.log('='.repeat(60));
  console.log(`Total: ${venues.length}`);
  console.log(`✓ Auto-updated: ${stats.autoUpdated}`);
  console.log(`⚠ Flagged for review: ${stats.needsReview}`);
  console.log(`○ No results: ${stats.noResults}`);
  console.log(`✗ Failed: ${stats.failed}`);
}

main().catch(console.error);
