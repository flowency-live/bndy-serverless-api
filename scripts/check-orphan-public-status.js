const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

async function checkPublicStatus() {
  // Sample a few orphan event IDs to check their public status
  const sampleIds = [
    'd0e61fe5-69c5-4fce-b752-165466078011', // Overtime @ Heroes
    '5af88922-73af-4e21-9aaf-29c27e50314e', // Artisan Tap (no externalIds)
    '1db6229d-9aa1-4a8b-81eb-a8656c794f91', // Another Artisan Tap
    'bed5b18e-101a-48db-bf47-2f711d5342c8', // Festival
    '6fb6723a-91a6-4794-b5d1-d720c4482b31'  // KLMA import
  ];

  let publicCount = 0;
  let privateCount = 0;

  for (const id of sampleIds) {
    const result = await dynamodb.get({
      TableName: 'bndy-events',
      Key: { id }
    }).promise();

    if (result.Item) {
      const e = result.Item;
      console.log(`Event ${id}:`);
      console.log(`  Title: ${e.title}`);
      console.log(`  isPublic: ${e.isPublic}`);
      console.log(`  Source: ${e.source || 'N/A'}`);
      console.log(`  Created: ${e.created_at || e.createdAt}`);
      console.log(`  External IDs: ${JSON.stringify(e.external_ids || [])}`);
      console.log('');

      if (e.isPublic === true) {
        publicCount++;
      } else {
        privateCount++;
      }
    } else {
      console.log(`Event ${id}: NOT FOUND (already deleted?)`);
      console.log('');
    }
  }

  console.log(`Summary: ${publicCount} public, ${privateCount} private`);
}

checkPublicStatus().catch(console.error);
