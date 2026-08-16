'use strict';

/**
 * Read-only production taxonomy inventory.
 *
 * Usage from an AWS-authenticated environment:
 *   node artists-lambda/audit-taxonomy-values.js
 *
 * Scans bndy-artists and prints distinct/count distributions for the fields
 * involved in the taxonomy migration. It performs ZERO writes.
 */

const AWS = require('aws-sdk');
const {
  GENRES,
  LEGACY_GENRES,
  ARTIST_TYPES,
  ACT_TYPES,
  normaliseArtistType,
  normaliseActTypes,
  normaliseGenre
} = require('./lib/taxonomy');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'eu-west-2' });
const TABLE = process.env.ARTISTS_TABLE || 'bndy-artists';

function bump(map, value) {
  const key = value === undefined ? '<missing>' : value === null ? '<null>' : String(value);
  map.set(key, (map.get(key) || 0) + 1);
}

function sorted(map) {
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

async function scanAll() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await dynamodb.scan({
      TableName: TABLE,
      ProjectionExpression: 'id, artist_type, actType, acoustic, genres',
      ExclusiveStartKey
    }).promise();
    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function main() {
  const artists = await scanAll();
  const artistTypes = new Map();
  const actTypes = new Map();
  const acoustic = new Map();
  const genres = new Map();

  const invalidArtistTypes = new Map();
  const invalidActTypes = new Map();
  const invalidGenres = new Map();
  const legacyGenres = new Map();
  let acousticInActType = 0;

  for (const artist of artists) {
    bump(artistTypes, artist.artist_type);
    bump(acoustic, artist.acoustic);

    const rawActs = Array.isArray(artist.actType)
      ? artist.actType
      : artist.actType == null
        ? []
        : [artist.actType];
    if (rawActs.length === 0) bump(actTypes, '<empty>');
    for (const raw of rawActs) {
      bump(actTypes, raw);
      if (typeof raw === 'string' && raw.trim().toLowerCase() === 'acoustic') acousticInActType++;
    }

    const rawGenres = Array.isArray(artist.genres) ? artist.genres : [];
    if (rawGenres.length === 0) bump(genres, '<empty>');
    for (const raw of rawGenres) bump(genres, raw);

    if (artist.artist_type !== undefined && artist.artist_type !== null && artist.artist_type !== '') {
      if (!normaliseArtistType(artist.artist_type)) bump(invalidArtistTypes, artist.artist_type);
    }

    const actResult = normaliseActTypes(rawActs);
    for (const raw of actResult.invalid) bump(invalidActTypes, raw);

    for (const raw of rawGenres) {
      const norm = normaliseGenre(raw);
      if (!norm) bump(invalidGenres, raw);
      else if (LEGACY_GENRES.includes(norm)) bump(legacyGenres, norm);
    }
  }

  const report = {
    table: TABLE,
    scannedArtists: artists.length,
    canonical: {
      artistTypes: ARTIST_TYPES,
      actTypes: ACT_TYPES,
      activeGenres: GENRES,
      legacyGenres: LEGACY_GENRES
    },
    distributions: {
      artistType: sorted(artistTypes),
      actType: sorted(actTypes),
      acoustic: sorted(acoustic),
      genres: sorted(genres)
    },
    migrationSignals: {
      invalidArtistTypes: sorted(invalidArtistTypes),
      invalidActTypes: sorted(invalidActTypes),
      invalidGenres: sorted(invalidGenres),
      legacyGenresInUse: sorted(legacyGenres),
      acousticStoredInsideActTypeCount: acousticInActType
    }
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error('Taxonomy audit failed:', error);
  process.exitCode = 1;
});
