// Diagnostic: Artist count and duplicate analysis
// READ-ONLY - no modifications

const AWS = require('aws-sdk');

AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

async function runDiagnostic() {
  console.log('='.repeat(80));
  console.log('ARTIST DIAGNOSTIC - READ ONLY');
  console.log('='.repeat(80));
  console.log('');

  // 1. Total artist count
  console.log('1. TOTAL ARTIST COUNT');
  console.log('-'.repeat(40));

  let totalArtists = 0;
  let lastKey = null;
  const allArtists = [];

  do {
    const params = {
      TableName: 'bndy-artists',
      ProjectionExpression: 'id, #name, #location, externalIds, createdAt',
      ExpressionAttributeNames: { '#name': 'name', '#location': 'location' }
    };
    if (lastKey) params.ExclusiveStartKey = lastKey;

    const result = await dynamodb.scan(params).promise();
    totalArtists += result.Count;
    allArtists.push(...result.Items);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  console.log(`Total artists: ${totalArtists}`);
  console.log('');

  // 2. Artists with/without location
  console.log('2. LOCATION BREAKDOWN');
  console.log('-'.repeat(40));

  const withLocation = allArtists.filter(a => a.location && a.location.trim().length > 0);
  const withoutLocation = allArtists.filter(a => !a.location || a.location.trim().length === 0);

  console.log(`With location: ${withLocation.length}`);
  console.log(`Without location: ${withoutLocation.length}`);
  console.log('');

  // 3. Artists with/without externalIds
  console.log('3. EXTERNAL IDS BREAKDOWN');
  console.log('-'.repeat(40));

  const withExternalIds = allArtists.filter(a => a.externalIds && a.externalIds.length > 0);
  const withoutExternalIds = allArtists.filter(a => !a.externalIds || a.externalIds.length === 0);

  console.log(`With externalIds: ${withExternalIds.length}`);
  console.log(`Without externalIds: ${withoutExternalIds.length}`);
  console.log('');

  // 4. Event count per artist (sample)
  console.log('4. EVENT DISTRIBUTION (sampling...)');
  console.log('-'.repeat(40));

  // Count events per artist (full scan)
  let totalEvents = 0;
  let eventLastKey = null;
  const artistEventCounts = {};

  do {
    const params = {
      TableName: 'bndy-events',
      ProjectionExpression: 'artistId',
    };
    if (eventLastKey) params.ExclusiveStartKey = eventLastKey;

    const result = await dynamodb.scan(params).promise();
    for (const event of result.Items) {
      if (event.artistId) {
        artistEventCounts[event.artistId] = (artistEventCounts[event.artistId] || 0) + 1;
        totalEvents++;
      }
    }
    eventLastKey = result.LastEvaluatedKey;
  } while (eventLastKey);

  const artistsWithEvents = Object.keys(artistEventCounts).length;
  const artistsWithoutEvents = totalArtists - artistsWithEvents;

  console.log(`Total events: ${totalEvents}`);
  console.log(`Artists with ≥1 event: ${artistsWithEvents}`);
  console.log(`Artists with 0 events: ${artistsWithoutEvents}`);
  console.log('');

  // 5. Top artists by event count
  console.log('5. TOP 10 ARTISTS BY EVENT COUNT');
  console.log('-'.repeat(40));

  const sortedByEvents = Object.entries(artistEventCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  for (const [artistId, count] of sortedByEvents) {
    const artist = allArtists.find(a => a.id === artistId);
    const name = artist ? artist.name : 'UNKNOWN';
    console.log(`  ${count.toString().padStart(4)} events: ${name} (${artistId.substring(0, 8)}...)`);
  }
  console.log('');

  // 6. Duplicate analysis (using slug normalization from spec)
  console.log('6. DUPLICATE ANALYSIS');
  console.log('-'.repeat(40));

  const LEADING_ARTICLES = ['the ', 'a ', 'an '];
  const TRAILING_SUFFIXES = [' band', ' duo', ' trio', ' live', ' acoustic', ' show', ' experience', ' collective', ' solo', ' music'];

  function slugNormalise(raw) {
    let name = (raw || '').toLowerCase().trim();
    for (const article of LEADING_ARTICLES) {
      if (name.startsWith(article)) {
        name = name.substring(article.length);
        break;
      }
    }
    for (const suffix of TRAILING_SUFFIXES) {
      if (name.endsWith(suffix)) {
        name = name.slice(0, -suffix.length);
        break;
      }
    }
    return name.replace(/[''‚‛'`&]/g, '').replace(/[^a-z0-9]+/g, '');
  }

  const slugGroups = {};
  for (const artist of allArtists) {
    const slug = slugNormalise(artist.name);
    if (!slugGroups[slug]) slugGroups[slug] = [];
    slugGroups[slug].push(artist);
  }

  const duplicateGroups = Object.entries(slugGroups)
    .filter(([_, artists]) => artists.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  console.log(`Unique slugs: ${Object.keys(slugGroups).length}`);
  console.log(`Duplicate groups (≥2 artists per slug): ${duplicateGroups.length}`);

  let totalDuplicateArtists = 0;
  let totalEventsAffected = 0;
  for (const [_, artists] of duplicateGroups) {
    totalDuplicateArtists += artists.length - 1; // Extra beyond the first
    for (const artist of artists.slice(1)) {
      totalEventsAffected += artistEventCounts[artist.id] || 0;
    }
  }
  console.log(`Extra duplicate artists: ${totalDuplicateArtists}`);
  console.log(`Events on duplicate artists: ${totalEventsAffected}`);
  console.log('');

  // 7. Top duplicate groups
  console.log('7. TOP 15 DUPLICATE GROUPS');
  console.log('-'.repeat(40));

  for (const [slug, artists] of duplicateGroups.slice(0, 15)) {
    const totalGroupEvents = artists.reduce((sum, a) => sum + (artistEventCounts[a.id] || 0), 0);
    console.log(`\n"${slug}" (${artists.length} artists, ${totalGroupEvents} events):`);
    for (const artist of artists) {
      const eventCount = artistEventCounts[artist.id] || 0;
      const loc = artist.location || 'no location';
      console.log(`  - ${artist.name} [${loc}] (${eventCount} events) ${artist.id.substring(0, 12)}...`);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('DIAGNOSTIC COMPLETE');
  console.log('='.repeat(80));

  return {
    totalArtists,
    withLocation: withLocation.length,
    withoutLocation: withoutLocation.length,
    withExternalIds: withExternalIds.length,
    artistsWithEvents,
    artistsWithoutEvents,
    totalEvents,
    duplicateGroups: duplicateGroups.length,
    extraDuplicates: totalDuplicateArtists,
    eventsAffected: totalEventsAffected
  };
}

runDiagnostic()
  .then(result => {
    console.log('\nSUMMARY JSON:');
    console.log(JSON.stringify(result, null, 2));
  })
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
