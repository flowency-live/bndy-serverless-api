// Local test script for venue-enrichment-lambda
// Tests the Lambda function locally with a sample venue

require('dotenv').config({ path: '../.env' });
const handler = require('./handler');

async function testEnrichment() {
  // Test with "Stock Dove" from next_batch.json
  // This venue has Facebook already, so we can verify the logic handles existing data
  const testEvent = {
    body: JSON.stringify({
      venueId: 'Dc3cChyFYIJErgEhZN8T' // Stock Dove from next_batch.json
    })
  };

  console.log('Testing venue enrichment...\n');
  console.log('Test venue ID: Dc3cChyFYIJErgEhZN8T (Stock Dove)');
  console.log('Expected: Should find Facebook (already has it) and potentially find website\n');

  try {
    const result = await handler.handler(testEvent);
    console.log('Result:', JSON.stringify(JSON.parse(result.body), null, 2));
  } catch (error) {
    console.error('Test failed:', error);
  }
}

testEnrichment();
