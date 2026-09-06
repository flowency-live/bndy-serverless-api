/**
 * Projector
 *
 * Core logic for computing occurrences from a RecurringSession.
 * This is the heart of Slice 2 - shadow projection.
 */

const { generateOccurrenceKey } = require('./occurrence-key');
const { localToUTC } = require('./timezone-utils');

const PROJECTION_DEFAULTS = {
  horizonWeeks: 16,
  maxOccurrences: 26
};

const ACTIVE_STATUSES = ['active', 'draft'];

/**
 * Computes occurrences for a RecurringSession within a date range.
 *
 * @param {Object} session - The RecurringSession
 * @param {string} startDate - Range start (YYYY-MM-DD)
 * @param {string} endDate - Range end (YYYY-MM-DD)
 * @param {Object} options - Optional overrides
 * @param {number} options.maxOccurrences - Cap on occurrences returned
 * @returns {Array<Object>} Array of occurrence DTOs
 */
function computeOccurrencesInRange(session, startDate, endDate, options = {}) {
  const maxOccurrences = options.maxOccurrences ?? PROJECTION_DEFAULTS.maxOccurrences;

  // Inactive sessions produce no occurrences
  if (!ACTIVE_STATUSES.includes(session.status)) {
    return [];
  }

  const { recurrence, startsOn, endsOn, timezone } = session;

  // Effective range is intersection of [startsOn, endsOn] and [startDate, endDate]
  const effectiveStart = startsOn > startDate ? startsOn : startDate;
  const effectiveEnd = endsOn && endsOn < endDate ? endsOn : endDate;

  if (effectiveStart > effectiveEnd) {
    return [];
  }

  const occurrences = [];

  switch (recurrence.frequency) {
    case 'weekly':
      generateWeeklyOccurrences(
        session,
        effectiveStart,
        effectiveEnd,
        occurrences,
        maxOccurrences
      );
      break;

    case 'monthly_by_weekday':
      generateMonthlyByWeekdayOccurrences(
        session,
        effectiveStart,
        effectiveEnd,
        occurrences,
        maxOccurrences
      );
      break;

    case 'monthly_by_date':
      generateMonthlyByDateOccurrences(
        session,
        effectiveStart,
        effectiveEnd,
        occurrences,
        maxOccurrences
      );
      break;

    default:
      throw new Error(`Unknown frequency: ${recurrence.frequency}`);
  }

  return occurrences;
}

/**
 * Generate weekly occurrences
 */
function generateWeeklyOccurrences(session, startDate, endDate, occurrences, maxOccurrences) {
  const { recurrence, startsOn, timezone } = session;
  const interval = recurrence.interval || 1;
  const daysOfWeek = [...recurrence.daysOfWeek].sort((a, b) => a - b);

  // Parse the anchor date (startsOn)
  const anchorDate = new Date(startsOn + 'T00:00:00Z');
  const anchorWeekStart = getWeekStart(anchorDate);

  // Start iteration from the beginning of the week containing startDate
  let currentDate = new Date(startDate + 'T00:00:00Z');
  const weekStart = getWeekStart(currentDate);

  // Calculate which week we're in relative to anchor
  const weeksDiff = Math.floor((weekStart - anchorWeekStart) / (7 * 24 * 60 * 60 * 1000));
  const weekOffset = ((weeksDiff % interval) + interval) % interval;

  // Adjust to the correct interval week
  if (weekOffset !== 0) {
    currentDate = new Date(weekStart.getTime() + (interval - weekOffset) * 7 * 24 * 60 * 60 * 1000);
  } else {
    currentDate = new Date(weekStart);
  }

  const endDateObj = new Date(endDate + 'T23:59:59Z');

  while (currentDate <= endDateObj && occurrences.length < maxOccurrences) {
    // Check each day of this week
    for (const dayOfWeek of daysOfWeek) {
      if (occurrences.length >= maxOccurrences) break;

      const occDate = new Date(currentDate);
      const currentDayOfWeek = occDate.getUTCDay();
      const daysToAdd = (dayOfWeek - currentDayOfWeek + 7) % 7;
      occDate.setUTCDate(occDate.getUTCDate() + daysToAdd);

      const dateStr = formatDate(occDate);

      // Check bounds
      if (dateStr >= startsOn && dateStr >= startDate && dateStr <= endDate) {
        if (!session.endsOn || dateStr <= session.endsOn) {
          occurrences.push(createOccurrence(session, dateStr, timezone));
        }
      }
    }

    // Move to next interval week
    currentDate.setUTCDate(currentDate.getUTCDate() + 7 * interval);
  }

  // Sort by date
  occurrences.sort((a, b) => a.scheduledLocalDate.localeCompare(b.scheduledLocalDate));
}

/**
 * Generate monthly by weekday occurrences
 */
