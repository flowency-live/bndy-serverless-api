/**
 * RecurringSession Data Module Tests
 *
 * TDD: Tests for RecurringSession validation, lifecycle, and persistence.
 */

const {
  validateRecurringSession,
  validateLifecycleTransition,
  recurringSessionUniqueKey,
  normaliseSessionName,
  VALID_STATUSES,
  VALID_SESSION_TYPES,
  SCHEMA_VERSION
} = require('./recurring-session-data');

describe('RecurringSession validation', () => {
  describe('validateRecurringSession', () => {
    const validSession = {
      name: 'Tuesday Open Mic',
      venueId: 'venue-123',
      timezone: 'Europe/London',
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: ['tuesday']
      }
    };

    test('valid complete session passes', () => {
      expect(validateRecurringSession(validSession)).toBeNull();
    });

    test('valid session with all optional fields passes', () => {
      const fullSession = {
        ...validSession,
        sessionType: 'open_mic',
        description: 'Weekly open mic night',
        status: 'active',
        startsOn: '2026-09-01',
        endsOn: '2027-03-01',
        hostArtistIds: ['artist-1', 'artist-2'],
        hostDisplayNames: ['John Smith', 'Jane Doe']
      };
      expect(validateRecurringSession(fullSession)).toBeNull();
    });

    test('rejects null session', () => {
      expect(validateRecurringSession(null)).toBe('session must be an object');
    });

    test('rejects non-object session', () => {
      expect(validateRecurringSession('string')).toBe('session must be an object');
    });

    describe('name validation', () => {
      test('name is required', () => {
        const session = { ...validSession, name: undefined };
        expect(validateRecurringSession(session)).toMatch(/name is required/);
      });

      test('name cannot be empty string', () => {
        const session = { ...validSession, name: '' };
        expect(validateRecurringSession(session)).toMatch(/name is required/);
      });

      test('name cannot be only whitespace', () => {
        const session = { ...validSession, name: '   ' };
        expect(validateRecurringSession(session)).toMatch(/name is required/);
      });

      test('name must be a string', () => {
        const session = { ...validSession, name: 123 };
        expect(validateRecurringSession(session)).toMatch(/name is required/);
      });
    });

    describe('venueId validation', () => {
      test('venueId is required', () => {
        const session = { ...validSession, venueId: undefined };
        expect(validateRecurringSession(session)).toMatch(/venueId is required/);
      });

      test('venueId must be a string', () => {
        const session = { ...validSession, venueId: 123 };
        expect(validateRecurringSession(session)).toMatch(/venueId is required/);
      });
    });

    describe('timezone validation', () => {
      test('timezone is required', () => {
        const session = { ...validSession, timezone: undefined };
        expect(validateRecurringSession(session)).toBe('timezone is required');
      });

      test('timezone must be valid IANA timezone', () => {
        const session = { ...validSession, timezone: 'Invalid/Zone' };
        expect(validateRecurringSession(session)).toBe('invalid IANA timezone');
      });
    });

    describe('recurrence validation', () => {
      test('recurrence is required', () => {
        const session = { ...validSession, recurrence: undefined };
        expect(validateRecurringSession(session)).toMatch(/recurrence is required/);
      });

      test('recurrence must be valid pattern', () => {
        const session = { ...validSession, recurrence: { frequency: 'invalid' } };
        expect(validateRecurringSession(session)).toMatch(/frequency must be one of/);
      });
    });

    describe('sessionType validation', () => {
      test('valid sessionType passes', () => {
        for (const type of VALID_SESSION_TYPES) {
          const session = { ...validSession, sessionType: type };
          expect(validateRecurringSession(session)).toBeNull();
        }
      });

      test('invalid sessionType is rejected', () => {
        const session = { ...validSession, sessionType: 'concert' };
        expect(validateRecurringSession(session)).toMatch(/sessionType must be one of/);
      });
    });

    describe('status validation', () => {
      test('valid status passes', () => {
        for (const status of VALID_STATUSES) {
          const session = { ...validSession, status };
          expect(validateRecurringSession(session)).toBeNull();
        }
      });

      test('invalid status is rejected', () => {
        const session = { ...validSession, status: 'running' };
        expect(validateRecurringSession(session)).toMatch(/status must be one of/);
      });
    });

    describe('date validation', () => {
      test('valid startsOn passes', () => {
        const session = { ...validSession, startsOn: '2026-09-01' };
        expect(validateRecurringSession(session)).toBeNull();
      });

      test('invalid startsOn format is rejected', () => {
        const session = { ...validSession, startsOn: '01/09/2026' };
        expect(validateRecurringSession(session)).toMatch(/startsOn must be YYYY-MM-DD/);
      });

      test('valid endsOn passes', () => {
        const session = { ...validSession, startsOn: '2026-09-01', endsOn: '2027-03-01' };
        expect(validateRecurringSession(session)).toBeNull();
      });

      test('invalid endsOn format is rejected', () => {
        const session = { ...validSession, endsOn: '2027-03-01T00:00:00Z' };
        expect(validateRecurringSession(session)).toMatch(/endsOn must be YYYY-MM-DD/);
      });

      test('endsOn must be after startsOn', () => {
        const session = { ...validSession, startsOn: '2026-09-01', endsOn: '2026-08-01' };
        expect(validateRecurringSession(session)).toMatch(/endsOn must be after startsOn/);
      });

      test('endsOn equal to startsOn is allowed', () => {
        const session = { ...validSession, startsOn: '2026-09-01', endsOn: '2026-09-01' };
        expect(validateRecurringSession(session)).toBeNull();
      });
    });

    describe('hostArtistIds validation', () => {
      test('hostArtistIds must be an array if present', () => {
        const session = { ...validSession, hostArtistIds: 'artist-1' };
        expect(validateRecurringSession(session)).toMatch(/hostArtistIds must be an array/);
      });

      test('hostArtistIds can be empty array', () => {
        const session = { ...validSession, hostArtistIds: [] };
        expect(validateRecurringSession(session)).toBeNull();
      });
    });
  });
});

