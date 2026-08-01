/**
 * Data Quality Validation
 *
 * Validates artist and event data to prevent:
 * - Multi-artist lineups (15 found in audit)
 * - "Cancelled" event indicators (4 found)
 * - Unsearchable names (2 found)
 *
 * Based on: DATA-QUALITY-PREVENTION-STRATEGY.md
 */

const MULTI_ARTIST_PATTERNS = [
  /\+\s*\d+\s*more/i,           // "+ 2 more", "+ 1 more"
  /\+.*\+/,                      // Multiple + signs
  /\sand\s.*\sand\s/i,           // "A and B and C"
  /,.*,/,                        // Multiple commas
  /\bvs?\.?\s/i,                 // "vs", "v ", "vs."
  /\bw\//i,                      // "w/"
  /\bfeaturing\b/i,              // "featuring"
  /\bft\.?\b/i,                  // "ft", "ft."
  /\bsupporting\b/i,             // "supporting"
  /\bsupport\s+from\b/i,         // "support from"
  /\bwith\s+special\s+guests?\b/i, // "with special guest(s)"
];

const CANCELLED_PATTERNS = [
  /^cancelled$/i,
  /^canceled$/i,  // US spelling
  /^tbc$/i,
  /^to be confirmed$/i,
  /^t\.b\.c\.?$/i,
  /^tba$/i,
  /^to be announced$/i,
  /^t\.b\.a\.?$/i,
];

/**
 * Check if artist name appears to be a multi-artist lineup
 */
function isMultiArtistLineup(name) {
  if (!name || typeof name !== 'string') return false;
  return MULTI_ARTIST_PATTERNS.some(pattern => pattern.test(name));
}

/**
 * Check if artist name is a cancellation indicator
 */
function isCancelledIndicator(name) {
  if (!name || typeof name !== 'string') return false;
  return CANCELLED_PATTERNS.some(pattern => pattern.test(name.trim()));
}

/**
 * Validate artist name is searchable (not excessive special characters)
 */
function validateArtistName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, reason: 'Name is required' };
  }

  // Check for all-symbol names
  if (/^[^a-zA-Z0-9]+$/.test(name)) {
    return {
      valid: false,
      reason: 'Name contains no alphanumeric characters',
      suggestion: 'Provide a searchable name'
    };
  }

  // Check for excessive non-ASCII characters (>30%)
  const asciiChars = name.replace(/[^a-zA-Z0-9\s\-'&]/g, '').length;
  const totalChars = name.length;
  const nonAsciiRatio = (totalChars - asciiChars) / totalChars;

  if (nonAsciiRatio > 0.3) {
    return {
      valid: false,
      reason: 'Name contains too many special characters (>30%)',
      suggestion: 'Use a searchable alias instead'
    };
  }

  return { valid: true };
}

/**
 * Comprehensive artist validation
 * Returns { valid: boolean, errors: string[] }
 */
function validateArtistData(artistData) {
  const errors = [];
  const { name } = artistData;

  if (!name) {
    return { valid: false, errors: ['Artist name is required'] };
  }

  // Check multi-artist lineup
  if (isMultiArtistLineup(name)) {
    errors.push(
      `multi_artist_lineup_detected: Artist name "${name}" appears to be a multi-artist lineup. ` +
      `Please split into individual artists.`
    );
  }

  // Check cancelled indicator
  if (isCancelledIndicator(name)) {
    errors.push(
      `cancelled_event_detected: Artist name "${name}" indicates an event cancellation, not a new artist. ` +
      `Mark the event as cancelled using the event status field instead.`
    );
  }

  // Check searchability
  const nameValidation = validateArtistName(name);
  if (!nameValidation.valid) {
    errors.push(
      `unsearchable_name: ${nameValidation.reason}. ${nameValidation.suggestion || ''}`
    );
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  isMultiArtistLineup,
  isCancelledIndicator,
  validateArtistName,
  validateArtistData,
};
