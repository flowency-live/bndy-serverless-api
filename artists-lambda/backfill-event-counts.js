/**
 * Backfill futureEventCount and pastEventCount for all artists
 * One-time migration script - run locally with AWS credentials
 *
 * Usage: node backfill-event-counts.js
 */

const AWS = require('aws-sdk');

AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const EVENTS_TABLE = 'bndy-events';
const ARTISTS_TABLE = 'bndy-artists';

async function backfillEventCounts() {
  console.log('Starting future/past eventCount backfill...');

  const today = new Date().toISOString().split('T')[0];
  console.log(`Today's date: ${today}`);

  // 1. Count events per artist from events table, split by future/past
  const artistFutureCounts = {};
  const artistPastCounts = {};
  let lastKey = null;
  let scannedEvents = 0;

  console.log('Scanning events table...');

  do {
    const params = {
      TableName: EVENTS_TABLE,
      ProjectionExpression: 'artistId, collaboratingArtistIds, isPublic, #type, #date',
      ExpressionAttributeNames: { '#type': 'type', '#date': 'date' }
    };
    if (lastKey) params.ExclusiveStartKey = lastKey;

    const result = await dynamodb.scan(params).promise();

    for (const event of result.Items) {
      // Only count public gigs
      if (!event.isPublic) continue;
      if (event.type !== 'gig' && event.type !== 'public_gig') continue;

      scannedEvents++;

      const isFuture = event.date >= today;
      const targetCounts = isFuture ? artistFutureCounts : artistPastCounts;

      // Count primary artist
      if (event.artistId) {
        targetCounts[event.artistId] = (targetCounts[event.artistId] || 0) + 1;
      }
      // Count collaborating artists
      if (event.collaboratingArtistIds && Array.isArray(event.collaboratingArtistIds)) {
        for (const collabId of event.collaboratingArtistIds) {
          if (collabId) {
            targetCounts[collabId] = (targetCounts[collabId] || 0) + 1;
          }
        }
      }
    }

    lastKey = result.LastEvaluatedKey;
    process.stdout.write(`\rScanned ${scannedEvents} public gig events...`);
  } while (lastKey);

  // Collect all unique artist IDs
  const allArtistIds = new Set([
    ...Object.keys(artistFutureCounts),
    ...Object.keys(artistPastCounts)
  ]);

  console.log(`\nFound ${allArtistIds.size} artists with events`);

  // 2. Update each artist with their counts
  let updated = 0;
  let skipped = 0;
  const artistIds = Array.from(allArtistIds);

  console.log('Updating artist records...');

  for (const artistId of artistIds) {
    const futureCount = artistFutureCounts[artistId] || 0;
    const pastCount = artistPastCounts[artistId] || 0;
    try {
      await dynamodb.update({
        TableName: ARTISTS_TABLE,
        Key: { id: artistId },
        UpdateExpression: 'SET futureEventCount = :future, pastEventCount = :past',
        ExpressionAttributeValues: { ':future': futureCount, ':past': pastCount },
        ConditionExpression: 'attribute_exists(id)'
      }).promise();
      updated++;
      if (updated % 100 === 0) {
        process.stdout.write(`\rUpdated ${updated}/${artistIds.length} artists...`);
      }
    } catch (error) {
      if (error.code === 'ConditionalCheckFailedException') {
        skipped++;
      } else {
        console.error(`\nFailed ${artistId}:`, error.message);
      }
    }
  }

  console.log(`\n\nBackfill complete:`);
  console.log(`  Events scanned: ${scannedEvents}`);
  console.log(`  Artists updated: ${updated}`);
  console.log(`  Artists skipped (not found): ${skipped}`);
}

backfillEventCounts().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
