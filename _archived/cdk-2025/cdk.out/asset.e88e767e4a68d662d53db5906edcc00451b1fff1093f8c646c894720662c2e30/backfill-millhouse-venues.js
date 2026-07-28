// Backfill venue relationships for Millhouse's 12 events
// This creates the missing artist-venue relationships after fixing the GSI bug

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const crypto = require('crypto');

const ARTIST_VENUES_TABLE = 'bndy-artist-venues';
const ARTIST_ID = '7be3d037-1960-4178-a7ad-ff98295f430e'; // Millhouse

// Event data from DynamoDB query (venue + date pairs)
const events = [
  { venueId: 'HC0NaN9oXbcIjpgx60gs', date: '2025-11-15', venueName: 'Murphys Pub & Kitchen' },
  { venueId: 'Xiaxlq2K0keBgk6TU4E5', date: '2025-11-29', venueName: 'Prince Of Wales' },
  { venueId: '8rwZ9VhoUZpOIoReKrPD', date: '2025-12-06', venueName: 'The Bowling Green' },
  { venueId: 'v4jqKHfh9OhVxJNpxNBl', date: '2025-12-13', venueName: 'Plough and Harrow' },
  { venueId: 'VWF24bEh2eBSrOb3hG0e', date: '2025-12-20', venueName: 'The Horseshoe' },
  { venueId: 'T7O1JaLn2uxZAHj8Ov85', date: '2026-01-11', venueName: 'Albert Halls' },
  { venueId: 'fNuSFPYHjSvbmvGHOKTi', date: '2026-02-01', venueName: 'The Beer Engine' },
  { venueId: '8rwZ9VhoUZpOIoReKrPD', date: '2026-02-08', venueName: 'The Bowling Green' }, // Duplicate venue, earlier gig
  { venueId: 'VWF24bEh2eBSrOb3hG0e', date: '2026-02-15', venueName: 'The Horseshoe' }, // Duplicate venue, earlier gig
  { venueId: '9hREGl3l2zvHRDd8rKe5', date: '2026-03-07', venueName: 'The Wellington' },
  { venueId: 'rxXmgcfk5U6kCCLGr8yq', date: '2026-03-14', venueName: 'The Bank Bar & Kitchen' },
  { venueId: 'T7O1JaLn2uxZAHj8Ov85', date: '2026-04-19', venueName: 'Albert Halls' } // Duplicate venue, earlier gig
];

async function ensureVenueRelationship(artistId, venueId, gigDate, venueName) {
  try {
    console.log(`Checking relationship: ${artistId} + ${venueId} (${venueName})`);

    // Check if relationship already exists using correct GSI
    const existingRelationship = await dynamodb.query({
      TableName: ARTIST_VENUES_TABLE,
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      FilterExpression: 'venue_id = :venueId',
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':venueId': venueId
      }
    }).promise();

    if (existingRelationship.Items && existingRelationship.Items.length > 0) {
      console.log(`  ✓ Relationship already exists`);

      // Update first_gig_date if this gig is earlier
      const relationship = existingRelationship.Items[0];
      if (!relationship.first_gig_date || gigDate < relationship.first_gig_date) {
        await dynamodb.update({
          TableName: ARTIST_VENUES_TABLE,
          Key: { id: relationship.id },
          UpdateExpression: 'SET first_gig_date = :date, updated_at = :now',
          ExpressionAttributeValues: {
            ':date': gigDate,
            ':now': new Date().toISOString()
          }
        }).promise();
        console.log(`  ✓ Updated first_gig_date to ${gigDate}`);
      }

      return;
    }

    // Create new artist-venue relationship
    const relationshipId = crypto.randomUUID();
    const now = new Date().toISOString();

    const newRelationship = {
      id: relationshipId,
      artist_id: artistId,
      venue_id: venueId,
      first_gig_date: gigDate,
      managed_on_bndy: false,
      created_at: now,
      updated_at: now
    };

    await dynamodb.put({
      TableName: ARTIST_VENUES_TABLE,
      Item: newRelationship
    }).promise();

    console.log(`  ✓ Created new relationship: ${relationshipId} (first gig: ${gigDate})`);
  } catch (error) {
    console.error(`  ✗ Failed:`, error.message);
  }
}

async function backfillVenues() {
  console.log(`\nBackfilling venue relationships for Millhouse (${ARTIST_ID})\n`);
  console.log(`Processing ${events.length} events...\n`);

  for (const event of events) {
    await ensureVenueRelationship(ARTIST_ID, event.venueId, event.date, event.venueName);
  }

  console.log(`\nDone! Check bndy-artist-venues table for artist_id = ${ARTIST_ID}`);
}

backfillVenues().catch(console.error);
