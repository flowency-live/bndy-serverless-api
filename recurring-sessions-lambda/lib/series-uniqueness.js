/**
 * Series Uniqueness
 *
 * Prevent duplicate RecurringSessions at the same venue with similar schedule.
 * Uses the bndy-unique-keys table for atomic reservation.
 */

const { weekdayToIndex } = require('./recurrence-patterns');

const UNIQUE_KEYS_TABLE = process.env.UNIQUE_KEYS_TABLE || 'bndy-unique-keys';

/** Weekday name ('tuesday') or index (2) to index, so both forms share one key. */
function dayIndex(weekday) {
  const index = typeof weekday === 'number' ? weekday : weekdayToIndex(String(weekday));
  if (!Number.isInteger(index) || index < 0 || index > 6) {
    throw new Error(`Unknown weekday: ${weekday}`);
  }
  return index;
}

/**
 * Normalise session name for use in unique key.
 * Lowercase, remove punctuation, replace spaces with underscores.
 *
 * @param {string} name
 * @returns {string}
 */
function normaliseName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/['''`]/g, '') // Remove apostrophes
    .replace(/[^a-z0-9]+/g, '_') // Replace non-alphanumeric with underscore
    .replace(/^_|_$/g, '') // Trim leading/trailing underscores
    .replace(/_+/g, '_'); // Collapse multiple underscores
}

/**
 * Generate ordinal string for monthly_by_weekday.
 *
 * @param {number} ordinal - 1-4 or -1
 * @returns {string}
 */
function ordinalString(ordinal) {
  if (ordinal === -1) return 'last';
  if (ordinal === 1) return '1st';
  if (ordinal === 2) return '2nd';
  if (ordinal === 3) return '3rd';
  if (ordinal === 4) return '4th';
  return String(ordinal);
}

/**
 * Generate a unique key for a RecurringSession.
 *
 * Key format:
 *   weekly: series:{venueId}:{normalisedName}:weekly:{daysOfWeek}
 *   fortnightly: series:{venueId}:{normalisedName}:fortnightly:{daysOfWeek}
 *   monthly_by_weekday: series:{venueId}:{normalisedName}:monthly:{ordinal}:{weekday}
 *   monthly_by_date: series:{venueId}:{normalisedName}:monthly:day{dayOfMonth}
 *
 * @param {Object} session
 * @returns {string}
 */
function generateSeriesKey(session) {
  if (!session.venueId) {
    throw new Error('venueId is required');
  }
  if (!session.name) {
    throw new Error('name is required');
  }
  if (!session.recurrence) {
    throw new Error('recurrence is required');
  }

  const { recurrence } = session;
  const normName = normaliseName(session.name);
  const parts = ['series', session.venueId, normName];

  switch (recurrence.frequency) {
    case 'weekly': {
      const interval = recurrence.interval || 1;
      const freq = interval === 2 ? 'fortnightly' : 'weekly';
      const days = (recurrence.daysOfWeek || []).map(dayIndex).sort((a, b) => a - b).join(',');
      parts.push(freq, days);
      break;
    }

    case 'monthly_by_weekday': {
      const ordStr = ordinalString(recurrence.ordinal);
      parts.push('monthly', ordStr, String(dayIndex(recurrence.weekday)));
      break;
    }

    case 'monthly_by_date': {
      parts.push('monthly', `day${recurrence.dayOfMonth}`);
      break;
    }

    default:
      throw new Error(`Unknown frequency: ${recurrence.frequency}`);
  }

  return parts.join(':');
}

/**
 * Check if a Series with the same unique key already exists.
 *
 * @param {Object} dynamodb - DynamoDB DocumentClient
 * @param {Object} session
 * @returns {Promise<Object|null>} Existing key item or null
 */
async function checkSeriesUniqueness(dynamodb, session) {
  const key = generateSeriesKey(session);

  try {
    const result = await dynamodb.get({
      TableName: UNIQUE_KEYS_TABLE,
      Key: { key }
    }).promise();

    return result.Item || null;
  } catch (error) {
    if (error.code === 'ResourceNotFoundException') {
      console.warn('SERIES-UNIQUENESS: unique-keys table not found');
      return null;
    }
    throw error;
  }
}

/**
 * Reserve a unique key for a new Series.
 *
 * @param {Object} dynamodb - DynamoDB DocumentClient
 * @param {Object} session - Must include id, venueId, name, recurrence
 * @returns {Promise<{ success: boolean, conflict?: boolean, key?: string }>}
 */
async function reserveSeriesKey(dynamodb, session) {
  const key = generateSeriesKey(session);
  const now = new Date().toISOString();

  try {
    await dynamodb.put({
      TableName: UNIQUE_KEYS_TABLE,
      Item: {
        key,
        refId: session.id,
        entityType: 'recurring-session',
        source: 'series-create',
        createdAt: now
      },
      ConditionExpression: 'attribute_not_exists(#k)',
      ExpressionAttributeNames: { '#k': 'key' }
    }).promise();

    return { success: true, key };
  } catch (error) {
    if (error.code === 'ConditionalCheckFailedException') {
      return { success: false, conflict: true, key };
    }
    if (error.code === 'ResourceNotFoundException') {
      console.warn('SERIES-UNIQUENESS: unique-keys table not found - proceeding without reservation');
      return { success: true, key, unguarded: true };
    }
    throw error;
  }
}

/**
 * Release a Series unique key (for deletion or supersession).
 *
 * @param {Object} dynamodb
 * @param {Object} session
 * @param {string} expectedRefId - Only release if this refId owns the key
 */
async function releaseSeriesKey(dynamodb, session, expectedRefId) {
  const key = generateSeriesKey(session);

  try {
    await dynamodb.delete({
      TableName: UNIQUE_KEYS_TABLE,
      Key: { key },
      ConditionExpression: 'refId = :r',
      ExpressionAttributeValues: { ':r': expectedRefId }
    }).promise();
  } catch (error) {
    if (error.code !== 'ConditionalCheckFailedException' &&
        error.code !== 'ResourceNotFoundException') {
      console.warn(`SERIES-UNIQUENESS: release failed for ${key}: ${error.code}`);
    }
  }
}

module.exports = {
  generateSeriesKey,
  checkSeriesUniqueness,
  reserveSeriesKey,
  releaseSeriesKey,
  normaliseName,
  UNIQUE_KEYS_TABLE
};
