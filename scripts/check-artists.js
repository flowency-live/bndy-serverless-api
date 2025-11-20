// Check artists in database for owner_user_id
const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

async function checkArtists() {
  console.log('Scanning bndy-artists table...\n');

  const result = await dynamodb.scan({
    TableName: 'bndy-artists',
    ProjectionExpression: 'id, #name, owner_user_id, #source, needs_review',
    ExpressionAttributeNames: {
      '#name': 'name',
      '#source': 'source'
    }
  }).promise();

  const backstage = result.Items.filter(a => a.owner_user_id);
  const frontstage = result.Items.filter(a => !a.owner_user_id);
  const withSource = result.Items.filter(a => a.source);
  const withoutSource = result.Items.filter(a => !a.source);

  console.log('=== BACKSTAGE ARTISTS (have owner_user_id) ===');
  backstage.forEach(a => {
    console.log(`  - ${a.name} (ID: ${a.id.substring(0, 8)}..., Source: ${a.source || 'NULL'})`);
  });

  console.log(`\n=== FRONTSTAGE ARTISTS (no owner_user_id) ===`);
  frontstage.slice(0, 10).forEach(a => {
    console.log(`  - ${a.name} (ID: ${a.id.substring(0, 8)}..., Source: ${a.source || 'NULL'})`);
  });
  if (frontstage.length > 10) {
    console.log(`  ... and ${frontstage.length - 10} more`);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total artists: ${result.Items.length}`);
  console.log(`Backstage (owner_user_id set): ${backstage.length}`);
  console.log(`Frontstage (no owner): ${frontstage.length}`);
  console.log(`Already have source field: ${withSource.length}`);
  console.log(`Missing source field: ${withoutSource.length}`);
}

checkArtists().catch(console.error);