describe('Lifecycle transitions', () => {
  describe('validateLifecycleTransition', () => {
    test('draft -> active is valid', () => {
      expect(validateLifecycleTransition('draft', 'active')).toBeNull();
    });

    test('active -> paused is valid', () => {
      expect(validateLifecycleTransition('active', 'paused')).toBeNull();
    });

    test('paused -> active is valid (resume)', () => {
      expect(validateLifecycleTransition('paused', 'active')).toBeNull();
    });

    test('active -> ended is valid', () => {
      expect(validateLifecycleTransition('active', 'ended')).toBeNull();
    });

    test('paused -> ended is valid', () => {
      expect(validateLifecycleTransition('paused', 'ended')).toBeNull();
    });

    test('active -> superseded is valid', () => {
      expect(validateLifecycleTransition('active', 'superseded')).toBeNull();
    });

    test('stale -> active is valid (reverification)', () => {
      expect(validateLifecycleTransition('stale', 'active')).toBeNull();
    });

    test('stale -> ended is valid', () => {
      expect(validateLifecycleTransition('stale', 'ended')).toBeNull();
    });

    test('ended -> active is invalid (terminal state)', () => {
      expect(validateLifecycleTransition('ended', 'active')).toMatch(/cannot transition from ended/);
    });

    test('superseded -> active is invalid (terminal state)', () => {
      expect(validateLifecycleTransition('superseded', 'active')).toMatch(/cannot transition from superseded/);
    });

    test('draft -> ended is invalid (must activate first)', () => {
      expect(validateLifecycleTransition('draft', 'ended')).toMatch(/cannot transition from draft to ended/);
    });

    test('draft -> superseded is invalid', () => {
      expect(validateLifecycleTransition('draft', 'superseded')).toMatch(/cannot transition from draft to superseded/);
    });
  });
});

