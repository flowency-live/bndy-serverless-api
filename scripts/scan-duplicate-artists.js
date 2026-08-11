/**
 * Scan for duplicate artist names
 */
'use strict';

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

async function scanAllArtists() {
  const artists = [];
  let lastKey = null;
  do {
    const params = {
      TableName: 'bndy-artists',
      ProjectionExpression: 'id, #name, #location, genres, profileImageUrl, validated, ai_created, needs_review, owner_user_id, createdAt, #source',
      ExpressionAttributeNames: { '#name': 'name', '#location': 'location', '#source': 'source' },
      ExclusiveStartKey: lastKey,
    };
    const result = await dynamodb.scan(params).promise();
    artists.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return artists;
}

async function main() {
  console.log('Scanning artists...');
  const artists = await scanAllArtists();
  console.log(`Found ${artists.length} artists\n`);

  // Group by normalized name
  const byName = new Map();
  for (const artist of artists) {
    const key = (artist.name || '').toLowerCase().trim();
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(artist);
  }

  // Filter to duplicates
  const duplicates = [...byName.entries()]
    .filter(([_, group]) => group.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  console.log(`Duplicate groups: ${duplicates.length}\n`);

  for (const [name, group] of duplicates) {
    const hasOwner = group.some(a => a.owner_user_id);
    const locations = [...new Set(group.map(a => a.location || 'unknown'))];

    console.log(`\n"${group[0].name}" (${group.length} records)`);
    console.log(`  Locations: ${locations.join(' | ')}`);
    if (hasOwner) console.log('  ** HAS OWNER **');

    for (const a of group) {
      const flags = [];
      if (a.validated) flags.push('V');
      if (a.ai_created) flags.push('AI');
      if (a.owner_user_id) flags.push('OWNER');
      if (a.needs_review) flags.push('REV');
      const img = a.profileImageUrl ? 'img' : 'no-img';
      const genres = (a.genres || []).slice(0, 2).join(',') || '-';
      const date = a.createdAt ? a.createdAt.split('T')[0] : '?';
      console.log(`    ${a.id.substring(0,8)}  ${(a.location || '-').substring(0,25).padEnd(25)} [${flags.join(',').padEnd(8)}] ${img.padEnd(6)} ${date} ${genres}`);
    }
  }
}

main().catch(console.error);
