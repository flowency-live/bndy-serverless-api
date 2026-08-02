/**
 * Ticketing Resolution Logic
 *
 * Resolves ticketing information for an event by combining event-level
 * and venue-level ticketing data with proper precedence.
 *
 * Precedence (highest first):
 * 1. Event ticketed explicitly set (true OR false) → wins outright
 * 2. Event ticketed unset (null/undefined) → inherit venue.standardTicketed
 * 3. Neither set → isTicketed: false, source: 'none'
 *
 * Price, ticketUrl, ticketInformation resolve independently:
 * - Event value if present (non-empty string)
 * - Else venue standard value if present (non-empty string)
 * - Else key is OMITTED (never empty string)
 */

/**
 * Check if a value is explicitly set (not null, not undefined)
 * CRITICAL: false is a valid explicit value, do not treat as unset
 */
function isExplicitlySet(value) {
  return value !== null && value !== undefined;
}

/**
 * Check if a string value is present and non-empty
 */
function hasValue(str) {
  return typeof str === 'string' && str.trim() !== '';
}

/**
 * Resolve ticketing information for an event
 *
 * @param {Object|null} event - Event object (may have ticketed, price, ticketUrl, ticketInformation)
 * @param {Object|null} venue - Venue object (may have standardTicketed, standardPrice, standardTicketUrl, standardTicketInformation)
 * @returns {Object} Resolved ticketing object with isTicketed, source, and optional price/ticketUrl/ticketInformation
 */
function resolveTicketing(event, venue) {
  // Safely handle null/undefined inputs
  const e = event || {};
  const v = venue || {};

  // ─── RESOLVE TICKETED FLAG ──────────────────────────────────────────────────

  let isTicketed;
  let source;

  if (isExplicitlySet(e.ticketed)) {
    // Event has explicit ticketed value (true OR false) - event wins
    isTicketed = Boolean(e.ticketed);
    source = 'event';
  } else if (isExplicitlySet(v.standardTicketed)) {
    // Event unset, inherit from venue
    isTicketed = Boolean(v.standardTicketed);
    source = 'venue';
  } else {
    // Neither set
    isTicketed = false;
    source = 'none';
  }

  // ─── BUILD RESULT OBJECT ────────────────────────────────────────────────────

  const result = {
    isTicketed,
    source
  };

  // ─── RESOLVE PRICE ──────────────────────────────────────────────────────────
  // Event price wins if present, else venue standard, else omit key

  if (hasValue(e.price)) {
    result.price = e.price;
  } else if (hasValue(v.standardPrice)) {
    result.price = v.standardPrice;
  }
  // If neither has value, key is omitted (not empty string)

  // ─── RESOLVE TICKET URL ─────────────────────────────────────────────────────
  // Event ticketUrl wins if present, else venue standard, else omit key
  // NOTE: Empty string on event means "no URL for this event" - do NOT fall back

  if (hasValue(e.ticketUrl)) {
    result.ticketUrl = e.ticketUrl;
  } else if (e.ticketUrl !== '' && hasValue(v.standardTicketUrl)) {
    // Only inherit venue URL if event URL is not explicitly empty
    result.ticketUrl = v.standardTicketUrl;
  }
  // If neither has value, key is omitted

  // ─── RESOLVE TICKET INFORMATION ─────────────────────────────────────────────
  // Event ticketInformation wins if present, else venue standard, else omit key

  if (hasValue(e.ticketInformation)) {
    result.ticketInformation = e.ticketInformation;
  } else if (hasValue(v.standardTicketInformation)) {
    result.ticketInformation = v.standardTicketInformation;
  }
  // If neither has value, key is omitted

  return result;
}

module.exports = {
  resolveTicketing,
  isExplicitlySet,
  hasValue
};
