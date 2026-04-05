/**
 * iCal Generator Tests
 *
 * Tests for RFC 5545 compliant iCal generation including:
 * - Single event VEVENT conversion
 * - Recurring events with RRULE
 * - Cancellation events (METHOD:CANCEL)
 * - Full calendar feed generation
 */

const {
  eventToVEvent,
  cancellationToVEvent,
  recurringToRRule,
  generateIcalFeed,
  generateEventUid
} = require('./ical-generator');

describe('ical-generator', () => {
  describe('generateEventUid', () => {
    it('should generate a consistent UID for an event', () => {
      const event = { id: 'event-123', artistId: 'artist-456' };
      const uid = generateEventUid(event);

      expect(uid).toBe('event-123@bndy.co.uk');
    });

    it('should use ownerUserId if no artistId', () => {
      const event = { id: 'event-789', ownerUserId: 'user-001' };
      const uid = generateEventUid(event);

      expect(uid).toBe('event-789@bndy.co.uk');
    });
  });

  describe('eventToVEvent', () => {
    it('should convert a basic gig event to iCal format', () => {
      const event = {
        id: 'gig-001',
        artistId: 'artist-123',
        type: 'gig',
        title: 'Live at The Blue Note',
        date: '2025-06-15',
        startTime: '20:00',
        endTime: '23:00',
        location: 'The Blue Note, Bristol',
        isPublic: true,
        createdAt: '2025-01-01T10:00:00Z',
        updatedAt: '2025-01-01T10:00:00Z'
      };

      const vevent = eventToVEvent(event);

      expect(vevent).toMatchObject({
        uid: 'gig-001@bndy.co.uk',
        title: 'Live at The Blue Note',
        start: [2025, 6, 15, 20, 0],
        end: [2025, 6, 15, 23, 0],
        location: 'The Blue Note, Bristol',
        status: 'CONFIRMED'
      });
    });

    it('should handle all-day events correctly', () => {
      const event = {
        id: 'unavail-001',
        ownerUserId: 'user-123',
        type: 'unavailable',
        title: 'Holiday',
        date: '2025-07-01',
        endDate: '2025-07-07',
        isAllDay: true,
        isPublic: false,
        createdAt: '2025-01-01T10:00:00Z',
        updatedAt: '2025-01-01T10:00:00Z'
      };

      const vevent = eventToVEvent(event);

      expect(vevent).toMatchObject({
        uid: 'unavail-001@bndy.co.uk',
        title: 'Holiday',
        start: [2025, 7, 1],
        end: [2025, 7, 8], // iCal all-day events end on day AFTER last day
        status: 'CONFIRMED'
      });
    });

    it('should handle events without endTime by defaulting to 1 hour duration', () => {
      const event = {
        id: 'rehearsal-001',
        artistId: 'artist-123',
        type: 'practice',
        title: 'Band Rehearsal',
        date: '2025-05-20',
        startTime: '19:00',
        isPublic: false,
        createdAt: '2025-01-01T10:00:00Z',
        updatedAt: '2025-01-01T10:00:00Z'
      };

      const vevent = eventToVEvent(event);

      expect(vevent).toMatchObject({
        uid: 'rehearsal-001@bndy.co.uk',
        title: 'Band Rehearsal',
        start: [2025, 5, 20, 19, 0],
        duration: { hours: 1 }
      });
    });

    it('should include description from notes field', () => {
      const event = {
        id: 'gig-002',
        artistId: 'artist-123',
        type: 'gig',
        title: 'Festival Set',
        date: '2025-08-15',
        startTime: '16:00',
        notes: 'Main stage, 45 min set. Soundcheck at 2pm.',
        isPublic: true,
        createdAt: '2025-01-01T10:00:00Z',
        updatedAt: '2025-01-01T10:00:00Z'
      };

      const vevent = eventToVEvent(event);

      expect(vevent.description).toBe('Main stage, 45 min set. Soundcheck at 2pm.');
    });
  });

  describe('recurringToRRule', () => {
    it('should convert weekly recurring with no end', () => {
      const recurring = {
        type: 'week',
        interval: 1,
        duration: 'forever'
      };

      const rrule = recurringToRRule(recurring);

      expect(rrule).toBe('FREQ=WEEKLY;INTERVAL=1');
    });

    it('should convert bi-weekly recurring with count', () => {
      const recurring = {
        type: 'week',
        interval: 2,
        duration: 'count',
        count: 10
      };

      const rrule = recurringToRRule(recurring);

      expect(rrule).toBe('FREQ=WEEKLY;INTERVAL=2;COUNT=10');
    });

    it('should convert monthly recurring with until date', () => {
      const recurring = {
        type: 'month',
        interval: 1,
        duration: 'until',
        until: '2025-12-31'
      };

      const rrule = recurringToRRule(recurring);

      expect(rrule).toBe('FREQ=MONTHLY;INTERVAL=1;UNTIL=20251231T235959Z');
    });

    it('should convert daily recurring', () => {
      const recurring = {
        type: 'day',
        interval: 1,
        duration: 'count',
        count: 5
      };

      const rrule = recurringToRRule(recurring);

      expect(rrule).toBe('FREQ=DAILY;INTERVAL=1;COUNT=5');
    });

    it('should convert yearly recurring', () => {
      const recurring = {
        type: 'year',
        interval: 1,
        duration: 'forever'
      };

      const rrule = recurringToRRule(recurring);

      expect(rrule).toBe('FREQ=YEARLY;INTERVAL=1');
    });

    it('should return null for events without recurring', () => {
      const rrule = recurringToRRule(null);
      expect(rrule).toBeNull();
    });
  });

  describe('cancellationToVEvent', () => {
    it('should generate a METHOD:CANCEL VEVENT for cancellation', () => {
      const cancellation = {
        eventUid: 'gig-001@bndy.co.uk',
        eventId: 'gig-001',
        eventTitle: 'Live at The Blue Note',
        eventDate: '2025-06-15',
        canceledAt: '2025-06-10T15:30:00Z',
        canceledBy: 'user-123'
      };

      const vevent = cancellationToVEvent(cancellation);

      expect(vevent).toMatchObject({
        uid: 'gig-001@bndy.co.uk',
        title: 'CANCELLED: Live at The Blue Note',
        start: [2025, 6, 15],
        status: 'CANCELLED',
        method: 'CANCEL',
        sequence: 1
      });
    });
  });

  describe('generateIcalFeed', () => {
    it('should generate a valid iCal calendar string', () => {
      const events = [
        {
          id: 'gig-001',
          artistId: 'artist-123',
          type: 'gig',
          title: 'Live Show',
          date: '2025-06-15',
          startTime: '20:00',
          endTime: '23:00',
          isPublic: true,
          createdAt: '2025-01-01T10:00:00Z',
          updatedAt: '2025-01-01T10:00:00Z'
        }
      ];
      const cancellations = [];
      const calendarName = 'My Band Calendar';

      const ical = generateIcalFeed(events, cancellations, calendarName);

      expect(ical).toContain('BEGIN:VCALENDAR');
      expect(ical).toContain('VERSION:2.0');
      expect(ical).toContain('PRODID:-//BNDY//Calendar//EN');
      expect(ical).toContain('X-WR-CALNAME:My Band Calendar');
      expect(ical).toContain('BEGIN:VEVENT');
      expect(ical).toContain('UID:gig-001@bndy.co.uk');
      expect(ical).toContain('SUMMARY:Live Show');
      expect(ical).toContain('END:VEVENT');
      expect(ical).toContain('END:VCALENDAR');
    });

    it('should include cancellation events in the feed', () => {
      const events = [];
      const cancellations = [
        {
          eventUid: 'gig-002@bndy.co.uk',
          eventId: 'gig-002',
          eventTitle: 'Cancelled Gig',
          eventDate: '2025-07-20',
          canceledAt: '2025-07-15T12:00:00Z',
          canceledBy: 'user-456'
        }
      ];
      const calendarName = 'Test Calendar';

      const ical = generateIcalFeed(events, cancellations, calendarName);

      expect(ical).toContain('STATUS:CANCELLED');
      expect(ical).toContain('SUMMARY:CANCELLED: Cancelled Gig');
    });

    it('should handle recurring events with RRULE', () => {
      const events = [
        {
          id: 'rehearsal-001',
          artistId: 'artist-123',
          type: 'practice',
          title: 'Weekly Rehearsal',
          date: '2025-05-01',
          startTime: '19:00',
          endTime: '21:00',
          isPublic: false,
          recurring: {
            type: 'week',
            interval: 1,
            duration: 'count',
            count: 12
          },
          createdAt: '2025-01-01T10:00:00Z',
          updatedAt: '2025-01-01T10:00:00Z'
        }
      ];
      const cancellations = [];
      const calendarName = 'Rehearsal Calendar';

      const ical = generateIcalFeed(events, cancellations, calendarName);

      expect(ical).toContain('RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=12');
    });

    it('should generate empty calendar when no events', () => {
      const ical = generateIcalFeed([], [], 'Empty Calendar');

      expect(ical).toContain('BEGIN:VCALENDAR');
      expect(ical).toContain('END:VCALENDAR');
      expect(ical).not.toContain('BEGIN:VEVENT');
    });

    it('should handle multiple events and cancellations', () => {
      const events = [
        {
          id: 'gig-001',
          artistId: 'artist-123',
          type: 'gig',
          title: 'Gig 1',
          date: '2025-06-01',
          startTime: '20:00',
          isPublic: true,
          createdAt: '2025-01-01T10:00:00Z',
          updatedAt: '2025-01-01T10:00:00Z'
        },
        {
          id: 'gig-002',
          artistId: 'artist-123',
          type: 'gig',
          title: 'Gig 2',
          date: '2025-06-15',
          startTime: '21:00',
          isPublic: true,
          createdAt: '2025-01-01T10:00:00Z',
          updatedAt: '2025-01-01T10:00:00Z'
        }
      ];
      const cancellations = [
        {
          eventUid: 'gig-003@bndy.co.uk',
          eventId: 'gig-003',
          eventTitle: 'Cancelled Gig',
          eventDate: '2025-06-30',
          canceledAt: '2025-06-25T10:00:00Z',
          canceledBy: 'user-123'
        }
      ];

      const ical = generateIcalFeed(events, cancellations, 'Mixed Calendar');

      // Count VEVENT occurrences
      const veventCount = (ical.match(/BEGIN:VEVENT/g) || []).length;
      expect(veventCount).toBe(3); // 2 events + 1 cancellation
    });
  });

  describe('edge cases', () => {
    it('should handle events with special characters in title', () => {
      const event = {
        id: 'gig-special',
        artistId: 'artist-123',
        type: 'gig',
        title: 'Rock & Roll: The "Best" Show!',
        date: '2025-06-15',
        startTime: '20:00',
        isPublic: true,
        createdAt: '2025-01-01T10:00:00Z',
        updatedAt: '2025-01-01T10:00:00Z'
      };

      const vevent = eventToVEvent(event);

      // The ics library should handle escaping
      expect(vevent.title).toBe('Rock & Roll: The "Best" Show!');
    });

    it('should handle events with newlines in notes', () => {
      const event = {
        id: 'gig-notes',
        artistId: 'artist-123',
        type: 'gig',
        title: 'Show',
        date: '2025-06-15',
        startTime: '20:00',
        notes: 'Line 1\nLine 2\nLine 3',
        isPublic: true,
        createdAt: '2025-01-01T10:00:00Z',
        updatedAt: '2025-01-01T10:00:00Z'
      };

      const vevent = eventToVEvent(event);

      expect(vevent.description).toContain('Line 1');
    });

    it('should handle events without location', () => {
      const event = {
        id: 'rehearsal-noloc',
        artistId: 'artist-123',
        type: 'practice',
        title: 'Rehearsal',
        date: '2025-06-15',
        startTime: '19:00',
        isPublic: false,
        createdAt: '2025-01-01T10:00:00Z',
        updatedAt: '2025-01-01T10:00:00Z'
      };

      const vevent = eventToVEvent(event);

      expect(vevent.location).toBeUndefined();
    });

    it('should handle midnight events (00:00)', () => {
      const event = {
        id: 'late-gig',
        artistId: 'artist-123',
        type: 'gig',
        title: 'Midnight Show',
        date: '2025-06-15',
        startTime: '00:00',
        endTime: '02:00',
        isPublic: true,
        createdAt: '2025-01-01T10:00:00Z',
        updatedAt: '2025-01-01T10:00:00Z'
      };

      const vevent = eventToVEvent(event);

      expect(vevent.start).toEqual([2025, 6, 15, 0, 0]);
      expect(vevent.end).toEqual([2025, 6, 15, 2, 0]);
    });
  });
});
