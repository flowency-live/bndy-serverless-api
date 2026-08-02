/**
 * Find Orphaned Events - Full Scan
 * Finds events where artistId or collaboratingArtistIds reference non-existent artists
 */
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
  console.log('Found', artistIds.size, 'artists\n');

  console.log('Scanning all events...');
  const events = await scanAll('bndy-events', {
    ProjectionExpression: 'id, #d, title, artistId, artistIds, collaboratingArtistIds, venueId, venueName, external_ids, createdAt, isPublic',
    ExpressionAttributeNames: { '#d': 'date' }
  });
  console.log('Found', events.length, 'total events\n');

  // Find orphaned events
  const orphaned = [];

  for (const event of events) {
    const deadArtistIds = [];

    // Check primary artistId
    if (event.artistId && !artistIds.has(event.artistId)) {
      deadArtistIds.push(event.artistId);
    }

    // Check artistIds array
    if (event.artistIds && Array.isArray(event.artistIds)) {
      for (const aid of event.artistIds) {
        if (aid && !artistIds.has(aid)) {
          deadArtistIds.push(aid);
        }
      }
    }

    // Check collaboratingArtistIds
    if (event.collaboratingArtistIds && Array.isArray(event.collaboratingArtistIds)) {
      for (const aid of event.collaboratingArtistIds) {
        if (aid && !artistIds.has(aid)) {
          deadArtistIds.push(aid);
        }
      }
    }

    if (deadArtistIds.length > 0) {
      orphaned.push({
        ...event,
        deadArtistIds: [...new Set(deadArtistIds)]
      });
    }
  }

  // Separate future vs past
  const futureOrphans = orphaned.filter(e => e.date >= today);
  const pastOrphans = orphaned.filter(e => e.date < today);

  console.log('=== ORPHANED EVENTS SUMMARY ===');
  console.log('Total orphaned:', orphaned.length);
  console.log('Future orphaned:', futureOrphans.length);
  console.log('Past orphaned:', pastOrphans.length);
  console.log();

  console.log('=== FUTURE ORPHANED EVENTS (for deletion) ===\n');
  for (const e of futureOrphans.sort((a, b) => a.date.localeCompare(b.date))) {
    const externalSources = (e.external_ids || []).map(ext => ext.source).join(', ') || 'none';
    console.log('---');
    console.log('ID:', e.id);
    console.log('Date:', e.date);
    console.log('Title:', e.title);
    console.log('Venue:', e.venueName, `(${e.venueId})`);
    console.log('Dead artistIds:', e.deadArtistIds.join(', '));
    console.log('External sources:', externalSources);
    console.log('Created:', e.createdAt);
    console.log('Public:', e.isPublic);
  }

  if (pastOrphans.length > 0) {
    console.log('\n=== PAST ORPHANED EVENTS (for review) ===\n');
    for (const e of pastOrphans.slice(0, 10)) {
      console.log('---');
      console.log('ID:', e.id);
      console.log('Date:', e.date);
      console.log('Title:', e.title);
      console.log('Venue:', e.venueName);
      console.log('Dead artistIds:', e.deadArtistIds.join(', '));
    }
    if (pastOrphans.length > 10) {
      console.log(`\n... and ${pastOrphans.length - 10} more past orphans`);
    }
  }

  // Output JSON for automation
  console.log('\n=== JSON OUTPUT ===');
  console.log(JSON.stringify({
    summary: {
      totalOrphaned: orphaned.length,
      futureOrphaned: futureOrphans.length,
      pastOrphaned: pastOrphans.length
    },
    futureOrphans: futureOrphans.map(e => ({
      id: e.id,
      date: e.date,
      title: e.title,
      venueId: e.venueId,
      venueName: e.venueName,
      deadArtistIds: e.deadArtistIds,
      externalSources: (e.external_ids || []).map(ext => ext.source),
      createdAt: e.createdAt
    }))
  }, null, 2));
}

main().catch(console.error);
