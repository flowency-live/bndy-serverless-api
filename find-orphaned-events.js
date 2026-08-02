const AWS = require('aws-sdk');
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

async function scanAll(tableName, params = {}) {
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
  const today = new Date().toISOString().split('T')[0];

  console.log('Scanning all artists...');
  const artists = await scanAll('bndy-artists', {
    ProjectionExpression: 'id'
  });
  const artistIds = new Set(artists.map(a => a.id));
  console.log('Found', artistIds.size, 'artists');

  console.log('Scanning future events...');
  const events = await scanAll('bndy-events', {
    ProjectionExpression: 'id, #d, title, artistId, artistName, venueName',
    ExpressionAttributeNames: { '#d': 'date' },
    FilterExpression: '#d >= :today',
    ExpressionAttributeValues: { ':today': today }
  });
  console.log('Found', events.length, 'future events');

  // Find orphaned events (artistId doesn't exist)
  const orphaned = events.filter(e => e.artistId && !artistIds.has(e.artistId));

  console.log('\n=== ORPHANED FUTURE EVENTS ===');
  console.log('Total:', orphaned.length, '\n');

  for (const e of orphaned.sort((a, b) => a.date.localeCompare(b.date))) {
    console.log('---');
    console.log('Date:', e.date);
    console.log('Title:', e.title);
    console.log('Artist Name:', e.artistName || '(none)');
    console.log('Venue:', e.venueName || '(none)');
    console.log('Event ID:', e.id);
    console.log('Missing Artist ID:', e.artistId);
  }
}

main().catch(console.error);
