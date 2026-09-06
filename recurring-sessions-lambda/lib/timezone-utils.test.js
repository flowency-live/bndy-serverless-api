/**
 * Timezone Utilities Tests
 *
 * TDD: These tests define the expected behaviour of timezone and DST handling.
 * Key principle: All times are stored as LOCAL to the venue's timezone.
 */

const {
  validateTimezone,
  localToUTC,
  utcToLocal,
  extractLocalTime,
  extractLocalDate
} = require('./timezone-utils');

describe('Timezone validation', () => {
  describe('validateTimezone', () => {
    test('accepts valid Europe/London timezone', () => {
      expect(validateTimezone('Europe/London')).toBeNull();
    });

    test('accepts valid America/New_York timezone', () => {
      expect(validateTimezone('America/New_York')).toBeNull();
    });

    test('accepts valid Europe/Paris timezone', () => {
      expect(validateTimezone('Europe/Paris')).toBeNull();
    });

    test('accepts valid Australia/Sydney timezone', () => {
      expect(validateTimezone('Australia/Sydney')).toBeNull();
    });

    test('accepts UTC', () => {
      expect(validateTimezone('UTC')).toBeNull();
    });

    test('rejects null', () => {
      expect(validateTimezone(null)).toBe('timezone is required');
    });

    test('rejects undefined', () => {
      expect(validateTimezone(undefined)).toBe('timezone is required');
    });

    test('rejects empty string', () => {
      expect(validateTimezone('')).toBe('timezone is required');
    });

    test('rejects invalid timezone string', () => {
      expect(validateTimezone('Invalid/Zone')).toBe('invalid IANA timezone');
    });

    test('rejects GMT offset format', () => {
      expect(validateTimezone('GMT+1')).toBe('invalid IANA timezone');
    });

    test('rejects UTC offset format', () => {
      expect(validateTimezone('UTC+00:00')).toBe('invalid IANA timezone');
    });

    test('rejects non-IANA timezone strings', () => {
      // Note: Some abbreviated timezone names (BST, EST) may be accepted
      // by Intl.DateTimeFormat in some Node.js versions. We test clearly invalid values.
      expect(validateTimezone('NotATimezone')).toBe('invalid IANA timezone');
      expect(validateTimezone('Europe')).toBe('invalid IANA timezone');
      expect(validateTimezone('Mars/Olympus')).toBe('invalid IANA timezone');
    });
  });
});

describe('DST handling for Europe/London', () => {
  describe('localToUTC', () => {
    test('converts winter time (GMT) correctly', () => {
      // January 15, 2026 at 19:00 GMT = 19:00 UTC
      const utc = localToUTC('2026-01-15', '19:00', 'Europe/London');
      expect(utc).toBe('2026-01-15T19:00:00.000Z');
    });

    test('converts summer time (BST) correctly', () => {
      // July 15, 2026 at 19:00 BST = 18:00 UTC
      const utc = localToUTC('2026-07-15', '19:00', 'Europe/London');
      expect(utc).toBe('2026-07-15T18:00:00.000Z');
    });

    test('handles spring forward (March 29, 2026)', () => {
      // BST starts: clocks go forward 1 hour at 01:00 GMT -> 02:00 BST
      // 02:30 BST on March 29 = 01:30 UTC
      const utc = localToUTC('2026-03-29', '02:30', 'Europe/London');
      expect(utc).toBe('2026-03-29T01:30:00.000Z');
    });

    test('handles fall back (October 25, 2026) - ambiguous time', () => {
      // BST ends: clocks go back 1 hour at 02:00 BST -> 01:00 GMT
      // 01:30 on October 25 occurs twice (BST and GMT)
      // The Intl API may return either occurrence. We verify it returns a valid result.
      // 01:30 BST = 00:30 UTC, 01:30 GMT = 01:30 UTC
      const utc = localToUTC('2026-10-25', '01:30', 'Europe/London');
      // Should be one of the two valid results
      expect(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']).toContain(utc);
    });

    test('preserves advertised local time across DST boundary', () => {
      // A session at 19:00 local should be 19:00 local after DST change
      const beforeDST = localToUTC('2026-10-24', '19:00', 'Europe/London'); // Still BST
      const afterDST = localToUTC('2026-10-26', '19:00', 'Europe/London');  // Now GMT

      // Both should be 19:00 local, but different UTC
      expect(beforeDST).toBe('2026-10-24T18:00:00.000Z'); // BST: -1 hour
      expect(afterDST).toBe('2026-10-26T19:00:00.000Z');  // GMT: same as UTC
    });
  });

  describe('utcToLocal', () => {
    test('converts UTC to winter time correctly', () => {
      const local = utcToLocal('2026-01-15T19:00:00.000Z', 'Europe/London');
      expect(local.date).toBe('2026-01-15');
      expect(local.time).toBe('19:00');
    });

    test('converts UTC to summer time correctly', () => {
      const local = utcToLocal('2026-07-15T18:00:00.000Z', 'Europe/London');
      expect(local.date).toBe('2026-07-15');
      expect(local.time).toBe('19:00'); // BST is UTC+1
    });
  });

  describe('extractLocalTime', () => {
    test('extracts time from UTC in winter', () => {
      expect(extractLocalTime('2026-01-15T19:00:00.000Z', 'Europe/London')).toBe('19:00');
    });

    test('extracts time from UTC in summer', () => {
      expect(extractLocalTime('2026-07-15T18:00:00.000Z', 'Europe/London')).toBe('19:00');
    });
  });

  describe('extractLocalDate', () => {
    test('extracts date from UTC', () => {
      expect(extractLocalDate('2026-07-15T23:30:00.000Z', 'Europe/London')).toBe('2026-07-16');
      // 23:30 UTC on July 15 = 00:30 BST on July 16
    });

    test('handles date boundary in winter', () => {
      expect(extractLocalDate('2026-01-15T23:30:00.000Z', 'Europe/London')).toBe('2026-01-15');
      // 23:30 UTC = 23:30 GMT (same date)
    });
  });
});

describe('Other timezones', () => {
  test('America/New_York winter (EST = UTC-5)', () => {
    const utc = localToUTC('2026-01-15', '19:00', 'America/New_York');
    expect(utc).toBe('2026-01-16T00:00:00.000Z'); // 19:00 EST = 00:00 UTC next day
  });

  test('America/New_York summer (EDT = UTC-4)', () => {
    const utc = localToUTC('2026-07-15', '19:00', 'America/New_York');
    expect(utc).toBe('2026-07-15T23:00:00.000Z'); // 19:00 EDT = 23:00 UTC
  });

  test('Europe/Paris winter (CET = UTC+1)', () => {
    const utc = localToUTC('2026-01-15', '19:00', 'Europe/Paris');
    expect(utc).toBe('2026-01-15T18:00:00.000Z');
  });

  test('UTC timezone returns same time', () => {
    const utc = localToUTC('2026-01-15', '19:00', 'UTC');
    expect(utc).toBe('2026-01-15T19:00:00.000Z');
  });
});
