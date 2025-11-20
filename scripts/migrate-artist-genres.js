// Migration Script: Simplify Artist Genres
// Consolidates 41 nested genres to 23 flat genres
// Created: 2025-11-08

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

const ARTISTS_TABLE = 'bndy-artists';

// Genre mapping from old nested structure to new flat structure
const GENRE_MAPPING = {
  // Rock family
  'Rock': 'Rock',
  'Hard Rock': 'Rock',
  'Classic Rock': 'Rock',
  'Progressive Rock': 'Rock',
  'Psychedelic Rock': 'Rock',
  'Garage Rock': 'Rock',
  'Stoner Rock': 'Rock',
  'Soft Rock': 'Rock',
  'Rock n Roll': 'Rock n Roll',

  // Metal (keep as is)
  'Metal': 'Metal',

  // Grunge (keep as is)
  'Grunge': 'Grunge',

  // Punk family
  'Punk': 'Punk',
  'Post-Punk': 'Punk',
  'Ska Punk': 'Punk',
  'Pop Punk': 'Punk',

  // Alternative (new category)
  'Alternative': 'Alternative',
  'Indie Rock': 'Alternative',

  // Pop family
  'Pop': 'Pop',
  'Synth-Pop': 'Pop',
  'Dream Pop': 'Pop',
  'Electropop': 'Pop',

  // Indie (keep as is)
  'Indie': 'Indie',

  // Britpop (keep as is)
  'Britpop': 'Britpop',

  // Blues (keep as is)
  'Blues': 'Blues',

  // R&B (keep as is)
  'R&B': 'R&B',
  'Soul': 'Soul',

  // Country (keep as is)
  'Country': 'Country',

  // Folk (keep as is)
  'Folk': 'Folk',

  // Funk (keep as is)
  'Funk': 'Funk',

  // Motown (keep as is)
  'Motown': 'Motown',

  // Electronic family
  'Electronic': 'Electronic',
  'Synthwave': 'Electronic',
  'Ambient': 'Electronic',
  'Industrial': 'Electronic',

  // Dance (keep as is)
  'Dance': 'Dance',
  'House': 'Dance',
  'Techno': 'Dance',

  // Jazz (keep as is)
  'Jazz': 'Jazz',

  // Classical (keep as is)
  'Classical': 'Classical',

  // Reggae (keep as is)
  'Reggae': 'Reggae',

  // Latin (keep as is)
  'Latin': 'Latin',

  // Other
  'Other': 'Other'
};

// New genre list (for validation)
const VALID_GENRES = [
  'Rock', 'Rock n Roll', 'Grunge', 'Metal', 'Punk', 'Alternative',
  'Pop', 'Indie', 'Britpop',
  'Blues', 'R&B', 'Country',
  'Folk', 'Soul', 'Funk', 'Motown',
  'Electronic', 'Dance',
  'Jazz', 'Classical', 'Reggae', 'Latin',
  'Other'
];

// Configuration
const TEST_MODE = process.env.TEST_MODE === 'true';
const BATCH_SIZE = 25; // DynamoDB BatchWrite limit

/**
 * Map old genres to new flat structure
 */
function mapGenres(oldGenres) {
  if (!Array.isArray(oldGenres) || oldGenres.length === 0) {
    return [];
  }

  const mappedGenres = new Set();

  for (const genre of oldGenres) {
    const mapped = GENRE_MAPPING[genre];
    if (mapped) {
      mappedGenres.add(mapped);
    } else if (VALID_GENRES.includes(genre)) {
      // Genre is already in new format
      mappedGenres.add(genre);
    } else {
      console.log(`  WARNING: Unknown genre "${genre}" - mapping to Other`);
      mappedGenres.add('Other');
    }
  }

  return Array.from(mappedGenres).sort();
}

/**
 * Scan all artists from DynamoDB
 */
async function scanAllArtists() {
  console.log('Scanning all artists from DynamoDB...');

  const artists = [];
  let lastEvaluatedKey = null;

  do {
    const params = {
      TableName: ARTISTS_TABLE,
      ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey })
    };

    const result = await dynamodb.scan(params).promise();
    artists.push(...result.Items);
    lastEvaluatedKey = result.LastEvaluatedKey;

    console.log(`  Scanned ${artists.length} artists so far...`);
  } while (lastEvaluatedKey);

  console.log(`Total artists found: ${artists.length}\n`);
  return artists;
}

/**
 * Analyze genre migration impact
 */