function generateMonthlyByWeekdayOccurrences(session, startDate, endDate, occurrences, maxOccurrences) {
  const { recurrence, startsOn, timezone } = session;
  const { ordinal, weekday } = recurrence;

  // Start from the month containing startDate or startsOn, whichever is later
  const effectiveStart = startsOn > startDate ? startsOn : startDate;
  let [year, month] = effectiveStart.split('-').map(Number);

  const endDateObj = new Date(endDate + 'T23:59:59Z');

  while (occurrences.length < maxOccurrences) {
    const dateStr = getNthWeekdayOfMonth(year, month, ordinal, weekday);

    if (dateStr) {
      const dateObj = new Date(dateStr + 'T00:00:00Z');

      if (dateObj > endDateObj) break;

      if (dateStr >= startsOn && dateStr >= startDate && dateStr <= endDate) {
        if (!session.endsOn || dateStr <= session.endsOn) {
          occurrences.push(createOccurrence(session, dateStr, timezone));
        }
      }
    }

    // Move to next month
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }

    // Safety: don't iterate forever
    if (year > 2100) break;
  }
}

/**
 * Generate monthly by date occurrences
 */
function generateMonthlyByDateOccurrences(session, startDate, endDate, occurrences, maxOccurrences) {
  const { recurrence, startsOn, timezone } = session;
  const { dayOfMonth } = recurrence;

  // Start from the month containing startDate or startsOn
  const effectiveStart = startsOn > startDate ? startsOn : startDate;
  let [year, month] = effectiveStart.split('-').map(Number);

  const endDateObj = new Date(endDate + 'T23:59:59Z');

  while (occurrences.length < maxOccurrences) {
    // Check if this day exists in this month
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    if (dayOfMonth <= daysInMonth) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
      const dateObj = new Date(dateStr + 'T00:00:00Z');

      if (dateObj > endDateObj) break;

      if (dateStr >= startsOn && dateStr >= startDate && dateStr <= endDate) {
        if (!session.endsOn || dateStr <= session.endsOn) {
          occurrences.push(createOccurrence(session, dateStr, timezone));
        }
      }
    }

    // Move to next month
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }

    // Safety
    if (year > 2100) break;
  }
}

/**
 * Get the Nth weekday of a month, or last if ordinal is -1
 */
function getNthWeekdayOfMonth(year, month, ordinal, weekday) {
  if (ordinal === -1) {
    // Last occurrence of weekday
    const lastDay = new Date(Date.UTC(year, month, 0)); // Last day of month
    let date = new Date(Date.UTC(year, month - 1, lastDay.getUTCDate()));

    while (date.getUTCDay() !== weekday) {
      date.setUTCDate(date.getUTCDate() - 1);
    }

    return formatDate(date);
  }

  // Nth occurrence
  let count = 0;
  let date = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  while (date.getUTCDate() <= daysInMonth) {
    if (date.getUTCDay() === weekday) {
      count++;
      if (count === ordinal) {
        return formatDate(date);
      }
    }
    date.setUTCDate(date.getUTCDate() + 1);

    // Check we haven't rolled into next month
    if (date.getUTCMonth() !== month - 1) break;
  }

  return null; // Nth occurrence doesn't exist in this month
}

/**
 * Get the start of the week (Sunday) for a date
 */
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Format a Date as YYYY-MM-DD
 */
function formatDate(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Create an occurrence DTO
 */
function createOccurrence(session, scheduledLocalDate, timezone) {
  const utcStart = localToUTC(scheduledLocalDate, session.defaultStartTime, timezone);

  const occurrence = {
    occurrenceKey: generateOccurrenceKey(session.id, scheduledLocalDate),
    seriesId: session.id,
    scheduledLocalDate,
    localTime: session.defaultStartTime,
    utcStart,
    venueId: session.venueId,
    title: session.name
  };

  if (session.defaultEndTime) {
    occurrence.localEndTime = session.defaultEndTime;
  }

  return occurrence;
}

/**
 * Compute the next occurrence from a given date
 */
function computeNextOccurrence(session, fromDate) {
  if (!ACTIVE_STATUSES.includes(session.status)) {
    return null;
  }

  if (session.endsOn && fromDate > session.endsOn) {
    return null;
  }

  // Look up to 1 year ahead
  const endDate = new Date(fromDate);
  endDate.setUTCFullYear(endDate.getUTCFullYear() + 1);
  const endDateStr = formatDate(endDate);

  const occurrences = computeOccurrencesInRange(
    session,
    fromDate,
    endDateStr,
    { maxOccurrences: 1 }
  );

  return occurrences.length > 0 ? occurrences[0] : null;
}

module.exports = {
  computeOccurrencesInRange,
  computeNextOccurrence,
  PROJECTION_DEFAULTS
};
