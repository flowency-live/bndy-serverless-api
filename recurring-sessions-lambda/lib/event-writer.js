/**
 * Event Writer
 *
 * Write Events to bndy-events from projected occurrences.
 * Handles dual-key uniqueness (occurrence key + natural key).
 */

const crypto = require('crypto');

const EVENTS_TABLE = process.env.EVENTS_TABLE || 'bndy-events';
const UNIQUE_KEYS_TABLE = process.env.UNIQUE_KEYS_TABLE || 'bndy-unique-keys';

// Only true open mics get the isOpenMic flag (for existing UI compatibility)
const OPEN_MIC_SESSION_TYPES = ['open_mic'];

/**
 * Generate a unique event ID.
 * @returns {string}
 */
function generateEventId() {
  return 'evt_' + crypto.randomBytes(12).toString('hex');
}

/**
 * Generate the occurrence unique key.
 * Format: seriesOccurrence:{seriesId}:{date}
 *
 * @param {string} seriesId
 * @param {string} date - YYYY-MM-DD
 * @returns {string}
 */
function generateOccurrenceUniqueKey(seriesId, date) {
  if (!seriesId) throw new Error('seriesId is required');
  if (!date) throw new Error('date is required');
  return `seriesOccurrence:${seriesId}:${date}`;
}

/**
 * Generate the Event natural key (same as events-lambda pattern).
 * Format: event:{venueId}:{artistId|OPENMIC}:{startTime}:{date}
 *
 * @param {Object} event
 * @returns {string}
 */
function generateEventNaturalKey(event) {
  const artistPart = event.artistId || 'OPENMIC';
  return `event:${event.venueId}:${artistPart}:${event.startTime}:${event.date}`;
}

/**
 * Generate an Event record from a projected occurrence.
 *
 * @param {Object} occurrence - Projected occurrence
 * @param {Object} series - RecurringSession
 * @returns {Object} Event record ready for DynamoDB
 */
