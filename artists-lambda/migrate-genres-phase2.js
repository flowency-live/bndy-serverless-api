/**
 * Phase 2: Genre Data Cleanup Migration
 *
 * Migrates 992 artists in production:
 * - 2a: Case normalisation (rock -> Rock) - skips owner-managed records
 * - 2b: Field leakage (covers/tribute -> actType, acoustic -> boolean)
 * - 2c: Sub-genre mapping (Classic Rock -> Rock)
 *
 * Usage:
 *   DRY RUN (default): node migrate-genres-phase2.js
 *   LIVE:              node migrate-genres-phase2.js --live
 *
 * Region: eu-west-2
 * Table:  bndy-artists
 */

'use strict';

const AWS = require('aws-sdk');
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const { normaliseGenre, normaliseGenres, GENRES } = require('./lib/genres');

const ARTISTS_TABLE = 'bndy-artists';
const DRY_RUN = !process.argv.includes('--live');

// Field leakage: genres that should be moved to other fields
const FIELD_LEAKAGE = {
  covers: { field: 'actType', value: 'covers' },
  Covers: { field: 'actType', value: 'covers' },
  tribute: { field: 'actType', value: 'tribute' },
  Tribute: { field: 'actType', value: 'tribute' },
  acoustic: { field: 'acoustic', value: true },
  Acoustic: { field: 'acoustic', value: true },
};

// Statistics
const stats = {
  scanned: 0,
  skippedOwnerManaged: 0,
  skippedNoChanges: 0,
  updated: 0,
  failed: 0,
  caseNormalised: 0,
  fieldLeakageFixed: 0,
  subgenreMapped: 0,
  invalidGenresRemoved: 0,
};

// Detailed change log for reporting
const changeLog = [];

/**
 * Process a single artist record
 */
function processArtist(artist) {
  const changes = {
    id: artist.id,
    name: artist.name,
    hasChanges: false,
    details: [],
    updates: {},
  };

  const currentGenres = Array.isArray(artist.genres) ? [...artist.genres] : [];
  const newGenres = [];
  const seenGenres = new Set();

  // Track field leakage updates
  let newActType = Array.isArray(artist.actType) ? [...artist.actType] : [];
  let newAcoustic = artist.acoustic || false;

  // 2a/2b/2c: Process each genre
  for (const genre of currentGenres) {
    // Check field leakage first (2b)
    if (FIELD_LEAKAGE[genre]) {
      const leak = FIELD_LEAKAGE[genre];
      if (leak.field === 'actType') {
        if (!newActType.includes(leak.value)) {
          newActType.push(leak.value);
          changes.details.push(`Move "${genre}" -> actType: "${leak.value}"`);
          stats.fieldLeakageFixed++;
        }
      } else if (leak.field === 'acoustic') {
        if (!newAcoustic) {
          newAcoustic = true;
          changes.details.push(`Move "${genre}" -> acoustic: true`);
          stats.fieldLeakageFixed++;
        }
      }
      // Don't add to genres (it's being moved)
      continue;
    }

    // Normalise genre (handles 2a case + 2c sub-genre mapping)
    const normalised = normaliseGenre(genre);

    if (normalised === null) {
      // Invalid genre - remove it
      changes.details.push(`Remove invalid genre: "${genre}"`);
      stats.invalidGenresRemoved++;
      continue;
    }

    // Track if case was normalised (2a)
    if (normalised !== genre && normalised.toLowerCase() === genre.toLowerCase()) {
      stats.caseNormalised++;
      changes.details.push(`Case: "${genre}" -> "${normalised}"`);
    }
    // Track if sub-genre was mapped (2c)
    else if (normalised !== genre) {
      stats.subgenreMapped++;
      changes.details.push(`Map: "${genre}" -> "${normalised}"`);
    }

    // Dedupe
    if (!seenGenres.has(normalised)) {
      seenGenres.add(normalised);
      newGenres.push(normalised);
    }
  }

  // Determine if any changes needed
  const genresChanged = JSON.stringify(currentGenres) !== JSON.stringify(newGenres);
  const actTypeChanged = JSON.stringify(artist.actType || []) !== JSON.stringify(newActType);
  const acousticChanged = (artist.acoustic || false) !== newAcoustic;

  if (genresChanged) {
    changes.updates.genres = newGenres;
    changes.hasChanges = true;
  }
  if (actTypeChanged) {
    changes.updates.actType = newActType.length > 0 ? newActType : null;
    changes.hasChanges = true;
  }
  if (acousticChanged) {
    changes.updates.acoustic = newAcoustic;
    changes.hasChanges = true;
  }

  return changes;
}

/**
 * Apply updates to DynamoDB
 */
