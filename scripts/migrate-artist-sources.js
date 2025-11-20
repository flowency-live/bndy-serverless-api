// Migration script: Set source and needs_review fields for existing artists
const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

async function migrateArtists() {
  console.log('Starting artist source migration...\n');

  // Scan all artists
  const result = await dynamodb.scan({
    TableName: 'bndy-artists'
  }).promise();

  console.log(`Found ${result.Items.length} total artists\n`);

  let backstageCount = 0;
  let frontstageCount = 0;
  let skippedCount = 0;

  for (const artist of result.Items) {
    // Skip if source already set
    if (artist.source) {
      skippedCount++;
      console.log(`SKIP: ${artist.name} (source already set: ${artist.source})`);
      continue;
    }

    const hasOwner = !!artist.owner_user_id;
    const source = hasOwner ? 'backstage' : 'frontstage';
    const needs_review = !hasOwner; // Backstage = clean, Frontstage = needs review

    try {
      await dynamodb.update({
        TableName: 'bndy-artists',
        Key: { id: artist.id },
        UpdateExpression: 'SET #source = :source, needs_review = :needs_review',
        ExpressionAttributeNames: {
          '#source': 'source'
        },
        ExpressionAttributeValues: {
          ':source': source,
          ':needs_review': needs_review
        }
      }).promise();

      if (hasOwner) {
        backstageCount++;
        console.log(`BACKSTAGE: ${artist.name} (owner: ${artist.owner_user_id})`);
      } else {
        frontstageCount++;
        console.log(`FRONTSTAGE: ${artist.name}`);
      }
    } catch (error) {
      console.error(`ERROR: Failed to update ${artist.name}:`, error.message);
    }
  }

  console.log(`\n=== MIGRATION COMPLETE ===`);
  console.log(`Backstage artists updated: ${backstageCount}`);
  console.log(`Frontstage artists updated: ${frontstageCount}`);
  console.log(`Skipped (already migrated): ${skippedCount}`);
  console.log(`Total processed: ${result.Items.length}`);
}

migrateArtists().catch(console.error);
