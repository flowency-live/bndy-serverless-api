/**
 * Calendar Cancellation Tracking Module
 *
 * Tracks deleted events for RFC 5545 METHOD:CANCEL support in iCal feeds.
 * Records auto-expire after 7 days via DynamoDB TTL.
 *
 * This allows calendar apps that sync within 7 days to properly remove
 * cancelled events from users' personal calendars.
 */

const AWS = require('aws-sdk');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

const CANCELLATIONS_TABLE = 'bndy-calendar-cancellations';

// TTL: 7 days in seconds
const TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Generate the iCal UID for an event.
 * Must match the UID used in the iCal feed.
 *
 * @param {string} eventId - Event ID
 * @returns {string} - UID in format eventId@bndy.co.uk
 */
function generateEventUid(eventId) {
  return `${eventId}@bndy.co.uk`;
}

/**
 * Create a cancellation record for a deleted event.
 * Called when an event is hard-deleted from the events table.
 *
 * @param {Object} event - The event being deleted (full event object)
 * @param {string} userId - ID of user who deleted the event
 * @returns {Promise<void>}
 */
async function createCancellationRecord(event, userId) {
  const now = new Date().toISOString();
  const ttlEpoch = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  const cancellationRecord = {
    eventUid: generateEventUid(event.id),
    artistId: event.artistId || event.ownerUserId, // Handle both artist and user events
    eventId: event.id,
    eventTitle: event.title || 'Event',
    eventDate: event.date,
    canceledAt: now,
    canceledBy: userId,
    ttl: ttlEpoch // DynamoDB TTL - auto-delete after 7 days
  };

  await dynamodb.put({
    TableName: CANCELLATIONS_TABLE,
    Item: cancellationRecord
  }).promise();
}

/**
 * Get all cancellation records for an artist.
 * Used when generating iCal feeds to include METHOD:CANCEL events.
 *
 * @param {string} artistId - Artist ID
 * @returns {Promise<Array>} - Array of cancellation records
 */
async function getCancellationsForArtist(artistId) {
  const result = await dynamodb.query({
    TableName: CANCELLATIONS_TABLE,
    IndexName: 'artistId-index',
    KeyConditionExpression: 'artistId = :artistId',
    ExpressionAttributeValues: {
      ':artistId': artistId
    }
  }).promise();

  return result.Items || [];
}

module.exports = {
  generateEventUid,
  createCancellationRecord,
  getCancellationsForArtist
};
