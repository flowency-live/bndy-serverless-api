const AWS = require('aws-sdk');
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

async function deleteOrphanedRecords() {
  const orphanedIds = [
    'feda6aac-d0d8-4f77-bb52-c0121f58c55d',
    'c46d1fb6-4be9-4b07-a560-71ff62d57f47',
    '2f6de396-4fc8-4c5f-89e0-a54bd93f8e32'
  ];
  
  console.log('Deleting 3 orphaned artist-song records without song_id...\n');
  
  for (const id of orphanedIds) {
    try {
      await dynamodb.delete({
        TableName: 'bndy-artist-songs',
        Key: { id }
      }).promise();
      
      console.log('Deleted: ' + id);
    } catch (error) {
      console.error('Failed to delete ' + id + ': ' + error.message);
    }
  }
  
  console.log('\nDone! Orphaned records removed.');
}

deleteOrphanedRecords().catch(console.error);
