/**
 * Projector Tests
 *
 * Core logic for computing occurrences from a RecurringSession.
 */

const {
  computeOccurrencesInRange,
  computeNextOccurrence,
  PROJECTION_DEFAULTS
} = require('./projector');

describe('PROJECTION_DEFAULTS', () => {
  test('has 16 week horizon', () => {
    expect(PROJECTION_DEFAULTS.horizonWeeks).toBe(16);
  });

  test('has 26 occurrence cap', () => {
    expect(PROJECTION_DEFAULTS.maxOccurrences).toBe(26);
  });
});

describe('computeOccurrencesInRange - weekly patterns', () => {
  const baseSession = {
    id: 'rs_test',
    venueId: 'v_railway',
    timezone: 'Europe/London',
    name: 'Tuesday Open Mic',
    defaultStartTime: '19:00',
    startsOn: '2026-01-06', // First Tuesday
    status: 'active'
  };

  describe('weekly interval 1 (every week)', () => {
    const session = {
      ...baseSession,
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: [2] // Tuesday
      }
    };

    test('generates occurrences for single weekday', () => {
      const occurrences = computeOccurrencesInRange(
        session,
        '2026-01-01',
        '2026-01-31'
      );

      expect(occurrences).toHaveLength(4);
      expect(occurrences.map(o => o.scheduledLocalDate)).toEqual([
        '2026-01-06',
        '2026-01-13',
        '2026-01-20',
        '2026-01-27'
      ]);
    });

    test('includes occurrence on startDate if it matches', () => {
      const occurrences = computeOccurrencesInRange(
        session,
        '2026-01-06', // Start on a Tuesday
        '2026-01-12'
      );

      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].scheduledLocalDate).toBe('2026-01-06');
    });

    test('excludes occurrences before startsOn', () => {
      const occurrences = computeOccurrencesInRange(
        session,
        '2025-12-01',
        '2026-01-31'
      );

      // Should only include dates from startsOn onwards
      expect(occurrences[0].scheduledLocalDate).toBe('2026-01-06');
    });

    test('respects endsOn date', () => {
      const sessionWithEnd = {
        ...session,
        endsOn: '2026-01-20'
      };

      const occurrences = computeOccurrencesInRange(
        sessionWithEnd,
        '2026-01-01',
        '2026-01-31'
      );

      expect(occurrences).toHaveLength(3);
      expect(occurrences.map(o => o.scheduledLocalDate)).toEqual([
        '2026-01-06',
        '2026-01-13',
        '2026-01-20'
      ]);
    });
  });

  describe('weekly interval 2 (fortnightly)', () => {
    const session = {
      ...baseSession,
      recurrence: {
        frequency: 'weekly',
        interval: 2,
        daysOfWeek: [2] // Tuesday
      }
    };

    test('generates fortnightly occurrences anchored to startsOn', () => {
      const occurrences = computeOccurrencesInRange(
        session,
        '2026-01-01',
        '2026-02-28'
      );

      expect(occurrences.map(o => o.scheduledLocalDate)).toEqual([
        '2026-01-06',
        '2026-01-20',
        '2026-02-03',
        '2026-02-17'
      ]);
    });
  });

  describe('weekly with multiple weekdays', () => {
    const session = {
      ...baseSession,
      name: 'Weekend Sessions',
      startsOn: '2026-01-02', // Start on first Friday
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: [5, 6] // Friday and Saturday
      }
    };

    test('generates occurrences for multiple weekdays', () => {
      const occurrences = computeOccurrencesInRange(
        session,
        '2026-01-01',
        '2026-01-18'
      );

      expect(occurrences.map(o => o.scheduledLocalDate)).toEqual([
        '2026-01-02', // Friday
        '2026-01-03', // Saturday
        '2026-01-09', // Friday
        '2026-01-10', // Saturday
        '2026-01-16', // Friday
        '2026-01-17'  // Saturday
      ]);
    });
  });
});

