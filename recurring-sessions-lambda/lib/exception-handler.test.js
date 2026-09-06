/**
 * Exception Handler Tests
 *
 * Apply exceptions (skip, cancel, move, override) to computed occurrences.
 */

const {
  applyExceptions,
  validateException,
  EXCEPTION_TYPES
} = require('./exception-handler');

describe('EXCEPTION_TYPES', () => {
  test('includes all valid exception types', () => {
    expect(EXCEPTION_TYPES).toEqual(['skip', 'cancel', 'move', 'override']);
  });
});

describe('validateException', () => {
  test('accepts valid skip exception', () => {
    const exception = {
      type: 'skip',
      scheduledLocalDate: '2026-01-15',
      reason: 'Venue closed for refurbishment'
    };

    expect(validateException(exception)).toBeNull();
  });

  test('accepts valid cancel exception', () => {
    const exception = {
      type: 'cancel',
      scheduledLocalDate: '2026-12-25',
      reason: 'Christmas Day'
    };

    expect(validateException(exception)).toBeNull();
  });

  test('accepts valid move exception', () => {
    const exception = {
      type: 'move',
      scheduledLocalDate: '2026-01-15',
      movedToDate: '2026-01-16',
      reason: 'Venue unavailable'
    };

    expect(validateException(exception)).toBeNull();
  });

  test('accepts valid override exception', () => {
    const exception = {
      type: 'override',
      scheduledLocalDate: '2026-01-15',
      overrides: {
        startTime: '20:00',
        title: 'Special Edition Open Mic'
      }
    };

    expect(validateException(exception)).toBeNull();
  });

  test('rejects invalid exception type', () => {
    const exception = {
      type: 'invalid',
      scheduledLocalDate: '2026-01-15'
    };

    expect(validateException(exception)).toBe('invalid exception type');
  });

  test('rejects missing scheduledLocalDate', () => {
    const exception = {
      type: 'skip'
    };

    expect(validateException(exception)).toBe('scheduledLocalDate is required');
  });

  test('rejects invalid scheduledLocalDate format', () => {
    const exception = {
      type: 'skip',
      scheduledLocalDate: '15-01-2026'
    };

    expect(validateException(exception)).toBe('invalid date format');
  });

  test('move exception requires movedToDate', () => {
    const exception = {
      type: 'move',
      scheduledLocalDate: '2026-01-15'
    };

    expect(validateException(exception)).toBe('movedToDate is required for move exceptions');
  });

  test('override exception requires overrides object', () => {
    const exception = {
      type: 'override',
      scheduledLocalDate: '2026-01-15'
    };

    expect(validateException(exception)).toBe('overrides object is required for override exceptions');
  });
});

describe('applyExceptions - skip', () => {
  const occurrences = [
    { scheduledLocalDate: '2026-01-08', occurrenceKey: 'rs_test:2026-01-08', title: 'Session' },
    { scheduledLocalDate: '2026-01-15', occurrenceKey: 'rs_test:2026-01-15', title: 'Session' },
    { scheduledLocalDate: '2026-01-22', occurrenceKey: 'rs_test:2026-01-22', title: 'Session' }
  ];

  test('removes skipped occurrence from list', () => {
    const exceptions = [
      { type: 'skip', scheduledLocalDate: '2026-01-15', reason: 'Venue closed' }
    ];

    const result = applyExceptions(occurrences, exceptions);

    expect(result.occurrences).toHaveLength(2);
    expect(result.occurrences.map(o => o.scheduledLocalDate)).toEqual([
      '2026-01-08',
      '2026-01-22'
    ]);
  });

  test('records skipped exception in applied list', () => {
    const exceptions = [
      { type: 'skip', scheduledLocalDate: '2026-01-15', reason: 'Venue closed' }
    ];

    const result = applyExceptions(occurrences, exceptions);

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({
      type: 'skip',
      scheduledLocalDate: '2026-01-15'
    });
  });

  test('handles multiple skips', () => {
    const exceptions = [
      { type: 'skip', scheduledLocalDate: '2026-01-08' },
      { type: 'skip', scheduledLocalDate: '2026-01-22' }
    ];

    const result = applyExceptions(occurrences, exceptions);

    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0].scheduledLocalDate).toBe('2026-01-15');
  });
});

