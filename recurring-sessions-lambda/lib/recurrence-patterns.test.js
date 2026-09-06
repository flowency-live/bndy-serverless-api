/**
 * Recurrence Pattern Validation Tests
 *
 * TDD: These tests define the expected behaviour of RecurrencePattern validation
 * based on the design document section 9.2.
 */

const {
  validateRecurrencePattern,
  VALID_FREQUENCIES,
  WEEKDAYS
} = require('./recurrence-patterns');

describe('RecurrencePattern validation', () => {
  describe('basic validation', () => {
    test('rejects null pattern', () => {
      expect(validateRecurrencePattern(null)).toBe('recurrence pattern must be an object');
    });

    test('rejects undefined pattern', () => {
      expect(validateRecurrencePattern(undefined)).toBe('recurrence pattern must be an object');
    });

    test('rejects non-object pattern', () => {
      expect(validateRecurrencePattern('weekly')).toBe('recurrence pattern must be an object');
    });

    test('rejects empty object', () => {
      expect(validateRecurrencePattern({})).toMatch(/frequency must be one of/);
    });

    test('rejects invalid frequency', () => {
      expect(validateRecurrencePattern({ frequency: 'daily' })).toMatch(/frequency must be one of/);
    });
  });

  describe('weekly patterns', () => {
    test('valid weekly pattern passes', () => {
      const pattern = {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: ['tuesday']
      };
      expect(validateRecurrencePattern(pattern)).toBeNull();
    });

    test('valid weekly pattern with multiple days passes', () => {
      const pattern = {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: ['monday', 'wednesday', 'friday']
      };
      expect(validateRecurrencePattern(pattern)).toBeNull();
    });

    test('valid fortnightly pattern passes', () => {
      const pattern = {
        frequency: 'weekly',
        interval: 2,
        daysOfWeek: ['thursday']
      };
      expect(validateRecurrencePattern(pattern)).toBeNull();
    });

    test('interval 3 (every 3 weeks) passes', () => {
      const pattern = {
        frequency: 'weekly',
        interval: 3,
        daysOfWeek: ['saturday']
      };
      expect(validateRecurrencePattern(pattern)).toBeNull();
    });

    test('interval 4 (every 4 weeks) passes', () => {
      const pattern = {
        frequency: 'weekly',
        interval: 4,
        daysOfWeek: ['sunday']
      };
      expect(validateRecurrencePattern(pattern)).toBeNull();
    });

    test('interval 0 is rejected', () => {
      const pattern = {
        frequency: 'weekly',
        interval: 0,
        daysOfWeek: ['monday']
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/interval must be 1-4/);
    });

    test('interval 5 is rejected', () => {
      const pattern = {
        frequency: 'weekly',
        interval: 5,
        daysOfWeek: ['monday']
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/interval must be 1-4/);
    });

    test('interval must be a number', () => {
      const pattern = {
        frequency: 'weekly',
        interval: 'two',
        daysOfWeek: ['monday']
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/interval must be 1-4/);
    });

    test('daysOfWeek must be non-empty array', () => {
      const pattern = {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: []
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/daysOfWeek must be non-empty array/);
    });

    test('daysOfWeek must be an array', () => {
      const pattern = {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: 'monday'
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/daysOfWeek must be non-empty array/);
    });

    test('rejects invalid weekday names', () => {
      const pattern = {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: ['tueday']  // typo
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/invalid weekday/);
    });

    test('accepts case-insensitive weekday names', () => {
      const pattern = {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: ['TUESDAY', 'Wednesday']
      };
      expect(validateRecurrencePattern(pattern)).toBeNull();
    });
  });

  describe('monthly_by_weekday patterns', () => {
    test('valid first Tuesday pattern passes', () => {
      const pattern = {
        frequency: 'monthly_by_weekday',
        interval: 1,
        ordinal: 1,
        weekday: 'tuesday'
      };
      expect(validateRecurrencePattern(pattern)).toBeNull();
    });

    test('valid second Wednesday pattern passes', () => {
      const pattern = {
        frequency: 'monthly_by_weekday',
        interval: 1,
        ordinal: 2,
        weekday: 'wednesday'
      };
      expect(validateRecurrencePattern(pattern)).toBeNull();
    });

    test('valid third Friday pattern passes', () => {
      const pattern = {
        frequency: 'monthly_by_weekday',
        interval: 1,
        ordinal: 3,
        weekday: 'friday'
      };
      expect(validateRecurrencePattern(pattern)).toBeNull();
    });

    test('valid fourth Sunday pattern passes', () => {
      const pattern = {
        frequency: 'monthly_by_weekday',
        interval: 1,
        ordinal: 4,
        weekday: 'sunday'
      };
      expect(validateRecurrencePattern(pattern)).toBeNull();
    });

    test('valid last Saturday pattern (ordinal -1) passes', () => {
      const pattern = {
        frequency: 'monthly_by_weekday',
        interval: 1,
        ordinal: -1,
        weekday: 'saturday'
      };
      expect(validateRecurrencePattern(pattern)).toBeNull();
    });

    test('ordinal 0 is rejected', () => {
      const pattern = {
        frequency: 'monthly_by_weekday',
        interval: 1,
        ordinal: 0,
        weekday: 'monday'
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/ordinal must be 1-4 or -1/);
    });

    test('ordinal 5 is rejected', () => {
      const pattern = {
        frequency: 'monthly_by_weekday',
        interval: 1,
        ordinal: 5,
        weekday: 'monday'
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/ordinal must be 1-4 or -1/);
    });

    test('ordinal -2 is rejected', () => {
      const pattern = {
        frequency: 'monthly_by_weekday',
        interval: 1,
        ordinal: -2,
        weekday: 'monday'
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/ordinal must be 1-4 or -1/);
    });

    test('weekday is required', () => {
      const pattern = {
        frequency: 'monthly_by_weekday',
        interval: 1,
        ordinal: 1
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/weekday is required/);
    });

    test('rejects invalid weekday', () => {
      const pattern = {
        frequency: 'monthly_by_weekday',
        interval: 1,
        ordinal: 1,
        weekday: 'fryday'
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/invalid weekday/);
    });

    test('interval must be 1 for monthly_by_weekday', () => {
      const pattern = {
        frequency: 'monthly_by_weekday',
        interval: 2,
        ordinal: 1,
        weekday: 'monday'
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/interval must be 1 for monthly patterns/);
    });
  });

  describe('monthly_by_date patterns', () => {
    test('valid day 1 pattern passes', () => {
      const pattern = {
        frequency: 'monthly_by_date',
        interval: 1,
        dayOfMonth: 1
      };
      expect(validateRecurrencePattern(pattern)).toBeNull();
    });

    test('valid day 15 pattern passes', () => {
      const pattern = {
        frequency: 'monthly_by_date',
        interval: 1,
        dayOfMonth: 15
      };
      expect(validateRecurrencePattern(pattern)).toBeNull();
    });

    test('valid day 28 pattern passes', () => {
      const pattern = {
        frequency: 'monthly_by_date',
        interval: 1,
        dayOfMonth: 28
      };
      expect(validateRecurrencePattern(pattern)).toBeNull();
    });

    test('day 0 is rejected', () => {
      const pattern = {
        frequency: 'monthly_by_date',
        interval: 1,
        dayOfMonth: 0
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/dayOfMonth must be 1-28/);
    });

    test('day 29 is rejected (February safety)', () => {
      const pattern = {
        frequency: 'monthly_by_date',
        interval: 1,
        dayOfMonth: 29
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/dayOfMonth must be 1-28/);
    });

    test('day 30 is rejected', () => {
      const pattern = {
        frequency: 'monthly_by_date',
        interval: 1,
        dayOfMonth: 30
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/dayOfMonth must be 1-28/);
    });

    test('day 31 is rejected', () => {
      const pattern = {
        frequency: 'monthly_by_date',
        interval: 1,
        dayOfMonth: 31
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/dayOfMonth must be 1-28/);
    });

    test('dayOfMonth must be a number', () => {
      const pattern = {
        frequency: 'monthly_by_date',
        interval: 1,
        dayOfMonth: 'fifteen'
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/dayOfMonth must be 1-28/);
    });

    test('interval must be 1 for monthly_by_date', () => {
      const pattern = {
        frequency: 'monthly_by_date',
        interval: 2,
        dayOfMonth: 15
      };
      expect(validateRecurrencePattern(pattern)).toMatch(/interval must be 1 for monthly patterns/);
    });
  });

  describe('VALID_FREQUENCIES export', () => {
    test('contains expected frequencies', () => {
      expect(VALID_FREQUENCIES).toContain('weekly');
      expect(VALID_FREQUENCIES).toContain('monthly_by_weekday');
      expect(VALID_FREQUENCIES).toContain('monthly_by_date');
      expect(VALID_FREQUENCIES).toHaveLength(3);
    });
  });

  describe('WEEKDAYS export', () => {
    test('contains all seven days', () => {
      expect(WEEKDAYS).toContain('monday');
      expect(WEEKDAYS).toContain('tuesday');
      expect(WEEKDAYS).toContain('wednesday');
      expect(WEEKDAYS).toContain('thursday');
      expect(WEEKDAYS).toContain('friday');
      expect(WEEKDAYS).toContain('saturday');
      expect(WEEKDAYS).toContain('sunday');
      expect(WEEKDAYS).toHaveLength(7);
    });
  });
});
