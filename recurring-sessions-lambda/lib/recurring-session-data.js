/**
 * RecurringSession Data Module
 *
 * Handles RecurringSession validation, lifecycle management, and persistence.
 *
 * SLICE 1: Persistence functions (create/update) are PRIVATE and not wired to routes.
 * Only validation and read operations are publicly exported.
 *
 * @module recurring-session-data
 */

const { validateRecurrencePattern } = require('./recurrence-patterns');
const { validateTimezone } = require('./timezone-utils');

const RECURRING_SESSIONS_TABLE = process.env.RECURRING_SESSIONS_TABLE || 'bndy-recurring-sessions';
const SCHEMA_VERSION = 1;

const VALID_STATUSES = ['draft', 'active', 'paused', 'stale', 'ended', 'superseded'];

const VALID_SESSION_TYPES = ['open_mic', 'jam_session', 'folk_session', 'residency', 'club_night', 'other'];

// Terminal states that cannot transition to other states
const TERMINAL_STATUSES = ['ended', 'superseded'];

// Valid lifecycle transitions
const VALID_TRANSITIONS = {
  draft: ['active'],
  active: ['paused', 'stale', 'ended', 'superseded'],
  paused: ['active', 'ended', 'superseded'],
  stale: ['active', 'ended'],
  ended: [],       // Terminal
  superseded: []   // Terminal
};

/**
 * Validate a RecurringSession object.
 * @param {Object} session - The session to validate
 * @returns {string|null} Error message or null if valid
 */
function validateRecurringSession(session) {
  if (!session || typeof session !== 'object') {
    return 'session must be an object';
  }

  // Required: name
  if (!session.name || typeof session.name !== 'string' || !session.name.trim()) {
    return 'name is required';
  }

  // Required: venueId
  if (!session.venueId || typeof session.venueId !== 'string') {
    return 'venueId is required';
  }

  // Required: timezone
  const tzError = validateTimezone(session.timezone);
  if (tzError) {
    return tzError;
  }

  // Required: recurrence
  if (!session.recurrence) {
    return 'recurrence is required';
  }
  const recError = validateRecurrencePattern(session.recurrence);
  if (recError) {
    return recError;
  }

  // Optional: sessionType
  if (session.sessionType !== undefined && !VALID_SESSION_TYPES.includes(session.sessionType)) {
    return `sessionType must be one of: ${VALID_SESSION_TYPES.join(', ')}`;
  }

  // Optional: status
  if (session.status !== undefined && !VALID_STATUSES.includes(session.status)) {
    return `status must be one of: ${VALID_STATUSES.join(', ')}`;
  }

  // Optional: startsOn
  if (session.startsOn !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(session.startsOn)) {
      return 'startsOn must be YYYY-MM-DD';
    }
  }

  // Optional: endsOn
  if (session.endsOn !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(session.endsOn)) {
      return 'endsOn must be YYYY-MM-DD';
    }
    if (session.startsOn && session.endsOn < session.startsOn) {
      return 'endsOn must be after startsOn';
    }
  }

  // Optional: hostArtistIds
  if (session.hostArtistIds !== undefined && !Array.isArray(session.hostArtistIds)) {
    return 'hostArtistIds must be an array';
  }

  return null;
}

/**
 * Validate a lifecycle status transition.
 * @param {string} fromStatus - Current status
 * @param {string} toStatus - Target status
 * @returns {string|null} Error message or null if valid
 */
function validateLifecycleTransition(fromStatus, toStatus) {
  if (TERMINAL_STATUSES.includes(fromStatus)) {
    return `cannot transition from ${fromStatus} (terminal state)`;
  }

  const validTargets = VALID_TRANSITIONS[fromStatus] || [];
  if (!validTargets.includes(toStatus)) {
    return `cannot transition from ${fromStatus} to ${toStatus}`;
  }

  return null;
}

/**
 * Normalise a session name for consistent matching and unique key generation.
 * @param {string} name
 * @returns {string}
 */
function normaliseSessionName(name) {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Generate a unique key for a RecurringSession.
 * Format: series#<venueId>#<normalisedName>#<primaryDay>
 *
 * This prevents duplicate series at the same venue with the same name on the same day.
 *
 * @param {Object} session
 * @returns {string}
 */
function recurringSessionUniqueKey(session) {
  const normalisedName = normaliseSessionName(session.name);

  // Extract primary day from recurrence pattern
  let primaryDay = '';
  if (session.recurrence?.frequency === 'weekly' && session.recurrence.daysOfWeek?.length > 0) {
    primaryDay = session.recurrence.daysOfWeek[0].toLowerCase();
  } else if (session.recurrence?.frequency === 'monthly_by_weekday' && session.recurrence.weekday) {
    primaryDay = session.recurrence.weekday.toLowerCase();
  }
  // monthly_by_date has no day-of-week, so primaryDay remains empty

  return `series#${session.venueId}#${normalisedName}#${primaryDay}`;
}

/**
 * Activity log action vocabulary for RecurringSessions.
 * Used for future audit logging (not wired in Slice 1).
 */
const SERIES_ACTIONS = {
  // Lifecycle
  SERIES_CREATED: 'series_created',
  SERIES_ACTIVATED: 'series_activated',
  SERIES_PAUSED: 'series_paused',
  SERIES_RESUMED: 'series_resumed',
  SERIES_ENDED: 'series_ended',
  SERIES_SUPERSEDED: 'series_superseded',

  // Updates
  SERIES_UPDATED: 'series_updated',
  SERIES_RECURRENCE_CHANGED: 'series_recurrence_changed',
  SERIES_HOSTS_CHANGED: 'series_hosts_changed',

  // Exceptions (for projector - Slice 2+)
  SERIES_EXCEPTION_ADDED: 'series_exception_added',
  SERIES_EXCEPTION_REMOVED: 'series_exception_removed',

  // Occurrences (for projector - Slice 2+)
  OCCURRENCE_MATERIALISED: 'occurrence_materialised',
  OCCURRENCE_ADOPTED: 'occurrence_adopted',
  OCCURRENCE_CANCELLED: 'occurrence_cancelled',
  OCCURRENCE_MOVED: 'occurrence_moved'
};

module.exports = {
  // Constants
  RECURRING_SESSIONS_TABLE,
  SCHEMA_VERSION,
  VALID_STATUSES,
  VALID_SESSION_TYPES,
  SERIES_ACTIONS,

  // Validation
  validateRecurringSession,
  validateLifecycleTransition,

  // Utility
  normaliseSessionName,
  recurringSessionUniqueKey
};