function analyzeGenreMigration(artists) {
  console.log('=== GENRE MIGRATION ANALYSIS ===\n');

  const stats = {
    totalArtists: artists.length,
    artistsWithGenres: 0,
    artistsWithoutGenres: 0,
    genresChanged: 0,
    genresUnchanged: 0,
    uniqueOldGenres: new Set(),
    uniqueNewGenres: new Set(),
    updates: []
  };

  for (const artist of artists) {
    if (!artist.genres || artist.genres.length === 0) {
      stats.artistsWithoutGenres++;
      continue;
    }

    stats.artistsWithGenres++;

    // Track old genres
    artist.genres.forEach(g => stats.uniqueOldGenres.add(g));

    // Map to new genres
    const newGenres = mapGenres(artist.genres);

    // Track new genres
    newGenres.forEach(g => stats.uniqueNewGenres.add(g));

    // Check if changed
    const oldSorted = [...artist.genres].sort().join(',');
    const newSorted = newGenres.join(',');

    if (oldSorted !== newSorted) {
      stats.genresChanged++;
      stats.updates.push({
        id: artist.id,
        name: artist.name,
        oldGenres: artist.genres,
        newGenres: newGenres
      });
    } else {
      stats.genresUnchanged++;
    }
  }

  console.log(`Total Artists: ${stats.totalArtists}`);
  console.log(`Artists with genres: ${stats.artistsWithGenres}`);
  console.log(`Artists without genres: ${stats.artistsWithoutGenres}`);
  console.log(`Artists requiring genre update: ${stats.genresChanged}`);
  console.log(`Artists with no change: ${stats.genresUnchanged}`);
  console.log(`\nUnique old genres: ${stats.uniqueOldGenres.size}`);
  console.log(`Unique new genres: ${stats.uniqueNewGenres.size}`);

  console.log(`\nOld genres found:`);
  console.log(Array.from(stats.uniqueOldGenres).sort().join(', '));

  console.log(`\nNew genres after mapping:`);
  console.log(Array.from(stats.uniqueNewGenres).sort().join(', '));

  if (stats.updates.length > 0 && stats.updates.length <= 20) {
    console.log(`\n=== SAMPLE UPDATES (showing first 20) ===`);
    stats.updates.slice(0, 20).forEach(update => {
      console.log(`\n${update.name} (${update.id})`);
      console.log(`  OLD: ${update.oldGenres.join(', ')}`);
      console.log(`  NEW: ${update.newGenres.join(', ')}`);
    });
  }

  return stats;
}

/**
 * Update artists in batches
 */
async function updateArtists(updates) {
  console.log(`\n=== UPDATING ${updates.length} ARTISTS ===\n`);

  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < updates.length; i++) {
    const update = updates[i];

    try {
      await dynamodb.update({
        TableName: ARTISTS_TABLE,
        Key: { id: update.id },
        UpdateExpression: 'SET genres = :genres, updated_at = :updated_at',
        ExpressionAttributeValues: {
          ':genres': update.newGenres,
          ':updated_at': new Date().toISOString()
        }
      }).promise();

      successCount++;

      if ((i + 1) % 10 === 0) {
        console.log(`  Updated ${i + 1}/${updates.length} artists...`);
      }
    } catch (error) {
      errorCount++;
      console.error(`  ERROR updating ${update.name} (${update.id}):`, error.message);
    }
  }

  console.log(`\n=== UPDATE COMPLETE ===`);
  console.log(`Successfully updated: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
}

/**
 * Main execution
 */
async function main() {
  console.log('=================================================');
  console.log('  BNDY Artist Genre Migration Script');
  console.log('  Simplifying 41 nested genres to 23 flat genres');
  console.log('=================================================\n');

  if (TEST_MODE) {
    console.log('*** RUNNING IN TEST MODE - NO UPDATES WILL BE MADE ***\n');
  }

  try {
    // Step 1: Scan all artists
    const artists = await scanAllArtists();

    // Step 2: Analyze migration
    const stats = analyzeGenreMigration(artists);

    // Step 3: Execute updates
    if (!TEST_MODE) {
      if (stats.updates.length === 0) {
        console.log('\nNo updates needed. All artists already have correct genres.');
        return;
      }

      console.log(`\nReady to update ${stats.updates.length} artists.`);
      console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...\n');

      await new Promise(resolve => setTimeout(resolve, 5000));

      await updateArtists(stats.updates);
    } else {
      console.log('\n*** TEST MODE - No updates performed ***');
      console.log(`Would have updated ${stats.updates.length} artists`);
    }

    console.log('\n=== MIGRATION COMPLETE ===\n');

  } catch (error) {
    console.error('FATAL ERROR:', error);
    process.exit(1);
  }
}

// Execute
main();
