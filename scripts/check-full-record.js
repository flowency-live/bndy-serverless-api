const AWS = require('aws-sdk');
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

async function checkFullRecord() {
  // Get one song that you say you updated successfully
  const result = await dynamodb.get({
    TableName: 'bndy-artist-songs',
    Key: { id: '5b0d61b9-4c5d-42ae-9b86-c05d243d7c39' }
  }).promise();

  console.log('FULL RECORD for Flowers song:');
  console.log(JSON.stringify(result.Item, null, 2));
}

checkFullRecord().catch(console.error);
