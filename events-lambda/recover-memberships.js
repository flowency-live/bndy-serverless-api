/**
 * EMERGENCY RECOVERY SCRIPT
 *
 * Recovers artist ownership memberships from the owner_user_id field
 * in the bndy-artists table.
 *
 * This will NOT recover:
 * - Band members (non-owners)
 * - Member roles/permissions beyond "owner"
 *
 * Usage: node recover-memberships.js [--apply]
 */

const AWS = require('aws-sdk');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

const ARTISTS_TABLE = 'bndy-artists';
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';

async function scanAllArtistsWithOwner() {
  const artists = [];
  let lastKey = null;

  do {
    const params = {
      TableName: ARTISTS_TABLE,
      FilterExpression: 'attribute_exists(owner_user_id)',
      ExclusiveStartKey: lastKey
    };

    const result = await dynamodb.scan(params).promise();
    artists.push(...result.Items);
    lastKey = result.LastEvaluatedKey;
    console.log(`Scanned ${artists.length} artists with owners so far...`);
  } while (lastKey);

  return artists;
}

async function createMembership(artistId, userId, artistName) {
  const membershipId = crypto.randomUUID();
  const now = new Date().toISOString();

  const membership = {
    membership_id: membershipId,
    artist_id: artistId,
    user_id: userId,
    role: 'owner',
    status: 'active',
    artist_name: artistName,
    created_at: now,
    updated_at: now,
    recovered_from_owner_user_id: true // Flag to indicate this was recovered
  };

  await dynamodb.put({
    TableName: MEMBERSHIPS_TABLE,
    Item: membership,
    ConditionExpression: 'attribute_not_exists(membership_id)'
  }).promise();

  return membership;
}

async function checkExistingMembership(artistId, userId) {
  // Check if this artist already has a membership for this user
  const result = await dynamodb.query({
    TableName: MEMBERSHIPS_TABLE,
    IndexName: 'artist_id-index',
    KeyConditionExpression: 'artist_id = :artistId',
    FilterExpression: 'user_id = :userId',
    ExpressionAttributeValues: {
      ':artistId': artistId,
      ':userId': userId
    }
  }).promise();

  return result.Items && result.Items.length > 0;
}

async function main() {
  const dryRun = !process.argv.includes('--apply');

  console.log('=== MEMBERSHIP RECOVERY SCRIPT ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'APPLYING CHANGES'}\n`);

  // 1. Scan all artists with owner_user_id
  console.log('1. Scanning artists with owner_user_id...');
  const artists = await scanAllArtistsWithOwner();
  console.log(`   Found ${artists.length} artists with owners\n`);

  // 2. Process each artist
  console.log('2. Processing artists...');
  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const artist of artists) {
    const artistId = artist.id;
    const userId = artist.owner_user_id;
    const artistName = artist.name;

    if (!userId) {
      console.log(`   Skipping ${artistName}: no owner_user_id`);
      skipped++;
      continue;
    }

    try {
      // Check if membership already exists
      const exists = await checkExistingMembership(artistId, userId);
      if (exists) {
        console.log(`   Skipping ${artistName}: membership already exists`);
        skipped++;
        continue;
      }

      if (dryRun) {
        console.log(`   [DRY RUN] Would create membership: ${artistName} -> ${userId.substring(0, 8)}...`);
        created++;
      } else {
        await createMembership(artistId, userId, artistName);
        console.log(`   Created membership: ${artistName} -> ${userId.substring(0, 8)}...`);
        created++;
      }
    } catch (error) {
      console.error(`   ERROR processing ${artistName}: ${error.message}`);
      errors++;
    }
  }

  console.log('\n=== RECOVERY COMPLETE ===');
  console.log(`Created: ${created}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);

  if (dryRun) {
    console.log('\nThis was a DRY RUN. Run with --apply to create memberships.');
  }
}

main().catch(error => {
  console.error('Recovery failed:', error);
  process.exit(1);
});
