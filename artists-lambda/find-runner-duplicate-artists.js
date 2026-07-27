// Find potential duplicate artists created by the source runner
// Look for article variants: "The X" vs "X", "X Band" vs "X"

const AWS = require('aws-sdk');

AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const LEADING_ARTICLES = ['the ', 'a ', 'an '];
const TRAILING_SUFFIXES = [' band', ' duo', ' trio', ' live', ' acoustic', ' show', ' experience', ' collective'];

function artistSlugNormalise(raw) {
  let name = (raw || '').toLowerCase();
  // Strip leading article
  for (const article of LEADING_ARTICLES) {
    if (name.startsWith(article)) {
      name = name.substring(article.length);
      break;
    }
  }
  // Strip trailing suffix
  for (const suffix of TRAILING_SUFFIXES) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }
  return name.replace(/[''‚‛'`]/g, '').replace(/[^a-z0-9]+/g, '');
}

async function findDuplicateArtists() {
  console.log('Scanning all artists to find potential duplicates...\n');

  const allArtists = [];
  let lastEvaluatedKey = null;

  do {
    const params = {
      TableName: 'bndy-artists',
      ProjectionExpression: 'id, #name, createdAt, externalIds',
      ExpressionAttributeNames: { '#name': 'name' }
    };

    if (lastEvaluatedKey) {
      params.ExclusiveStartKey = lastEvaluatedKey;
    }

    const result = await dynamodb.scan(params).promise();
    allArtists.push(...result.Items);
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(`Total artists scanned: ${allArtists.length}\n`);

  // Group by normalized name
  const normalizedGroups = {};

  for (const artist of allArtists) {
    const slug = artistSlugNormalise(artist.name);
    if (!normalizedGroups[slug]) {
      normalizedGroups[slug] = [];
    }
    normalizedGroups[slug].push(artist);
  }

  // Find groups with duplicates
  const duplicates = Object.entries(normalizedGroups)
    .filter(([slug, artists]) => artists.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  console.log(`Found ${duplicates.length} groups with potential duplicates:\n`);
  console.log('=' .repeat(80));

  const toDelete = [];

  for (const [slug, artists] of duplicates) {
    console.log(`\nNORMALIZED: "${slug}"`);
    console.log('-'.repeat(40));

    // Sort by createdAt to keep oldest
    const sorted = artists.sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt) : new Date(0);
      const dateB = b.createdAt ? new Date(b.createdAt) : new Date(0);
      return dateA - dateB;
    });

    const [keep, ...remove] = sorted;

    console.log(`KEEP: ${keep.id}`);
    console.log(`  Name: ${keep.name}`);
    console.log(`  Created: ${keep.createdAt || 'unknown'}`);
    console.log(`  External IDs: ${JSON.stringify(keep.externalIds || [])}`);

    for (const artist of remove) {
      console.log(`DELETE: ${artist.id}`);
      console.log(`  Name: ${artist.name}`);
      console.log(`  Created: ${artist.createdAt || 'unknown'}`);
      console.log(`  External IDs: ${JSON.stringify(artist.externalIds || [])}`);
      toDelete.push(artist);
    }
  }

  console.log('\n' + '=' .repeat(80));
  console.log(`\nTotal artists to delete: ${toDelete.length}`);

  if (toDelete.length > 0) {
    console.log('\nArtist IDs to delete:');
    for (const artist of toDelete) {
      console.log(`  ${artist.id} - "${artist.name}"`);
    }
  }

  return toDelete;
}

async function deleteArtists(artists) {
  if (artists.length === 0) {
    console.log('No artists to delete.');
    return { deleted: 0, failed: 0 };
  }

  console.log(`\nDeleting ${artists.length} duplicate artists...\n`);

  let deleted = 0;
  let failed = 0;

  for (const artist of artists) {
    try {
      await dynamodb.delete({
        TableName: 'bndy-artists',
        Key: { id: artist.id }
      }).promise();

      console.log(`✓ Deleted: ${artist.id} ("${artist.name}")`);
      deleted++;
    } catch (error) {
      console.error(`✗ Failed to delete ${artist.id}:`, error.message);
      failed++;
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Deleted: ${deleted}`);
  console.log(`Failed: ${failed}`);
  console.log(`${'='.repeat(50)}`);

  return { deleted, failed };
}

async function main() {
  const toDelete = await findDuplicateArtists();

  if (toDelete.length === 0) {
    console.log('\nNo duplicate artists found. Clean!');
    return;
  }

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.question(`\nDelete these ${toDelete.length} duplicate artists? (yes/no): `, async (answer) => {
    rl.close();

    if (answer.toLowerCase() === 'yes') {
      await deleteArtists(toDelete);
    } else {
      console.log('Aborted.');
    }

    process.exit(0);
  });
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
