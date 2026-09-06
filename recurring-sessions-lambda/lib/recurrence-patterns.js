/**
 * Recurrence Pattern Validation
 *
 * Validates RecurrencePattern objects according to the design document section 9.2.
 * Supports three pattern types:
 *   - weekly: { frequency: 'weekly', interval: 1-4, daysOfWeek: Weekday[] }
 *   - monthly_by_weekday: { frequency: 'monthly_by_weekday', interval: 1, ordinal: 1-4|-1, weekday: Weekday }
 *   - monthly_by_date: { frequency: 'monthly_by_date', interval: 1, dayOfMonth: 1-28 }
 *
 * @module recurrence-patterns
 */

const VALID_FREQUENCIES = ['weekly', 'monthly_by_weekday', 'monthly_by_date'];

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/**
 * Validate a recurrence pattern.
 * @param {Object} pattern - The recurrence pattern to validate
 * @returns {string|null} Error message or null if valid
 */
function validateRecurrencePattern(pattern) {
  if (!pattern || typeof pattern !== 'object') {
    return 'recurrence pattern must be an object';
  }

  if (!VALID_FREQUENCIES.includes(pattern.frequency)) {
    return `recurrence.frequency must be one of: ${VALID_FREQUENCIES.join(', ')}`;
  }

  if (pattern.frequency === 'weekly') {
    return validateWeeklyPattern(pattern);
  }

  if (pattern.frequency === 'monthly_by_weekday') {
    return validateMonthlyByWeekdayPattern(pattern);
  }

  if (pattern.frequency === 'monthly_by_date') {
    return validateMonthlyByDatePattern(pattern);
  }

  return null;
}

/**
 * Validate a weekly recurrence pattern.
 * @param {Object} pattern
 * @returns {string|null}
 */
function validateWeeklyPattern(pattern) {
  if (typeof pattern.interval !== 'number' || pattern.interval < 1 || pattern.interval > 4) {
    return 'weekly interval must be 1-4';
  }

  if (!Array.isArray(pattern.daysOfWeek) || pattern.daysOfWeek.length === 0) {
    return 'weekly daysOfWeek must be non-empty array';
  }

  for (const day of pattern.daysOfWeek) {
    if (typeof day !== 'string' || !WEEKDAYS.includes(day.toLowerCase())) {
      return `invalid weekday: ${day}. Must be one of: ${WEEKDAYS.join(', ')}`;
    }
  }

  return null;
}

/**
 * Validate a monthly by weekday recurrence pattern.
 * @param {Object} pattern
 * @returns {string|null}
 */
function validateMonthlyByWeekdayPattern(pattern) {
  if (pattern.interval !== 1) {
    return 'interval must be 1 for monthly patterns';
  }

  const validOrdinals = [1, 2, 3, 4, -1];
  if (!validOrdinals.includes(pattern.ordinal)) {
    return 'ordinal must be 1-4 or -1 (last)';
  }

  if (!pattern.weekday || typeof pattern.weekday !== 'string') {
    return 'weekday is required for monthly_by_weekday';
  }

  if (!WEEKDAYS.includes(pattern.weekday.toLowerCase())) {
    return `invalid weekday: ${pattern.weekday}. Must be one of: ${WEEKDAYS.join(', ')}`;
  }

  return null;
}

/**
 * Validate a monthly by date recurrence pattern.
 * @param {Object} pattern
 * @returns {string|null}
 */
function validateMonthlyByDatePattern(pattern) {
  if (pattern.interval !== 1) {
    return 'interval must be 1 for monthly patterns';
  }

  if (typeof pattern.dayOfMonth !== 'number' || pattern.dayOfMonth < 1 || pattern.dayOfMonth > 28) {
    return 'dayOfMonth must be 1-28 (February-safe)';
  }

  return null;
}

/**
 * Normalise a weekday string to lowercase.
 * @param {string} weekday
 * @returns {string}
 */
function normaliseWeekday(weekday) {
  return weekday.toLowerCase();
}

/**
 * Get the weekday index (0 = Sunday, 1 = Monday, ..., 6 = Saturday).
 * @param {string} weekday
 * @returns {number}
 */
function weekdayToIndex(weekday) {
  const indices = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6
  };
  return indices[weekday.toLowerCase()];
}

module.exports = {
  validateRecurrencePattern,
  validateWeeklyPattern,
  validateMonthlyByWeekdayPattern,
  validateMonthlyByDatePattern,
  normaliseWeekday,
  weekdayToIndex,
  VALID_FREQUENCIES,
  WEEKDAYS
};
