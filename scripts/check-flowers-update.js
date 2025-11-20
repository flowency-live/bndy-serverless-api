const AWS = require('aws-sdk');
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

async function checkFlowers() {
  const result = await dynamodb.get({
    TableName: 'bndy-artist-songs',
    Key: { id: '5b0d61b9-4c5d-42ae-9b86-c05d243d7c39' }
  }).promise();

  console.log('Flowers song current state:');
  console.log('ID: ' + result.Item.id);
  console.log('custom_key: ' + (result.Item.custom_key || 'NULL'));
  console.log('custom_tempo: ' + (result.Item.custom_tempo || 'NULL'));
  console.log('updated_at: ' + result.Item.updated_at);
  console.log('\nFull record:');
  console.log(JSON.stringify(result.Item, null, 2));
}

checkFlowers().catch(console.error);
