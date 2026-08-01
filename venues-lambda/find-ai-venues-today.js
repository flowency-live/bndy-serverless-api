const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

async function findAIVenuesToday() {
  console.log('Finding AI-created venues from today (2025-12-01)...\n');

  const params = {
    TableName: 'bndy-venues',
    FilterExpression: 'ai_created = :true',
    ExpressionAttributeValues: {
      ':true': true
    }
  };

  const result = await dynamodb.scan(params).promise();
  const allAIVenues = result.Items;

  console.log(`Total AI-created venues: ${allAIVenues.length}\n`);

  // Filter for today (2025-12-01)
  const todayStart = '2025-12-01T00:00:00.000Z';
  const todayEnd = '2025-12-02T00:00:00.000Z';

  const venuesToday = allAIVenues.filter(v => {
    return v.created_at && v.created_at >= todayStart && v.created_at < todayEnd;
  });

  console.log(`AI-created venues from today (2025-12-01): ${venuesToday.length}\n`);

  if (venuesToday.length === 0) {
    console.log('No AI-created venues found from today.');
    return;
  }

  console.log('='.repeat(80));
  console.log('AI-CREATED VENUES FROM TODAY (2025-12-01)');
  console.log('='.repeat(80));
  console.log('');

  venuesToday.forEach((venue, i) => {
    console.log(`${i + 1}. ${venue.name}`);
    console.log(`   ID: ${venue.id}`);
    console.log(`   Address: ${venue.address}`);
    console.log(`   Created: ${venue.created_at}`);
    console.log(`   Website: ${venue.website || 'none'}`);
    console.log(`   Social media: ${venue.social_media_urls ? venue.social_media_urls.length + ' URLs' : 'none'}`);
    console.log(`   Enrichment status: ${venue.enrichment_status || 'none'}`);
    console.log('');
  });

  console.log('='.repeat(80));
  console.log(`Total: ${venuesToday.length} AI-created venues from today`);
  console.log('='.repeat(80));
}

findAIVenuesToday().catch(console.error);