describe('Unique key generation', () => {
  describe('recurringSessionUniqueKey', () => {
    test('generates key from venueId and normalised name', () => {
      const session = {
        venueId: 'venue-123',
        name: 'Tuesday Open Mic',
        recurrence: { frequency: 'weekly', interval: 1, daysOfWeek: ['tuesday'] }
      };
      const key = recurringSessionUniqueKey(session);
      expect(key).toBe('series#venue-123#tuesday open mic#tuesday');
    });

    test('normalises name for consistent keys', () => {
      const session1 = {
        venueId: 'venue-123',
        name: 'TUESDAY OPEN MIC',
        recurrence: { frequency: 'weekly', interval: 1, daysOfWeek: ['tuesday'] }
      };
      const session2 = {
        venueId: 'venue-123',
        name: '  tuesday   open   mic  ',
        recurrence: { frequency: 'weekly', interval: 1, daysOfWeek: ['tuesday'] }
      };
      expect(recurringSessionUniqueKey(session1)).toBe(recurringSessionUniqueKey(session2));
    });

    test('uses primary day from weekly pattern', () => {
      const session = {
        venueId: 'venue-123',
        name: 'Multi-Day Session',
        recurrence: { frequency: 'weekly', interval: 1, daysOfWeek: ['monday', 'wednesday'] }
      };
      const key = recurringSessionUniqueKey(session);
      expect(key).toContain('#monday');
    });

    test('uses weekday from monthly_by_weekday pattern', () => {
      const session = {
        venueId: 'venue-123',
        name: 'First Friday Folk',
        recurrence: { frequency: 'monthly_by_weekday', interval: 1, ordinal: 1, weekday: 'friday' }
      };
      const key = recurringSessionUniqueKey(session);
      expect(key).toContain('#friday');
    });

    test('uses empty day for monthly_by_date pattern', () => {
      const session = {
        venueId: 'venue-123',
        name: 'Fifteenth Night',
        recurrence: { frequency: 'monthly_by_date', interval: 1, dayOfMonth: 15 }
      };
      const key = recurringSessionUniqueKey(session);
      expect(key).toBe('series#venue-123#fifteenth night#');
    });
  });

  describe('normaliseSessionName', () => {
    test('converts to lowercase', () => {
      expect(normaliseSessionName('OPEN MIC')).toBe('open mic');
    });

    test('trims whitespace', () => {
      expect(normaliseSessionName('  open mic  ')).toBe('open mic');
    });

    test('collapses multiple spaces', () => {
      expect(normaliseSessionName('open    mic   night')).toBe('open mic night');
    });

    test('handles mixed case and spacing', () => {
      expect(normaliseSessionName('  TUESDAY  Open  MIC  ')).toBe('tuesday open mic');
    });
  });
});

describe('Constants', () => {
  describe('VALID_STATUSES', () => {
    test('contains all lifecycle statuses', () => {
      expect(VALID_STATUSES).toContain('draft');
      expect(VALID_STATUSES).toContain('active');
      expect(VALID_STATUSES).toContain('paused');
      expect(VALID_STATUSES).toContain('stale');
      expect(VALID_STATUSES).toContain('ended');
      expect(VALID_STATUSES).toContain('superseded');
      expect(VALID_STATUSES).toHaveLength(6);
    });
  });

  describe('VALID_SESSION_TYPES', () => {
    test('contains all session types', () => {
      expect(VALID_SESSION_TYPES).toContain('open_mic');
      expect(VALID_SESSION_TYPES).toContain('jam_session');
      expect(VALID_SESSION_TYPES).toContain('folk_session');
      expect(VALID_SESSION_TYPES).toContain('residency');
      expect(VALID_SESSION_TYPES).toContain('club_night');
      expect(VALID_SESSION_TYPES).toContain('other');
      expect(VALID_SESSION_TYPES).toHaveLength(6);
    });
  });

  describe('SCHEMA_VERSION', () => {
    test('is version 1', () => {
      expect(SCHEMA_VERSION).toBe(1);
    });
  });
});
