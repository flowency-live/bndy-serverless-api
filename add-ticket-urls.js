const AWS = require('aws-sdk');
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const TICKET_URL = 'https://sexpistolsexpose.com/';
const ARTIST_ID = 'HtgnaBRCm3xxEEMjcgpe';

async function main() {
  // Get all events for this artist
  const result = await dynamodb.scan({
    TableName: 'bndy-events',
    FilterExpression: 'artistId = :aid',
    ExpressionAttributeValues: { ':aid': ARTIST_ID },
    ProjectionExpression: 'id, title'
  }).promise();

  console.log(`Found ${result.Items.length} events for Sex Pistols Expose`);

  let updated = 0;
  for (const event of result.Items) {
    await dynamodb.update({
      TableName: 'bndy-events',
      Key: { id: event.id },
      UpdateExpression: 'SET ticketUrl = :url',
      ExpressionAttributeValues: { ':url': TICKET_URL }
    }).promise();
    updated++;
    console.log(`Updated: ${event.title}`);
  }

  console.log(`\nDone! Updated ${updated} events with ticketUrl`);
}

main().catch(console.error);
