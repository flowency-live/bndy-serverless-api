/**
 * Calendar Cancellations Module
 *
 * Tracks deleted events for iCal METHOD:CANCEL support.
 * TODO: Implement DynamoDB storage when bndy-calendar-cancellations table is created.
 */

/**
 * Create a cancellation record when an event is deleted.
 * This allows calendar apps to receive METHOD:CANCEL notifications.
 *
 * @param {Object} event - The event being deleted
 * @param {string} userId - The user who deleted the event
 */
async function createCancellationRecord(event, userId) {
  // TODO: Store in bndy-calendar-cancellations DynamoDB table
  // For now, this is a no-op to avoid breaking existing functionality
  console.log('Cancellation record would be created for event:', event.id || event.eventId);
}

/**
 * Get all cancellation records for an artist within the last 7 days.
 * Used when generating iCal feeds to include METHOD:CANCEL events.
 *
 * @param {string} artistId - The artist ID
 * @returns {Promise<Array>} Array of cancellation records
 */
async function getCancellationsForArtist(artistId) {
  // TODO: Query bndy-calendar-cancellations DynamoDB table
  // For now, return empty array to avoid breaking iCal feeds
  return [];
}

module.exports = {
  createCancellationRecord,
  getCancellationsForArtist
};
