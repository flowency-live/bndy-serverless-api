const AWS = require('aws-sdk');
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

async function scan() {
  const events = [];
  let lastKey = null;

  do {
    const params = {
      TableName: 'bndy-events',
      ProjectionExpression: 'id, #d, venueId, venueName, title, artistId, artistName, startTime, isPublic, #t',
      ExpressionAttributeNames: { '#d': 'date', '#t': 'type' }
    };
    if (lastKey) params.ExclusiveStartKey = lastKey;

    const result = await dynamodb.scan(params).promise();
    events.push(...result.Items);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  // Group by date + venueId
  const grouped = {};
  for (const e of events) {
    if (!e.date || !e.venueId) continue;
    const key = e.date + '|' + e.venueId;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(e);
  }

  // Find duplicates (more than 1 event)
  const dupes = Object.entries(grouped)
    .filter(([k, v]) => v.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  console.log('Total events:', events.length);
  console.log('Unique date+venue combinations with multiple events:', dupes.length);
  console.log('\n=== TOP CASES (most events at same date+venue) ===\n');

  for (const [key, evts] of dupes.slice(0, 40)) {
    const [date, venueId] = key.split('|');
    console.log('---');
    console.log('Date:', date, '| Venue:', evts[0].venueName || venueId);
    console.log('Events:', evts.length);
    for (const e of evts) {
      console.log('  -', e.startTime || '??:??', '|', e.title || 'No title', '|', e.artistName || 'No artist', '| id:', e.id);
    }
  }

  // Look for likely duplicates: same date, venue, AND same/similar artist
  console.log('\n\n=== LIKELY TRUE DUPLICATES (same date + venue + artist) ===\n');

  let truedupes = 0;
  for (const [key, evts] of dupes) {
    // Group by artistId within this date+venue
    const byArtist = {};
    for (const e of evts) {
      const aid = e.artistId || 'unknown';
      if (!byArtist[aid]) byArtist[aid] = [];
      byArtist[aid].push(e);
    }

    // Check if any artist has multiple events
    for (const [artistId, artistEvts] of Object.entries(byArtist)) {
      if (artistEvts.length > 1) {
        truedupes++;
        const [date] = key.split('|');
        console.log('---');
        console.log('DUPLICATE: Date:', date, '| Venue:', artistEvts[0].venueName);
        console.log('Artist:', artistEvts[0].artistName, '| Artist ID:', artistId);
        for (const e of artistEvts) {
          console.log('  -', e.startTime || '??:??', '|', e.title, '| id:', e.id);
        }
      }
    }
  }

  console.log('\n\nTotal likely true duplicates (same date + venue + artist):', truedupes);
}

scan().catch(console.error);