describe('computeOccurrencesInRange - monthly_by_weekday', () => {
  const baseSession = {
    id: 'rs_monthly',
    venueId: 'v_venue',
    timezone: 'Europe/London',
    name: 'First Sunday Session',
    defaultStartTime: '14:00',
    startsOn: '2026-01-04', // First Sunday of Jan 2026
    status: 'active'
  };

  test('first weekday of month (ordinal 1)', () => {
    const session = {
      ...baseSession,
      recurrence: {
        frequency: 'monthly_by_weekday',
        ordinal: 1,
        weekday: 0 // Sunday
      }
    };

    const occurrences = computeOccurrencesInRange(
      session,
      '2026-01-01',
      '2026-04-30'
    );

    expect(occurrences.map(o => o.scheduledLocalDate)).toEqual([
      '2026-01-04', // First Sunday Jan
      '2026-02-01', // First Sunday Feb
      '2026-03-01', // First Sunday Mar
      '2026-04-05'  // First Sunday Apr
    ]);
  });

  test('second weekday of month (ordinal 2)', () => {
    const session = {
      ...baseSession,
      name: 'Second Tuesday',
      startsOn: '2026-01-13',
      recurrence: {
        frequency: 'monthly_by_weekday',
        ordinal: 2,
        weekday: 2 // Tuesday
      }
    };

    const occurrences = computeOccurrencesInRange(
      session,
      '2026-01-01',
      '2026-03-31'
    );

    expect(occurrences.map(o => o.scheduledLocalDate)).toEqual([
      '2026-01-13', // Second Tuesday Jan
      '2026-02-10', // Second Tuesday Feb
      '2026-03-10'  // Second Tuesday Mar
    ]);
  });

  test('last weekday of month (ordinal -1)', () => {
    const session = {
      ...baseSession,
      name: 'Last Friday',
      startsOn: '2026-01-30',
      recurrence: {
        frequency: 'monthly_by_weekday',
        ordinal: -1,
        weekday: 5 // Friday
      }
    };

    const occurrences = computeOccurrencesInRange(
      session,
      '2026-01-01',
      '2026-04-30'
    );

    expect(occurrences.map(o => o.scheduledLocalDate)).toEqual([
      '2026-01-30', // Last Friday Jan (31st is Sat)
      '2026-02-27', // Last Friday Feb
      '2026-03-27', // Last Friday Mar
      '2026-04-24'  // Last Friday Apr
    ]);
  });

  test('fourth weekday of month (ordinal 4)', () => {
    const session = {
      ...baseSession,
      name: 'Fourth Wednesday',
      startsOn: '2026-01-28',
      recurrence: {
        frequency: 'monthly_by_weekday',
        ordinal: 4,
        weekday: 3 // Wednesday
      }
    };

    const occurrences = computeOccurrencesInRange(
      session,
      '2026-01-01',
      '2026-03-31'
    );

    expect(occurrences.map(o => o.scheduledLocalDate)).toEqual([
      '2026-01-28', // Fourth Wednesday Jan
      '2026-02-25', // Fourth Wednesday Feb
      '2026-03-25'  // Fourth Wednesday Mar
    ]);
  });
});

describe('computeOccurrencesInRange - monthly_by_date', () => {
  const baseSession = {
    id: 'rs_monthly_date',
    venueId: 'v_venue',
    timezone: 'Europe/London',
    name: '15th of the Month',
    defaultStartTime: '20:00',
    startsOn: '2026-01-15',
    status: 'active'
  };

  test('generates on specific day of month', () => {
    const session = {
      ...baseSession,
      recurrence: {
        frequency: 'monthly_by_date',
        dayOfMonth: 15
      }
    };

    const occurrences = computeOccurrencesInRange(
      session,
      '2026-01-01',
      '2026-04-30'
    );

    expect(occurrences.map(o => o.scheduledLocalDate)).toEqual([
      '2026-01-15',
      '2026-02-15',
      '2026-03-15',
      '2026-04-15'
    ]);
  });

  test('day 28 works in all months including February', () => {
    const session = {
      ...baseSession,
      name: '28th Session',
      startsOn: '2026-01-28',
      recurrence: {
        frequency: 'monthly_by_date',
        dayOfMonth: 28
      }
    };

    const occurrences = computeOccurrencesInRange(
      session,
      '2026-01-01',
      '2026-04-30'
    );

    expect(occurrences.map(o => o.scheduledLocalDate)).toEqual([
      '2026-01-28',
      '2026-02-28', // Works in Feb (non-leap year)
      '2026-03-28',
      '2026-04-28'
    ]);
  });
});

