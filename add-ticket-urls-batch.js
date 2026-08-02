const AWS = require('aws-sdk');
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const ARTISTS_TO_UPDATE = [
  { artistId: 'HtgnaBRCm3xxEEMjcgpe', ticketUrl: 'https://sexpistolsexpose.com/', name: 'Sex Pistols Expose' },
  { artistId: '2f64737c-6785-4319-863d-de8ebb1961ec', ticketUrl: 'https://www.seetickets.com/tour/cud', name: 'CUD' }
];

async function scanAll(tableName, params) {
  const items = [];
  let lastKey = null;
  do {
    const scanParams = { TableName: tableName, ...params };
    if (lastKey) scanParams.ExclusiveStartKey = lastKey;
    const result = await dynamodb.scan(scanParams).promise();
    items.push(...result.Items);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function main() {
  for (const artist of ARTISTS_TO_UPDATE) {
    console.log(`\n=== ${artist.name} ===`);

    // Get all events for this artist
    const events = await scanAll('bndy-events', {
      FilterExpression: 'artistId = :aid',
      ExpressionAttributeValues: { ':aid': artist.artistId },
      ProjectionExpression: 'id, #d, title, venueName, ticketUrl',
      ExpressionAttributeNames: { '#d': 'date' }
    });

    console.log(`Found ${events.length} events`);

    // Filter to those without ticketUrl
    const needsUpdate = events.filter(e => !e.ticketUrl);
    console.log(`Need to update: ${needsUpdate.length} events`);

    if (needsUpdate.length === 0) {
      console.log('All events already have ticketUrl');
      continue;
    }

    let updated = 0;
    for (const event of needsUpdate) {
      await dynamodb.update({
        TableName: 'bndy-events',
        Key: { id: event.id },
        UpdateExpression: 'SET ticketUrl = :url',
        ExpressionAttributeValues: { ':url': artist.ticketUrl }
      }).promise();
      updated++;
      console.log(`Updated: ${event.date} | ${event.venueName || event.title}`);
    }

    console.log(`Done! Updated ${updated} events with ticketUrl`);
  }
}

main().catch(console.error);
