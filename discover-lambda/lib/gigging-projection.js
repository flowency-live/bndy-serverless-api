/**
 * Gigging projection logic for bndy-artists
 *
 * Computes derived fields that power the gigging-status GSI:
 * - giggingStatus: "Y" when artist has future public gigs, null (removed) otherwise
 * - giggingUntil: ISO date of the latest public, unhidden, future event
 */

/**
 * Compute gigging projection fields from a list of events.
 *
 * @param {Array} events - Events associated with the artist
 * @param {string} today - Today's date in ISO format (YYYY-MM-DD)
 * @returns {{ giggingStatus: string|null, giggingUntil: string|null }}
 */
function computeGiggingProjection(events, today) {
  if (!events || events.length === 0) {
    return { giggingStatus: null, giggingUntil: null };
  }

  const futurePublicEvents = events.filter((event) => {
    if (!event.date || event.date < today) return false;
    if (event.hidden === true) return false;
    const visibility = event.visibility || 'public';
    return visibility === 'public';
  });

  if (futurePublicEvents.length === 0) {
    return { giggingStatus: null, giggingUntil: null };
  }

  const sortedByDateDesc = futurePublicEvents.sort((a, b) => b.date.localeCompare(a.date));
  const giggingUntil = sortedByDateDesc[0].date;

  return {
    giggingStatus: 'Y',
    giggingUntil,
  };
}

/**
 * Extract all artist IDs from an event record.
 * Handles artistId, collaboratingArtistIds, and legacy artistIds fields.
 * Deduplicates and filters out null/undefined values.
 *
 * @param {Object} event - Event record
 * @returns {string[]} Unique artist IDs
 */
function extractArtistIds(event) {
  const ids = new Set();

  if (event.artistId) {
    ids.add(event.artistId);
  }

  if (Array.isArray(event.collaboratingArtistIds)) {
    event.collaboratingArtistIds.forEach((id) => {
      if (id) ids.add(id);
    });
  }

  if (Array.isArray(event.artistIds)) {
    event.artistIds.forEach((id) => {
      if (id) ids.add(id);
    });
  }

  return Array.from(ids);
}

/**
 * Determine if a write should be skipped because values haven't changed.
 * Used to avoid unnecessary DynamoDB writes during imports that rewrite identical events.
 *
 * @param {Object} current - Current artist projection fields
 * @param {Object} next - Next computed projection fields
 * @returns {boolean} True if write should be skipped
 */
function shouldSkipWrite(current, next) {
  const currentStatus = current.giggingStatus ?? null;
  const currentUntil = current.giggingUntil ?? null;
  const nextStatus = next.giggingStatus ?? null;
  const nextUntil = next.giggingUntil ?? null;

  return currentStatus === nextStatus && currentUntil === nextUntil;
}

module.exports = {
  computeGiggingProjection,
  extractArtistIds,
  shouldSkipWrite,
};
