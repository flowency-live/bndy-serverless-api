/**
 * Timezone Utilities
 *
 * Handles IANA timezone validation and DST-aware date/time conversions.
 *
 * DESIGN PRINCIPLE: All times in RecurringSession are LOCAL to the venue's timezone.
 * The timezone field (e.g., 'Europe/London') enables DST-aware computation.
 *
 * @module timezone-utils
 */

/**
 * Validate an IANA timezone identifier.
 * @param {string} timezone
 * @returns {string|null} Error message or null if valid
 */
function validateTimezone(timezone) {
  if (!timezone || typeof timezone !== 'string') {
    return 'timezone is required';
  }

  try {
    // Intl.DateTimeFormat validates IANA timezone identifiers
    Intl.DateTimeFormat('en-GB', { timeZone: timezone });
    return null;
  } catch (e) {
    return 'invalid IANA timezone';
  }
}

/**
 * Convert a local date and time to UTC ISO string.
 *
 * Uses a technique that avoids ambiguity issues:
 * 1. Parse the target local date/time
 * 2. Use Intl.DateTimeFormat to find the UTC offset for that moment
 * 3. Apply the offset to get UTC
 *
 * For ambiguous times (fall back), we use the FIRST occurrence (earlier UTC).
 *
 * @param {string} date - YYYY-MM-DD
 * @param {string} time - HH:MM
 * @param {string} timezone - IANA timezone (e.g., 'Europe/London')
 * @returns {string} UTC ISO string
 */
function localToUTC(date, time, timezone) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);

  // Create a Date object using the local values as if they were UTC
  // This gives us a reference point to work from
  const localAsUTC = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

  // Get the UTC offset for this timezone at this approximate moment
  // We use a formatter that shows the offset
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset'
  });

  // Format the date in the target timezone
  const parts = formatter.formatToParts(localAsUTC);

  // Extract the offset (e.g., "GMT+1" or "GMT-5")
  const tzPart = parts.find(p => p.type === 'timeZoneName');
  const offsetStr = tzPart ? tzPart.value : 'GMT';

  // Parse the offset
  let offsetMinutes = 0;
  if (offsetStr !== 'GMT' && offsetStr !== 'UTC') {
    const match = offsetStr.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (match) {
      const sign = match[1] === '+' ? 1 : -1;
      const hours = parseInt(match[2], 10);
      const mins = match[3] ? parseInt(match[3], 10) : 0;
      offsetMinutes = sign * (hours * 60 + mins);
    }
  }

  // The local time in the target timezone corresponds to:
  // UTC = local - offset
  // So if local is 19:00 and offset is +1 (BST), UTC is 18:00
  const utcMs = localAsUTC.getTime() - (offsetMinutes * 60 * 1000);
  const utcDate = new Date(utcMs);

  return utcDate.toISOString();
}

/**
 * Convert a UTC ISO string to local date and time.
 * @param {string} utcIso - UTC ISO string
 * @param {string} timezone - IANA timezone
 * @returns {{ date: string, time: string }} Local date and time
 */
function utcToLocal(utcIso, timezone) {
  const utcDate = new Date(utcIso);

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(utcDate);

  const day = parts.find(p => p.type === 'day').value;
  const month = parts.find(p => p.type === 'month').value;
  const year = parts.find(p => p.type === 'year').value;
  const hour = parts.find(p => p.type === 'hour').value;
  const minute = parts.find(p => p.type === 'minute').value;

  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`
  };
}

/**
 * Extract the local time (HH:MM) from a UTC ISO string.
 * @param {string} utcIso - UTC ISO string
 * @param {string} timezone - IANA timezone
 * @returns {string} Local time in HH:MM format
 */
function extractLocalTime(utcIso, timezone) {
  return utcToLocal(utcIso, timezone).time;
}

/**
 * Extract the local date (YYYY-MM-DD) from a UTC ISO string.
 * @param {string} utcIso - UTC ISO string
 * @param {string} timezone - IANA timezone
 * @returns {string} Local date in YYYY-MM-DD format
 */
function extractLocalDate(utcIso, timezone) {
  return utcToLocal(utcIso, timezone).date;
}

module.exports = {
  validateTimezone,
  localToUTC,
  utcToLocal,
  extractLocalTime,
  extractLocalDate
};
