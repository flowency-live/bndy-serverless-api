const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const lambda = new AWS.Lambda({ region: 'eu-west-2' });

const DELAY_BETWEEN_VENUES_MS = 3000; // 3 seconds (to avoid rate limits)

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getAICreatedVenues() {
  console.log('Fetching AI-created venues from DynamoDB...\n');

  const params = {
    TableName: 'bndy-venues',
    FilterExpression: 'ai_created = :true',
    ExpressionAttributeValues: {
      ':true': true
    }
  };

  const result = await dynamodb.scan(params).promise();
  return result.Items;
}

async function triggerEnrichment(venueId) {
  try {
    const response = await lambda.invoke({
      FunctionName: 'venue-enrichment-lambda',
      InvocationType: 'RequestResponse', // Synchronous
      Payload: JSON.stringify({ body: JSON.stringify({ venueId }) })
    }).promise();

    const result = JSON.parse(response.Payload);
    const body = JSON.parse(result.body);

    return {
      success: result.statusCode === 200,
      status: body.status,
      enrichmentData: body.enrichmentData,
      message: body.message
    };
  } catch (error) {
    console.error(`Failed to trigger enrichment:`, error.message);
    return { success: false, error: error.message };
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('RE-ENRICHING AI-CREATED VENUES');
  console.log('='.repeat(60));
  console.log('');

  // Fetch all AI-created venues
  const venues = await getAICreatedVenues();
  console.log(`Found ${venues.length} AI-created venues\n`);

  if (venues.length === 0) {
    console.log('No AI-created venues to enrich. Exiting.');
    return;
  }

  let stats = {
    total: venues.length,
    autoUpdated: 0,
    needsReview: 0,
    noResults: 0,
    failed: 0
  };

  // Process each venue
  for (let i = 0; i < venues.length; i++) {
    const venue = venues[i];
    const num = i + 1;

    console.log(`[${num}/${venues.length}] ${venue.name}`);
    console.log(`  Address: ${venue.address}`);

    const result = await triggerEnrichment(venue.id);

    if (!result.success) {
      console.log(`  ❌ FAILED: ${result.error}\n`);
      stats.failed++;
    } else {
      switch (result.status) {
        case 'auto_updated':
          console.log(`  ✅ AUTO-UPDATED (HIGH confidence)`);
          if (result.enrichmentData) {
            console.log(`     Website: ${result.enrichmentData.website || 'none'}`);
            console.log(`     Facebook: ${result.enrichmentData.facebook || 'none'}`);
          }
          stats.autoUpdated++;
          break;

        case 'flagged_for_review':
          console.log(`  ⚠️  FLAGGED FOR REVIEW (${result.enrichmentData?.confidence || 'MEDIUM/LOW'} confidence)`);
          if (result.enrichmentData) {
            console.log(`     Website: ${result.enrichmentData.website || 'none'}`);
            console.log(`     Facebook: ${result.enrichmentData.facebook || 'none'}`);
          }
          stats.needsReview++;
          break;

        case 'no_results':
          console.log(`  ⏭️  NO RESULTS (Google search returned 0 results)`);
          stats.noResults++;
          break;

        default:
          console.log(`  ℹ️  ${result.status}: ${result.message}`);
          break;
      }
      console.log('');
    }

    // Rate limiting - wait between venues
    if (i < venues.length - 1) {
      await sleep(DELAY_BETWEEN_VENUES_MS);
    }
  }

  // Summary
  console.log('='.repeat(60));
  console.log('ENRICHMENT COMPLETE');
  console.log('='.repeat(60));
  console.log(`Total venues processed: ${stats.total}`);
  console.log(`✅ Auto-updated (HIGH confidence): ${stats.autoUpdated}`);
  console.log(`⚠️  Flagged for review (MEDIUM/LOW): ${stats.needsReview}`);
  console.log(`⏭️  No search results found: ${stats.noResults}`);
  console.log(`❌ Failed: ${stats.failed}`);
  console.log('');
  console.log(`Success rate: ${((stats.autoUpdated + stats.needsReview + stats.noResults) / stats.total * 100).toFixed(1)}%`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
