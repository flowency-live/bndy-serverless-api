const AWS = require('aws-sdk');
const lambda = new AWS.Lambda({ region: 'eu-west-2' });

const venues = [
  { name: "Cow'd Feet Club", id: "5f320798-5056-4cdd-a654-5ba745fd51b7" },
  { name: "Crown Inn, Coniston", id: "f50feb04-8ff5-48e0-a210-9605daf54dc2" },
  { name: "The Red Lion Inn", id: "003ec327-a0e3-478b-ac72-7fef1d85099d" }
];

async function enrichVenue(venueId) {
  const response = await lambda.invoke({
    FunctionName: 'venue-enrichment-lambda',
    InvocationType: 'RequestResponse',
    Payload: JSON.stringify({ body: JSON.stringify({ venueId }) })
  }).promise();

  const result = JSON.parse(response.Payload);
  const body = JSON.parse(result.body);
  return body;
}

async function main() {
  console.log('Testing 3 venues with city extraction fix...\n');
  console.log('='.repeat(80) + '\n');

  const results = [];

  for (const venue of venues) {
    console.log(`Testing: ${venue.name}`);

    try {
      const result = await enrichVenue(venue.id);
      results.push({ name: venue.name, ...result });

      console.log(`  Status: ${result.status}`);
      if (result.enrichmentData) {
        console.log(`  Website: ${result.enrichmentData.website || 'none'}`);
        console.log(`  Facebook: ${result.enrichmentData.facebook || 'none'}`);
        console.log(`  Confidence: ${result.enrichmentData.confidence}`);
      }
      console.log('');

      // Wait 3 seconds between requests
      if (venue !== venues[venues.length - 1]) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } catch (error) {
      console.log(`  ERROR: ${error.message}\n`);
      results.push({ name: venue.name, error: error.message });
    }
  }

  console.log('='.repeat(80));
  console.log('\nFACEBOOK URLs FOUND:\n');

  results.forEach((r, i) => {
    const facebook = r.enrichmentData?.facebook;
    console.log(`${i + 1}. ${r.name}`);
    console.log(`   ${facebook || '(no Facebook URL)'}`);
    console.log('');
  });
}

main().catch(console.error);