function generateEventFromOccurrence(occurrence, series) {
  const now = new Date().toISOString();
  const isOpenMic = OPEN_MIC_SESSION_TYPES.includes(series.sessionType);

  return {
    id: generateEventId(),
    title: occurrence.title,
    venueId: occurrence.venueId,
    date: occurrence.scheduledLocalDate,
    startTime: occurrence.localTime,
    endTime: occurrence.localEndTime || null,
    type: 'community',
    isOpenMic,
    isPublic: true,
    status: 'active',

    // Series linkage
    seriesId: occurrence.seriesId,
    seriesOccurrenceKey: occurrence.occurrenceKey,

    // Metadata
    description: series.description || null,
    source: 'recurring-session-projection',
    createdBy: series.createdBy || null,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Get gate mode from environment.
 * @returns {'off' | 'log' | 'enforce'}
 */
function gateMode() {
  const m = (process.env.GATE_MODE || 'enforce').toLowerCase();
  return ['off', 'log', 'enforce'].includes(m) ? m : 'enforce';
}

/**
 * Write a single Event to bndy-events with dual-key uniqueness.
 *
 * @param {Object} dynamodb - DynamoDB DocumentClient
 * @param {Object} occurrence - Projected occurrence
 * @param {Object} series - RecurringSession
 * @param {Object} options
 * @param {boolean} options.suppressNotifications - Don't trigger notifications
 * @returns {Promise<{ success: boolean, eventId?: string, conflict?: boolean, ... }>}
 */
async function writeEvent(dynamodb, occurrence, series, options = {}) {
  const mode = gateMode();
  const event = generateEventFromOccurrence(occurrence, series);

  if (options.suppressNotifications) {
    event.suppressNotifications = true;
  }

  const occurrenceKey = generateOccurrenceUniqueKey(occurrence.seriesId, occurrence.scheduledLocalDate);
  const naturalKey = generateEventNaturalKey(event);
  const now = new Date().toISOString();

  if (mode === 'off') {
    await dynamodb.put({ TableName: EVENTS_TABLE, Item: event }).promise();
    return { success: true, eventId: event.id, gate: 'off' };
  }

  const transactItems = [
    // Reserve occurrence key
    {
      Put: {
        TableName: UNIQUE_KEYS_TABLE,
        Item: {
          key: occurrenceKey,
          refId: event.id,
          entityType: 'event',
          source: 'series-projection',
          seriesId: occurrence.seriesId,
          createdAt: now
        },
        ConditionExpression: 'attribute_not_exists(#k)',
        ExpressionAttributeNames: { '#k': 'key' }
      }
    },
    // Reserve natural key
    {
      Put: {
        TableName: UNIQUE_KEYS_TABLE,
        Item: {
          key: naturalKey,
          refId: event.id,
          entityType: 'event',
          source: 'series-projection',
          createdAt: now
        },
        ConditionExpression: 'attribute_not_exists(#k)',
        ExpressionAttributeNames: { '#k': 'key' }
      }
    },
    // Write the event
    {
      Put: {
        TableName: EVENTS_TABLE,
        Item: event
      }
    }
  ];

  try {
    await dynamodb.transactWrite({ TransactItems: transactItems }).promise();
    return { success: true, eventId: event.id, gate: 'claimed' };
  } catch (err) {
    if (err.code === 'ResourceNotFoundException') {
      console.error('EVENT-WRITER: unique-keys table missing - writing ungated');
      await dynamodb.put({ TableName: EVENTS_TABLE, Item: event }).promise();
      return { success: true, eventId: event.id, gate: 'unavailable' };
    }

    if (err.code === 'TransactionCanceledException') {
      // Find which key caused the conflict
      const existing = await findConflictingKey(dynamodb, [occurrenceKey, naturalKey]);

      if (mode === 'enforce') {
        return {
          success: false,
          conflict: true,
          conflictType: existing?.key?.startsWith('seriesOccurrence:') ? 'occurrence_key' : 'natural_key',
          existingEventId: existing?.refId,
          conflictKey: existing?.key
        };
      }

      // log mode: write anyway without claiming keys
      console.warn('EVENT-WRITER WOULD_BOUNCE (log mode)', {
        occurrenceKey,
        naturalKey,
        conflictKey: existing?.key
      });
      await dynamodb.put({ TableName: EVENTS_TABLE, Item: event }).promise();
      return { success: true, eventId: event.id, gate: 'logged-duplicate', existing };
    }

    throw err;
  }
}

/**
 * Find which key caused a conflict.
 */
async function findConflictingKey(dynamodb, keys) {
  for (const key of keys) {
    try {
      const res = await dynamodb.get({
        TableName: UNIQUE_KEYS_TABLE,
        Key: { key }
      }).promise();
      if (res.Item) return res.Item;
    } catch (e) {
      // Continue checking
    }
  }
  return null;
}

/**
 * Write a batch of Events from projected occurrences.
 *
 * @param {Object} dynamodb
 * @param {Array<Object>} occurrences
 * @param {Object} series
 * @param {Object} options
 * @returns {Promise<{ created, conflicts, summary }>}
 */
async function writeBatch(dynamodb, occurrences, series, options = {}) {
  const created = [];
  const conflicts = [];

  for (const occurrence of occurrences) {
    const result = await writeEvent(dynamodb, occurrence, series, {
      suppressNotifications: options.suppressNotifications ?? true
    });

    if (result.success) {
      created.push({
        eventId: result.eventId,
        date: occurrence.scheduledLocalDate,
        occurrenceKey: occurrence.occurrenceKey
      });
    } else {
      conflicts.push({
        scheduledLocalDate: occurrence.scheduledLocalDate,
        occurrenceKey: occurrence.occurrenceKey,
        conflictType: result.conflictType,
        existingEventId: result.existingEventId,
        conflictKey: result.conflictKey
      });
    }
  }

  return {
    created,
    conflicts,
    summary: {
      requested: occurrences.length,
      created: created.length,
      conflicts: conflicts.length
    }
  };
}

module.exports = {
  generateEventFromOccurrence,
  generateOccurrenceUniqueKey,
  generateEventNaturalKey,
  generateEventId,
  writeEvent,
  writeBatch,
  EVENTS_TABLE,
  UNIQUE_KEYS_TABLE
};