describe('computeOccurrencesInRange - DST handling', () => {
  const baseSession = {
    id: 'rs_dst',
    venueId: 'v_venue',
    timezone: 'Europe/London',
    name: 'Weekly Session',
    defaultStartTime: '19:00',
    startsOn: '2026-03-01',
    status: 'active',
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      daysOfWeek: [0] // Sunday
    }
  };

  test('generates correct UTC times across spring DST (March 29)', () => {
    const occurrences = computeOccurrencesInRange(
      baseSession,
      '2026-03-22',
      '2026-04-05'
    );

    // March 22 is before DST (GMT), March 29 is DST transition, April 5 is BST
    expect(occurrences).toHaveLength(3);

    // Before DST: 19:00 local = 19:00 UTC
    expect(occurrences[0].scheduledLocalDate).toBe('2026-03-22');
    expect(occurrences[0].utcStart).toBe('2026-03-22T19:00:00.000Z');

    // DST transition day: 19:00 local = 18:00 UTC (BST)
    expect(occurrences[1].scheduledLocalDate).toBe('2026-03-29');
    expect(occurrences[1].utcStart).toBe('2026-03-29T18:00:00.000Z');

    // After DST: 19:00 local = 18:00 UTC (BST)
    expect(occurrences[2].scheduledLocalDate).toBe('2026-04-05');
    expect(occurrences[2].utcStart).toBe('2026-04-05T18:00:00.000Z');
  });

  test('generates correct UTC times across fall DST (October 25)', () => {
    const fallSession = {
      ...baseSession,
      startsOn: '2026-10-01'
    };

    const occurrences = computeOccurrencesInRange(
      fallSession,
      '2026-10-18',
      '2026-11-01'
    );

    expect(occurrences).toHaveLength(3);

    // Before DST ends: 19:00 local = 18:00 UTC (BST)
    expect(occurrences[0].scheduledLocalDate).toBe('2026-10-18');
    expect(occurrences[0].utcStart).toBe('2026-10-18T18:00:00.000Z');

    // DST transition day: 19:00 local = 19:00 UTC (GMT)
    expect(occurrences[1].scheduledLocalDate).toBe('2026-10-25');
    expect(occurrences[1].utcStart).toBe('2026-10-25T19:00:00.000Z');

    // After DST ends: 19:00 local = 19:00 UTC (GMT)
    expect(occurrences[2].scheduledLocalDate).toBe('2026-11-01');
    expect(occurrences[2].utcStart).toBe('2026-11-01T19:00:00.000Z');
  });

  test('advertised local time remains constant across DST', () => {
    const occurrences = computeOccurrencesInRange(
      baseSession,
      '2026-03-01',
      '2026-04-30'
    );

    // All occurrences should have the same local time
    occurrences.forEach(occ => {
      expect(occ.localTime).toBe('19:00');
    });
  });
});

describe('computeOccurrencesInRange - bounds and limits', () => {
  const session = {
    id: 'rs_bounds',
    venueId: 'v_venue',
    timezone: 'Europe/London',
    name: 'Daily Test',
    defaultStartTime: '19:00',
    startsOn: '2026-01-01',
    status: 'active',
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6] // Every day
    }
  };

  test('respects maxOccurrences limit', () => {
    const occurrences = computeOccurrencesInRange(
      session,
      '2026-01-01',
      '2026-12-31',
      { maxOccurrences: 10 }
    );

    expect(occurrences).toHaveLength(10);
  });

  test('uses default maxOccurrences of 26', () => {
    const occurrences = computeOccurrencesInRange(
      session,
      '2026-01-01',
      '2026-12-31'
    );

    expect(occurrences).toHaveLength(26);
  });

  test('returns empty array for inactive session', () => {
    const inactiveSession = {
      ...session,
      status: 'ended'
    };

    const occurrences = computeOccurrencesInRange(
      inactiveSession,
      '2026-01-01',
      '2026-01-31'
    );

    expect(occurrences).toHaveLength(0);
  });

  test('returns empty array when range is before startsOn', () => {
    const occurrences = computeOccurrencesInRange(
      session,
      '2025-01-01',
      '2025-12-31'
    );

    expect(occurrences).toHaveLength(0);
  });
});