async function applyUpdates(artistId, updates) {
  const updateParts = [];
  const expressionValues = {};
  const expressionNames = {};

  if (updates.genres !== undefined) {
    updateParts.push('#genres = :genres');
    expressionValues[':genres'] = updates.genres;
    expressionNames['#genres'] = 'genres';
  }
  if (updates.actType !== undefined) {
    updateParts.push('actType = :actType');
    expressionValues[':actType'] = updates.actType;
  }
  if (updates.acoustic !== undefined) {
    updateParts.push('acoustic = :acoustic');
    expressionValues[':acoustic'] = updates.acoustic;
  }

  // Always update timestamp
  updateParts.push('updated_at = :now');
  expressionValues[':now'] = new Date().toISOString();

  await dynamodb.update({
    TableName: ARTISTS_TABLE,
    Key: { id: artistId },
    UpdateExpression: 'SET ' + updateParts.join(', '),
    ExpressionAttributeValues: expressionValues,
    ...(Object.keys(expressionNames).length > 0 && { ExpressionAttributeNames: expressionNames }),
  }).promise();
}

/**
 * Scan all artists with pagination
 */
async function scanAllArtists() {
  const artists = [];
  let lastKey = null;

  do {
    const params = {
      TableName: ARTISTS_TABLE,
      ProjectionExpression: 'id, #name, genres, actType, acoustic, owner_user_id',
      ExpressionAttributeNames: { '#name': 'name' },
    };

    if (lastKey) {
      params.ExclusiveStartKey = lastKey;
    }

    const result = await dynamodb.scan(params).promise();
    artists.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;

    console.log(`Scanned ${artists.length} artists...`);
  } while (lastKey);

  return artists;
}

/**
 * Main migration function
 */
async function migrate() {
  console.log('='.repeat(60));
  console.log('Phase 2: Genre Data Cleanup Migration');
  console.log('='.repeat(60));
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (applying changes)'}`);
  console.log(`Table: ${ARTISTS_TABLE}`);
  console.log(`Canonical genres: ${GENRES.length}`);
  console.log('='.repeat(60));
  console.log('');

  // Scan all artists
  console.log('Scanning artists...');
  const artists = await scanAllArtists();
  stats.scanned = artists.length;
  console.log(`Found ${artists.length} artists\n`);

  // Process each artist
  for (const artist of artists) {
    // 2a: Skip owner-managed records for case normalisation
    // But still apply field leakage fixes (2b) and sub-genre mapping (2c)
    const isOwnerManaged = !!artist.owner_user_id;

    if (isOwnerManaged) {
      stats.skippedOwnerManaged++;
      // Still check for field leakage on owner-managed records
      const changes = processArtist(artist);
      // Only apply field leakage changes (actType, acoustic), not genre changes
      if (changes.updates.actType !== undefined || changes.updates.acoustic !== undefined) {
        const limitedUpdates = {};
        if (changes.updates.actType !== undefined) limitedUpdates.actType = changes.updates.actType;
        if (changes.updates.acoustic !== undefined) limitedUpdates.acoustic = changes.updates.acoustic;

        if (Object.keys(limitedUpdates).length > 0) {
          changes.updates = limitedUpdates;
          changes.details = changes.details.filter(d => d.includes('actType') || d.includes('acoustic'));
          changeLog.push(changes);

          if (!DRY_RUN) {
            try {
              await applyUpdates(artist.id, limitedUpdates);
              stats.updated++;
            } catch (err) {
              stats.failed++;
              console.error(`FAILED: ${artist.id} (${artist.name}): ${err.message}`);
            }
          } else {
            stats.updated++;
          }
        }
      }
      continue;
    }

    const changes = processArtist(artist);

    if (!changes.hasChanges) {
      stats.skippedNoChanges++;
      continue;
    }

    changeLog.push(changes);

    if (!DRY_RUN) {
      try {
        await applyUpdates(artist.id, changes.updates);
        stats.updated++;
      } catch (err) {
        stats.failed++;
        console.error(`FAILED: ${artist.id} (${artist.name}): ${err.message}`);
      }
    } else {
      stats.updated++;
    }
  }

  // Print detailed change log (first 50 for brevity)
  console.log('\n' + '='.repeat(60));
  console.log('CHANGE LOG (showing first 50)');
  console.log('='.repeat(60));

  for (const change of changeLog.slice(0, 50)) {
    console.log(`\n[${change.id}] ${change.name}`);
    for (const detail of change.details) {
      console.log(`  - ${detail}`);
    }
  }

  if (changeLog.length > 50) {
    console.log(`\n... and ${changeLog.length - 50} more changes`);
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Scanned:               ${stats.scanned}`);
  console.log(`Owner-managed skipped: ${stats.skippedOwnerManaged}`);
  console.log(`No changes needed:     ${stats.skippedNoChanges}`);
  console.log(`${DRY_RUN ? 'Would update' : 'Updated'}:         ${stats.updated}`);
  if (!DRY_RUN) {
    console.log(`Failed:                ${stats.failed}`);
  }
  console.log('');
  console.log('Breakdown:');
  console.log(`  Case normalised:     ${stats.caseNormalised}`);
  console.log(`  Field leakage fixed: ${stats.fieldLeakageFixed}`);
  console.log(`  Sub-genres mapped:   ${stats.subgenreMapped}`);
  console.log(`  Invalid removed:     ${stats.invalidGenresRemoved}`);
  console.log('='.repeat(60));

  if (DRY_RUN) {
    console.log('\nThis was a DRY RUN. No changes were applied.');
    console.log('To apply changes, run: node migrate-genres-phase2.js --live');
  }
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
