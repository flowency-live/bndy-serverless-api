// Clear enrichment_status from all venues so they can be re-enriched
const AWS = require('../venues-lambda/node_modules/aws-sdk');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

async function clearEnrichmentStatus() {
  console.log('Fetching all venues...');

  const params = {
    TableName: 'bndy-venues',
    FilterExpression: 'attribute_exists(enrichment_status)'
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

    console.log(`Fetched ${items.length} venues with enrichment_status...`);
  } while (lastEvaluatedKey);

  console.log(`\nFound ${items.length} venues to clear\n`);

  let cleared = 0;
  let failed = 0;

  for (const venue of items) {
    try {
      await dynamodb.update({
        TableName: 'bndy-venues',
        Key: { id: venue.id },
        UpdateExpression: 'REMOVE enrichment_status, enrichment_data, enrichment_date'
      }).promise();

      cleared++;
      if (cleared % 10 === 0) {
        console.log(`Cleared ${cleared}/${items.length}...`);
      }
    } catch (error) {
      console.error(`Failed to clear ${venue.name}:`, error.message);
      failed++;
    }
  }

  console.log(`\nComplete: ${cleared} cleared, ${failed} failed`);
}

clearEnrichmentStatus().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
