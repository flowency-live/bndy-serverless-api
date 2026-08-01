/**
 * Audit: List all invalid genres and their counts
 */
'use strict';

const AWS = require('aws-sdk');
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const { normaliseGenre, GENRES } = require('./lib/genres');

const FIELD_LEAKAGE = new Set(['covers', 'Covers', 'tribute', 'Tribute', 'acoustic', 'Acoustic']);

async function scanAllArtists() {
  const artists = [];
  let lastKey = null;

  do {
    const params = {
      TableName: 'bndy-artists',
      ProjectionExpression: 'id, #name, genres',
      ExpressionAttributeNames: { '#name': 'name' },
    };
    if (lastKey) params.ExclusiveStartKey = lastKey;

    const result = await dynamodb.scan(params).promise();
    artists.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return artists;
}

async function audit() {
  const artists = await scanAllArtists();
  console.log(`Scanned ${artists.length} artists\n`);

  const invalidCounts = new Map();
  const invalidArtists = new Map();

  for (const artist of artists) {
    const genres = Array.isArray(artist.genres) ? artist.genres : [];
    for (const genre of genres) {
      // Skip field leakage (those are intentional moves, not invalid)
      if (FIELD_LEAKAGE.has(genre)) continue;

      const normalised = normaliseGenre(genre);
      if (normalised === null) {
        invalidCounts.set(genre, (invalidCounts.get(genre) || 0) + 1);
        if (!invalidArtists.has(genre)) invalidArtists.set(genre, []);
        invalidArtists.get(genre).push(artist.name);
      }
    }
  }

  // Sort by count descending
  const sorted = [...invalidCounts.entries()].sort((a, b) => b[1] - a[1]);

  console.log('INVALID GENRES (not in canonical list, not field leakage)');
  console.log('='.repeat(60));
  console.log('');

  let total = 0;
  for (const [genre, count] of sorted) {
    total += count;
    const examples = invalidArtists.get(genre).slice(0, 3).join(', ');
    console.log(`${count.toString().padStart(3)} x "${genre}"`);
    console.log(`      Examples: ${examples}`);
  }

  console.log('');
  console.log('='.repeat(60));
  console.log(`Total invalid genre assignments: ${total}`);
  console.log(`Unique invalid genres: ${sorted.length}`);
  console.log('');
  console.log('Consider adding to canonical list if widely used.');
}

audit().catch(console.error);