describe('applyExceptions - cancel', () => {
  const occurrences = [
    { scheduledLocalDate: '2026-01-08', occurrenceKey: 'rs_test:2026-01-08', title: 'Session' },
    { scheduledLocalDate: '2026-01-15', occurrenceKey: 'rs_test:2026-01-15', title: 'Session' }
  ];

  test('marks occurrence as cancelled (keeps in list)', () => {
    const exceptions = [
      { type: 'cancel', scheduledLocalDate: '2026-01-15', reason: 'Christmas' }
    ];

    const result = applyExceptions(occurrences, exceptions);

    expect(result.occurrences).toHaveLength(2);

    const cancelled = result.occurrences.find(o => o.scheduledLocalDate === '2026-01-15');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelReason).toBe('Christmas');
  });

  test('other occurrences remain active', () => {
    const exceptions = [
      { type: 'cancel', scheduledLocalDate: '2026-01-15' }
    ];

    const result = applyExceptions(occurrences, exceptions);

    const active = result.occurrences.find(o => o.scheduledLocalDate === '2026-01-08');
    expect(active.status).toBeUndefined(); // Not explicitly set means active
  });
});

describe('applyExceptions - move', () => {
  const occurrences = [
    { scheduledLocalDate: '2026-01-08', occurrenceKey: 'rs_test:2026-01-08', title: 'Session', localTime: '19:00' },
    { scheduledLocalDate: '2026-01-15', occurrenceKey: 'rs_test:2026-01-15', title: 'Session', localTime: '19:00' }
  ];

  test('changes occurrence date to movedToDate', () => {
    const exceptions = [
      { type: 'move', scheduledLocalDate: '2026-01-15', movedToDate: '2026-01-16', reason: 'Venue conflict' }
    ];

    const result = applyExceptions(occurrences, exceptions);

    expect(result.occurrences).toHaveLength(2);

    const moved = result.occurrences.find(o => o.scheduledLocalDate === '2026-01-16');
    expect(moved).toBeDefined();
    expect(moved.movedFrom).toBe('2026-01-15');
    expect(moved.moveReason).toBe('Venue conflict');
  });

  test('updates occurrence key for moved date', () => {
    const exceptions = [
      { type: 'move', scheduledLocalDate: '2026-01-15', movedToDate: '2026-01-16' }
    ];

    const result = applyExceptions(occurrences, exceptions);

    const moved = result.occurrences.find(o => o.scheduledLocalDate === '2026-01-16');
    expect(moved.occurrenceKey).toBe('rs_test:2026-01-16');
    expect(moved.originalOccurrenceKey).toBe('rs_test:2026-01-15');
  });

  test('preserves other occurrence properties', () => {
    const exceptions = [
      { type: 'move', scheduledLocalDate: '2026-01-15', movedToDate: '2026-01-16' }
    ];

    const result = applyExceptions(occurrences, exceptions);

    const moved = result.occurrences.find(o => o.scheduledLocalDate === '2026-01-16');
    expect(moved.localTime).toBe('19:00');
    expect(moved.title).toBe('Session');
  });
});

