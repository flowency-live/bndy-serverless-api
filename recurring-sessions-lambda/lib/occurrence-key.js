/**
 * Occurrence Key Generation
 *
 * Deterministic key for Series occurrences.
 * Format: {seriesId}:{scheduledLocalDate}
 *
 * This key is used for:
 * - Idempotent projection (same Series version → same keys)
 * - Linking Events to their Series occurrence
 * - Preventing duplicate occurrence creation
 */

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates an ISO date string (YYYY-MM-DD)
 * @param {string} dateStr
 * @returns {boolean}
 */
function isValidISODate(dateStr) {
  if (!ISO_DATE_REGEX.test(dateStr)) {
    return false;
  }

  const [year, month, day] = dateStr.split('-').map(Number);

  // Basic range checks
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  // Check if date is valid by parsing and comparing
  const date = new Date(dateStr);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

/**
 * Generates a deterministic occurrence key from seriesId and scheduledLocalDate.
 *
 * @param {string} seriesId - The recurring session ID
 * @param {string} scheduledLocalDate - ISO date string (YYYY-MM-DD)
 * @returns {string} Occurrence key in format "seriesId:YYYY-MM-DD"
 * @throws {Error} If inputs are missing or invalid
 */
function generateOccurrenceKey(seriesId, scheduledLocalDate) {
  if (!seriesId) {
    throw new Error('seriesId is required');
  }

  if (!scheduledLocalDate) {
    throw new Error('scheduledLocalDate is required');
  }

  if (!ISO_DATE_REGEX.test(scheduledLocalDate)) {
    throw new Error('invalid date format, expected YYYY-MM-DD');
  }

  if (!isValidISODate(scheduledLocalDate)) {
    throw new Error('invalid date format, expected YYYY-MM-DD');
  }

  return `${seriesId}:${scheduledLocalDate}`;
}

/**
 * Parses an occurrence key back into its components.
 *
 * @param {string} key - The occurrence key
 * @returns {{ seriesId: string, scheduledLocalDate: string } | null}
 */
function parseOccurrenceKey(key) {
  if (!key || typeof key !== 'string') {
    return null;
  }

  // Find the last colon followed by a date pattern
  const match = key.match(/^(.+):(\d{4}-\d{2}-\d{2})$/);

  if (!match) {
    return null;
  }

  return {
    seriesId: match[1],
    scheduledLocalDate: match[2]
  };
}

/**
 * Validates an occurrence key format.
 *
 * @param {string} key - The occurrence key to validate
 * @returns {string | null} Error message or null if valid
 */
function validateOccurrenceKey(key) {
  if (!key || typeof key !== 'string') {
    return 'occurrence key is required';
  }

  const parsed = parseOccurrenceKey(key);

  if (!parsed) {
    return 'invalid occurrence key format';
  }

  if (!isValidISODate(parsed.scheduledLocalDate)) {
    return 'invalid date in occurrence key';
  }

  return null;
}

module.exports = {
  generateOccurrenceKey,
  parseOccurrenceKey,
  validateOccurrenceKey
};
