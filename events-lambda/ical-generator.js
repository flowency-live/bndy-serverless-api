/**
 * iCal Generator Module
 *
 * Generates RFC 5545 compliant iCal/ICS content for BNDY calendar events.
 * Supports regular events, recurring events with RRULE, and cancellations.
 *
 * Uses the 'ics' library for iCal generation.
 */

const ics = require('ics');

/**
 * Generate a consistent UID for an event.
 * UIDs must be globally unique and persistent.
 *
 * @param {Object} event - BNDY event object
 * @returns {string} - UID in format eventId@bndy.co.uk
 */
function generateEventUid(event) {
  return `${event.id}@bndy.co.uk`;
}

/**
 * Parse a time string (HH:mm) into hours and minutes.
 *
 * @param {string} timeStr - Time in HH:mm format
 * @returns {Object} - { hours: number, minutes: number }
 */
function parseTime(timeStr) {
  if (!timeStr) return null;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return { hours, minutes };
}

/**
 * Parse a date string (YYYY-MM-DD) into components.
 *
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {Object} - { year: number, month: number, day: number }
 */
function parseDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return { year, month, day };
}

/**
 * Convert BNDY recurring rules to RFC 5545 RRULE string.
 *
 * @param {Object|null} recurring - BNDY recurring object
 * @returns {string|null} - RRULE string or null if not recurring
 */
function recurringToRRule(recurring) {
  if (!recurring) return null;

  // Map BNDY types to iCal FREQ values
  const freqMap = {
    day: 'DAILY',
    week: 'WEEKLY',
    month: 'MONTHLY',
    year: 'YEARLY'
  };

  const freq = freqMap[recurring.type];
  if (!freq) return null;

  let rrule = `FREQ=${freq};INTERVAL=${recurring.interval}`;

  // Add termination condition
  if (recurring.duration === 'count' && recurring.count) {
    rrule += `;COUNT=${recurring.count}`;
  } else if (recurring.duration === 'until' && recurring.until) {
    // Convert YYYY-MM-DD to iCal format YYYYMMDDTHHMMSSZ
    const untilDate = recurring.until.replace(/-/g, '');
    rrule += `;UNTIL=${untilDate}T235959Z`;
  }
  // 'forever' duration = no COUNT or UNTIL

  return rrule;
}

/**
 * Convert a BNDY event to iCal VEVENT format (for ics library).
 *
 * @param {Object} event - BNDY event object
 * @returns {Object} - Event object for ics library
 */
function eventToVEvent(event) {
  const { year, month, day } = parseDate(event.date);
  const uid = generateEventUid(event);

  const vevent = {
    uid,
    title: event.title || 'Event',
    status: 'CONFIRMED'
  };

  // Handle all-day events
  if (event.isAllDay || !event.startTime) {
    vevent.start = [year, month, day];

    if (event.endDate) {
      // iCal all-day events: end date is exclusive (day AFTER last day)
      const endDate = parseDate(event.endDate);
      // Add 1 day to make it exclusive
      const endDateObj = new Date(endDate.year, endDate.month - 1, endDate.day + 1);
      vevent.end = [
        endDateObj.getFullYear(),
        endDateObj.getMonth() + 1,
        endDateObj.getDate()
      ];
    } else {
      // Single all-day event: end is next day
      const endDateObj = new Date(year, month - 1, day + 1);
      vevent.end = [
        endDateObj.getFullYear(),
        endDateObj.getMonth() + 1,
        endDateObj.getDate()
      ];
    }
  } else {
    // Timed event
    const startTime = parseTime(event.startTime);
    vevent.start = [year, month, day, startTime.hours, startTime.minutes];

    if (event.endTime) {
      const endTime = parseTime(event.endTime);
      const startMinutes = startTime.hours * 60 + startTime.minutes;
      const endMinutes = endTime.hours * 60 + endTime.minutes;

      // Handle events that cross midnight (e.g., 21:00 to 00:30)
      // These are still single-day events visually - cap at 23:59 to avoid 2-day display
      if (endMinutes <= startMinutes) {
        // End time is technically next day, but show as same day ending at 23:59
        vevent.end = [year, month, day, 23, 59];
      } else {
        vevent.end = [year, month, day, endTime.hours, endTime.minutes];
      }
    } else {
      // Default to 1 hour duration if no end time
      vevent.duration = { hours: 1 };
    }
  }

  // Optional fields
  if (event.location) {
    vevent.location = event.location;
  }

  if (event.notes) {
    vevent.description = event.notes;
  }

  // Add RRULE for recurring events
  if (event.recurring) {
    const rrule = recurringToRRule(event.recurring);
    if (rrule) {
      vevent.recurrenceRule = rrule;
    }
  }

  return vevent;
}

/**
 * Convert a cancellation record to iCal VEVENT with CANCELLED status.
 *
 * @param {Object} cancellation - Cancellation record from DynamoDB
 * @returns {Object} - Event object for ics library with CANCELLED status
 */
function cancellationToVEvent(cancellation) {
  const { year, month, day } = parseDate(cancellation.eventDate);

  return {
    uid: cancellation.eventUid,
    title: `CANCELLED: ${cancellation.eventTitle}`,
    start: [year, month, day],
    status: 'CANCELLED',
    method: 'CANCEL',
    sequence: 1 // Sequence number must be > 0 for cancellations
  };
}

/**
 * Generate a complete iCal calendar feed.
 *
 * @param {Array} events - Array of BNDY event objects
 * @param {Array} cancellations - Array of cancellation records
 * @param {string} calendarName - Name for the calendar (X-WR-CALNAME)
 * @returns {string} - Complete iCal calendar string
 */
function generateIcalFeed(events, cancellations, calendarName) {
  // Convert all events to ics format
  const vevents = events.map(eventToVEvent);

  // Add cancellation events
  const cancelVevents = cancellations.map(cancellationToVEvent);

  const allEvents = [...vevents, ...cancelVevents];

  // If no events, generate minimal calendar
  if (allEvents.length === 0) {
    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//BNDY//Calendar//EN',
      `X-WR-CALNAME:${calendarName}`,
      'END:VCALENDAR'
    ].join('\r\n');
  }

  // Use ics library to generate the calendar
  const { error, value } = ics.createEvents(allEvents, {
    productId: '-//BNDY//Calendar//EN'
  });

  if (error) {
    console.error('Error generating iCal:', error);
    // Return minimal calendar on error
    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//BNDY//Calendar//EN',
      `X-WR-CALNAME:${calendarName}`,
      'END:VCALENDAR'
    ].join('\r\n');
  }

  // Inject calendar name after VERSION line
  const lines = value.split('\r\n');
  const versionIndex = lines.findIndex(line => line.startsWith('VERSION:'));
  if (versionIndex !== -1) {
    lines.splice(versionIndex + 1, 0, `X-WR-CALNAME:${calendarName}`);
  }

  return lines.join('\r\n');
}

module.exports = {
  generateEventUid,
  eventToVEvent,
  cancellationToVEvent,
  recurringToRRule,
  generateIcalFeed
};
