const AWS = require('aws-sdk');
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

async function getFullDetails() {
  const ids = [
    'feda6aac-d0d8-4f77-bb52-c0121f58c55d',
    'c46d1fb6-4be9-4b07-a560-71ff62d57f47',
    '2f6de396-4fc8-4c5f-89e0-a54bd93f8e32'
  ];
  
  for (const id of ids) {
    const result = await dynamodb.get({
      TableName: 'bndy-artist-songs',
      Key: { id }
    }).promise();
    
    console.log('\n=== Song ID:', id, '===');
    console.log(JSON.stringify(result.Item, null, 2));
  }
}

getFullDetails().catch(console.error);
