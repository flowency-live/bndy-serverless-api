// Delete the 4 duplicate artists with no events

const AWS = require('aws-sdk');

AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const SAFE_TO_DELETE = [
  { id: '417962f4-46bb-4b3c-a005-c39aea1b19e9', name: 'Lost Boyz' },
  { id: '1db507d9-f13a-4eb3-a86c-390fe6d814a9', name: 'The Incredible Skank Brothers' },
  { id: '463df1e8-b3d9-465f-8435-2437dd5f195e', name: 'Borderland Band' },
  { id: 'uKGhTCuzlJ9RjE7ZnwWg', name: 'The Brothers' },
];

async function main() {
  console.log(`Deleting ${SAFE_TO_DELETE.length} duplicate artists (no events)...\n`);

  let deleted = 0;
  let failed = 0;

  for (const artist of SAFE_TO_DELETE) {
    try {
      await dynamodb.delete({
        TableName: 'bndy-artists',
        Key: { id: artist.id }
      }).promise();

      console.log(`✓ Deleted: ${artist.id} ("${artist.name}")`);
      deleted++;
    } catch (error) {
      console.error(`✗ Failed to delete ${artist.id}:`, error.message);
      failed++;
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Deleted: ${deleted}`);
  console.log(`Failed: ${failed}`);
  console.log(`${'='.repeat(50)}`);

  console.log('\nNote: 24 duplicate artists have events and need manual merge.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
