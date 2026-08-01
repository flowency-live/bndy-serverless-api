/**
 * Backfill script: Add nameVariants to Danny Brab
 * Fix #3d (2026-07-29)
 *
 * Danny Brab (FIT600aoQ5lpNSejGctN) has known billing variations:
 * - "Danny & Friends"
 * - "Danny Brab & Friends"
 *
 * These must be added to nameVariants so future occurrences match automatically
 * instead of going to review.
 */

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

const DANNY_BRAB_ID = 'FIT600aoQ5lpNSejGctN';
const KNOWN_VARIANTS = [
  'Danny & Friends',
  'Danny Brab & Friends'
];

async function backfillDannyBrabVariants() {
  console.log('Backfilling nameVariants for Danny Brab...');
  console.log(`Artist ID: ${DANNY_BRAB_ID}`);
  console.log(`Variants to add: ${JSON.stringify(KNOWN_VARIANTS)}`);

  try {
    // Fetch current artist record
    const getResult = await dynamodb.get({
      TableName: 'bndy-artists',
      Key: { id: DANNY_BRAB_ID }
    }).promise();

    if (!getResult.Item) {
      console.error(`ERROR: Artist ${DANNY_BRAB_ID} not found`);
      process.exit(1);
    }

    const artist = getResult.Item;
    console.log(`Current artist: ${artist.name} (${artist.location})`);
    console.log(`Current nameVariants: ${JSON.stringify(artist.name_variants || [])}`);

    // Merge variants (additive)
    const existingVariants = artist.name_variants || [];
    const merged = [...new Set([...existingVariants, ...KNOWN_VARIANTS])];

    console.log(`Merged nameVariants: ${JSON.stringify(merged)}`);

    // Update artist record
    const updateResult = await dynamodb.update({
      TableName: 'bndy-artists',
      Key: { id: DANNY_BRAB_ID },
      UpdateExpression: 'SET name_variants = :variants, updated_at = :updated_at',
      ExpressionAttributeValues: {
        ':variants': merged,
        ':updated_at': new Date().toISOString()
      },
      ReturnValues: 'ALL_NEW'
    }).promise();

    console.log('\n✅ SUCCESS: Danny Brab nameVariants updated');
    console.log(`Final nameVariants: ${JSON.stringify(updateResult.Attributes.name_variants)}`);

    // Verification: Check resolver will now match these variants
    console.log('\n--- Verification ---');
    console.log('Expected behavior:');
    console.log('  - "Danny & Friends" → matches Danny Brab via nameVariants');
    console.log('  - "Danny Brab & Friends" → matches Danny Brab via nameVariants');
    console.log('  - matchedBy: "name_variant"');

  } catch (error) {
    console.error('ERROR:', error.message);
    process.exit(1);
  }
}

// Run backfill
backfillDannyBrabVariants();