describe('computeOccurrencesInRange - occurrence shape', () => {
  const session = {
    id: 'rs_shape',
    venueId: 'v_railway',
    timezone: 'Europe/London',
    name: 'Tuesday Open Mic',
    defaultStartTime: '19:00',
    defaultEndTime: '22:00',
    startsOn: '2026-01-06',
    status: 'active',
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      daysOfWeek: [2]
    }
  };

  test('occurrence includes all required fields', () => {
    const occurrences = computeOccurrencesInRange(
      session,
      '2026-01-01',
      '2026-01-10'
    );

    expect(occurrences).toHaveLength(1);

    const occ = occurrences[0];
    expect(occ).toMatchObject({
      occurrenceKey: 'rs_shape:2026-01-06',
      seriesId: 'rs_shape',
      scheduledLocalDate: '2026-01-06',
      localTime: '19:00',
      utcStart: '2026-01-06T19:00:00.000Z',
      venueId: 'v_railway',
      title: 'Tuesday Open Mic'
    });
  });

  test('includes optional endTime if provided', () => {
    const occurrences = computeOccurrencesInRange(
      session,
      '2026-01-01',
      '2026-01-10'
    );

    expect(occurrences[0].localEndTime).toBe('22:00');
  });
});

describe('computeNextOccurrence', () => {
  const session = {
    id: 'rs_next',
    venueId: 'v_venue',
    timezone: 'Europe/London',
    name: 'Weekly Session',
    defaultStartTime: '19:00',
    startsOn: '2026-01-06',
    status: 'active',
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      daysOfWeek: [2] // Tuesday
    }
  };

  test('returns next occurrence from given date', () => {
    const next = computeNextOccurrence(session, '2026-01-10');

    expect(next.scheduledLocalDate).toBe('2026-01-13');
  });

  test('returns occurrence on date if it matches', () => {
    const next = computeNextOccurrence(session, '2026-01-13');

    expect(next.scheduledLocalDate).toBe('2026-01-13');
  });

  test('returns null for ended session', () => {
    const endedSession = { ...session, status: 'ended' };

    const next = computeNextOccurrence(endedSession, '2026-01-10');

    expect(next).toBeNull();
  });

  test('returns null if after endsOn', () => {
    const sessionWithEnd = { ...session, endsOn: '2026-01-10' };

    const next = computeNextOccurrence(sessionWithEnd, '2026-01-11');

    expect(next).toBeNull();
  });
});

describe('idempotency property', () => {
  const session = {
    id: 'rs_idempotent',
    venueId: 'v_venue',
    timezone: 'Europe/London',
    name: 'Test Session',
    defaultStartTime: '19:00',
    startsOn: '2026-01-01',
    status: 'active',
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      daysOfWeek: [3] // Wednesday
    }
  };

  test('same inputs produce identical output', () => {
    const run1 = computeOccurrencesInRange(session, '2026-01-01', '2026-03-31');
    const run2 = computeOccurrencesInRange(session, '2026-01-01', '2026-03-31');
    const run3 = computeOccurrencesInRange(session, '2026-01-01', '2026-03-31');

    expect(run1).toEqual(run2);
    expect(run2).toEqual(run3);
  });

  test('occurrence keys are deterministic', () => {
    const run1 = computeOccurrencesInRange(session, '2026-01-01', '2026-02-28');
    const run2 = computeOccurrencesInRange(session, '2026-01-01', '2026-02-28');

    const keys1 = run1.map(o => o.occurrenceKey);
    const keys2 = run2.map(o => o.occurrenceKey);

    expect(keys1).toEqual(keys2);
  });
});
