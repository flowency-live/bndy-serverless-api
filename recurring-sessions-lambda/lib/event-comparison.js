/**
 * Event Comparison
 *
 * Compare projected occurrences against existing Events in bndy-events.
 * This is the core of shadow projection - determining what would happen.
 */

const MATCH_TYPES = ['exact', 'linked', 'unlinked_match', 'conflict', 'missing'];

/**
 * Compare a single occurrence to a single event.
 * Returns null if they're not at the same venue/date.
 *
 * @param {Object} occurrence - The projected occurrence
 * @param {Object} event - An existing Event
 * @returns {{ type: string, eventId: string, ... } | null}
 */
function matchOccurrenceToEvent(occurrence, event) {
  // Must be same venue
  if (event.venueId !== occurrence.venueId) {
    return null;
  }

  // Must be same date
  if (event.date !== occurrence.scheduledLocalDate) {
    return null;
  }

  const eventId = event.id;

  // Check for exact match (Event is already linked to this occurrence)
  if (event.seriesOccurrenceKey === occurrence.occurrenceKey) {
    return {
      type: 'exact',
      eventId,
      confidence: 'certain'
    };
  }

  // Check for linked match (Event linked to series but maybe different key format)
  if (event.seriesId === occurrence.seriesId) {
    return {
      type: 'linked',
      eventId,
      confidence: 'high'
    };
  }

  // Check for conflict (Event linked to a different series)
  if (event.seriesId && event.seriesId !== occurrence.seriesId) {
    return {
      type: 'conflict',
      eventId,
      reason: 'Different series owns this slot',
      conflictingSeriesId: event.seriesId
    };
  }

  // Event is not linked to any series - check if it's a match
  const timeProximity = calculateTimeProximity(occurrence.localTime, event.startTime);

  if (timeProximity === 'exact' || timeProximity === 'close') {
    // Title similarity check
    const titleMatch = isTitleSimilar(occurrence.title, event.title);

    return {
      type: 'unlinked_match',
      eventId,
      confidence: timeProximity === 'exact' && titleMatch ? 'high' : 'medium',
      timeProximity,
      titleMatch
    };
  }

  // Same venue/date but very different time - likely different event
  return {
    type: 'conflict',
    eventId,
    reason: 'Different event at same venue/date'
  };
}

/**
 * Calculate how close two times are.
 *
 * @param {string} time1 - HH:MM format
 * @param {string} time2 - HH:MM format
 * @returns {'exact' | 'close' | 'far'}
 */
function calculateTimeProximity(time1, time2) {
  if (time1 === time2) return 'exact';

  const mins1 = parseTimeToMinutes(time1);
  const mins2 = parseTimeToMinutes(time2);

  if (mins1 === null || mins2 === null) return 'far';

  const diff = Math.abs(mins1 - mins2);

  if (diff <= 60) return 'close'; // Within 1 hour
  return 'far';
}

/**
 * Parse HH:MM to minutes since midnight.
 */
function parseTimeToMinutes(time) {
  if (!time || typeof time !== 'string') return null;

  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = parseInt(match[1], 10);
  const mins = parseInt(match[2], 10);

  return hours * 60 + mins;
}

/**
 * Check if two titles are similar enough to be the same event.
 */
function isTitleSimilar(title1, title2) {
  if (!title1 || !title2) return false;

  const norm1 = title1.toLowerCase().trim();
  const norm2 = title2.toLowerCase().trim();

  if (norm1 === norm2) return true;

  // Check if one contains the other
  if (norm1.includes(norm2) || norm2.includes(norm1)) return true;

  return false;
}

/**
 * Compare projected occurrences against existing Events.
 *
 * @param {Array<Object>} occurrences - Projected occurrences
 * @param {Array<Object>} existingEvents - Events from bndy-events table
 * @returns {{ wouldCreate, wouldUpdate, alreadyExists, conflicts }}
 */
function compareWithExistingEvents(occurrences, existingEvents) {
  const wouldCreate = [];
  const wouldUpdate = [];
  const alreadyExists = [];
  const conflicts = [];

  for (const occurrence of occurrences) {
    // Find relevant events (same venue, same date)
    const relevantEvents = existingEvents.filter(
      evt => evt.venueId === occurrence.venueId && evt.date === occurrence.scheduledLocalDate
    );

    if (relevantEvents.length === 0) {
      // No existing event - would create
      wouldCreate.push({
        ...occurrence,
        action: 'create'
      });
      continue;
    }

    // Check each relevant event for matches
    let bestMatch = null;

    for (const event of relevantEvents) {
      const match = matchOccurrenceToEvent(occurrence, event);

      if (!match) continue;

      // Prioritize exact > linked > unlinked_match > conflict
      if (!bestMatch || isHigherPriority(match.type, bestMatch.type)) {
        bestMatch = { ...match, event };
      }
    }

    if (!bestMatch) {
      // No match found - would create
      wouldCreate.push({
        ...occurrence,
        action: 'create'
      });
      continue;
    }

    switch (bestMatch.type) {
      case 'exact':
        alreadyExists.push({
          occurrenceKey: occurrence.occurrenceKey,
          scheduledLocalDate: occurrence.scheduledLocalDate,
          existingEventId: bestMatch.eventId,
          match: 'exact'
        });
        break;

      case 'linked':
        alreadyExists.push({
          occurrenceKey: occurrence.occurrenceKey,
          scheduledLocalDate: occurrence.scheduledLocalDate,
          existingEventId: bestMatch.eventId,
          match: 'linked'
        });
        break;

      case 'unlinked_match':
        wouldUpdate.push({
          occurrenceKey: occurrence.occurrenceKey,
          scheduledLocalDate: occurrence.scheduledLocalDate,
          existingEventId: bestMatch.eventId,
          match: 'unlinked_match',
          confidence: bestMatch.confidence,
          action: 'link'
        });
        break;

      case 'conflict':
        conflicts.push({
          occurrenceKey: occurrence.occurrenceKey,
          scheduledLocalDate: occurrence.scheduledLocalDate,
          conflictingEventId: bestMatch.eventId,
          reason: bestMatch.reason
        });
        break;
    }
  }

  return {
    wouldCreate,
    wouldUpdate,
    alreadyExists,
    conflicts
  };
}

/**
 * Check if match type A is higher priority than B.
 */
function isHigherPriority(typeA, typeB) {
  const priority = { exact: 4, linked: 3, unlinked_match: 2, conflict: 1 };
  return (priority[typeA] || 0) > (priority[typeB] || 0);
}

module.exports = {
  compareWithExistingEvents,
  matchOccurrenceToEvent,
  MATCH_TYPES
};
