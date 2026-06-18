/**
 * Geohash Utilities for Location Management
 *
 * Handles geohash computation and cascading venue location updates to events.
 */

const ngeohash = require('ngeohash');

/**
 * Compute geohash fields from venue location
 * @param {Object} venue - Venue with latitude/longitude
 * @returns {Object} Geohash fields {geohash6, geohash4, geoLat, geoLng}
 */
function computeGeohashFields(venue) {
  if (!venue || !venue.latitude || !venue.longitude) {
    return {
      geohash6: null,
      geohash4: null,
      geoLat: null,
      geoLng: null
    };
  }

  return {
    geohash6: ngeohash.encode(venue.latitude, venue.longitude, 6),
    geohash4: ngeohash.encode(venue.latitude, venue.longitude, 4),
    geoLat: venue.latitude,
    geoLng: venue.longitude
  };
}

/**
 * Cascade venue location changes to all events at that venue
 * @param {Object} dynamodb - DynamoDB DocumentClient instance
 * @param {string} venueId - Venue ID to cascade from
 * @param {number} newLatitude - New latitude
 * @param {number} newLongitude - New longitude
 * @returns {Promise<{updated: number, skipped: number, error?: string}>}
 */
async function cascadeLocationToEvents(dynamodb, venueId, newLatitude, newLongitude) {
  console.log(`[Venues] Cascading location update to events for venue: ${venueId}`);

  try {
    // Query all events for this venue using the GSI
    const eventsResult = await dynamodb.query({
      TableName: 'bndy-events',
      IndexName: 'venueId-date-index',
      KeyConditionExpression: 'venueId = :venueId',
      ExpressionAttributeValues: {
        ':venueId': venueId
      }
    }).promise();

    const events = eventsResult.Items || [];
    console.log(`[Venues] Found ${events.length} event(s) to update`);

    if (events.length === 0) {
      return { updated: 0, skipped: 0 };
    }

    // Compute new geohash fields
    const geohashFields = computeGeohashFields({ latitude: newLatitude, longitude: newLongitude });
    const now = new Date().toISOString();

    let updated = 0;
    let skipped = 0;

    for (const event of events) {
      // Skip if already has correct coordinates
      if (event.geoLat === geohashFields.geoLat && event.geoLng === geohashFields.geoLng) {
        skipped++;
        continue;
      }

      try {
        await dynamodb.update({
          TableName: 'bndy-events',
          Key: { id: event.id },
          UpdateExpression: 'SET geoLat = :lat, geoLng = :lng, geohash6 = :gh6, geohash4 = :gh4, updatedAt = :now',
          ExpressionAttributeValues: {
            ':lat': geohashFields.geoLat,
            ':lng': geohashFields.geoLng,
            ':gh6': geohashFields.geohash6,
            ':gh4': geohashFields.geohash4,
            ':now': now
          }
        }).promise();
        updated++;
        console.log(`[Venues] Updated event ${event.id} with new location`);
      } catch (updateError) {
        console.error(`[Venues] Failed to update event ${event.id}:`, updateError.message);
      }
    }

    console.log(`[Venues] Cascade complete: ${updated} updated, ${skipped} skipped`);
    return { updated, skipped };
  } catch (error) {
    console.error('[Venues] Failed to cascade location to events:', error);
    // Don't throw - venue update should still succeed even if cascade fails
    return { updated: 0, skipped: 0, error: error.message };
  }
}

module.exports = {
  computeGeohashFields,
  cascadeLocationToEvents
};