describe('applyExceptions - override', () => {
  const occurrences = [
    {
      scheduledLocalDate: '2026-01-15',
      occurrenceKey: 'rs_test:2026-01-15',
      title: 'Tuesday Open Mic',
      localTime: '19:00',
      venueId: 'v_railway'
    }
  ];

  test('applies field overrides to occurrence', () => {
    const exceptions = [
      {
        type: 'override',
        scheduledLocalDate: '2026-01-15',
        overrides: {
          title: 'Special Guest Open Mic',
          localTime: '20:00'
        }
      }
    ];

    const result = applyExceptions(occurrences, exceptions);

    const modified = result.occurrences[0];
    expect(modified.title).toBe('Special Guest Open Mic');
    expect(modified.localTime).toBe('20:00');
  });

  test('preserves non-overridden fields', () => {
    const exceptions = [
      {
        type: 'override',
        scheduledLocalDate: '2026-01-15',
        overrides: {
          title: 'Different Title'
        }
      }
    ];

    const result = applyExceptions(occurrences, exceptions);

    const modified = result.occurrences[0];
    expect(modified.localTime).toBe('19:00');
    expect(modified.venueId).toBe('v_railway');
    expect(modified.scheduledLocalDate).toBe('2026-01-15');
  });

  test('records which fields were overridden', () => {
    const exceptions = [
      {
        type: 'override',
        scheduledLocalDate: '2026-01-15',
        overrides: {
          title: 'Special',
          localTime: '20:00'
        }
      }
    ];

    const result = applyExceptions(occurrences, exceptions);

    const modified = result.occurrences[0];
    expect(modified.overriddenFields).toEqual(['title', 'localTime']);
  });
});

describe('applyExceptions - edge cases', () => {
  test('handles empty exceptions array', () => {
    const occurrences = [
      { scheduledLocalDate: '2026-01-15', title: 'Session' }
    ];

    const result = applyExceptions(occurrences, []);

    expect(result.occurrences).toHaveLength(1);
    expect(result.applied).toHaveLength(0);
  });

  test('handles exception for non-existent date', () => {
    const occurrences = [
      { scheduledLocalDate: '2026-01-15', title: 'Session' }
    ];

    const exceptions = [
      { type: 'skip', scheduledLocalDate: '2026-01-22' }
    ];

    const result = applyExceptions(occurrences, exceptions);

    expect(result.occurrences).toHaveLength(1);
    expect(result.notApplied).toHaveLength(1);
    expect(result.notApplied[0].scheduledLocalDate).toBe('2026-01-22');
  });

  test('applies multiple exception types together', () => {
    const occurrences = [
      { scheduledLocalDate: '2026-01-08', occurrenceKey: 'rs:2026-01-08', title: 'Session' },
      { scheduledLocalDate: '2026-01-15', occurrenceKey: 'rs:2026-01-15', title: 'Session' },
      { scheduledLocalDate: '2026-01-22', occurrenceKey: 'rs:2026-01-22', title: 'Session' },
      { scheduledLocalDate: '2026-01-29', occurrenceKey: 'rs:2026-01-29', title: 'Session' }
    ];

    const exceptions = [
      { type: 'skip', scheduledLocalDate: '2026-01-08' },
      { type: 'cancel', scheduledLocalDate: '2026-01-15', reason: 'Weather' },
      { type: 'move', scheduledLocalDate: '2026-01-22', movedToDate: '2026-01-23' },
      { type: 'override', scheduledLocalDate: '2026-01-29', overrides: { title: 'Special' } }
    ];

    const result = applyExceptions(occurrences, exceptions);

    // One skipped (removed), three remain
    expect(result.occurrences).toHaveLength(3);

    // Check cancelled
    const cancelled = result.occurrences.find(o => o.scheduledLocalDate === '2026-01-15');
    expect(cancelled.status).toBe('cancelled');

    // Check moved
    const moved = result.occurrences.find(o => o.scheduledLocalDate === '2026-01-23');
    expect(moved).toBeDefined();

    // Check overridden
    const overridden = result.occurrences.find(o => o.scheduledLocalDate === '2026-01-29');
    expect(overridden.title).toBe('Special');
  });

  test('returns immutable input (does not modify original)', () => {
    const occurrences = [
      { scheduledLocalDate: '2026-01-15', title: 'Original' }
    ];

    const exceptions = [
      { type: 'override', scheduledLocalDate: '2026-01-15', overrides: { title: 'Modified' } }
    ];

    applyExceptions(occurrences, exceptions);

    expect(occurrences[0].title).toBe('Original');
  });
});
