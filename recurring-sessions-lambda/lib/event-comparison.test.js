/**
 * Event Comparison Tests
 *
 * Compare projected occurrences against existing Events.
 */

const {
  compareWithExistingEvents,
  matchOccurrenceToEvent,
  MATCH_TYPES
} = require('./event-comparison');

describe('MATCH_TYPES', () => {
  test('includes all match types', () => {
    expect(MATCH_TYPES).toEqual(['exact', 'linked', 'unlinked_match', 'conflict', 'missing']);
  });
});

describe('matchOccurrenceToEvent', () => {
  const occurrence = {
    occurrenceKey: 'rs_test:2026-01-15',
    seriesId: 'rs_test',
    scheduledLocalDate: '2026-01-15',
    localTime: '19:00',
    venueId: 'v_railway',
    title: 'Tuesday Open Mic'
  };

  test('returns exact match when Event has matching seriesOccurrenceKey', () => {
    const event = {
      id: 'evt_123',
      date: '2026-01-15',
      startTime: '19:00',
      venueId: 'v_railway',
      title: 'Tuesday Open Mic',
      seriesId: 'rs_test',
      seriesOccurrenceKey: 'rs_test:2026-01-15'
    };

    const result = matchOccurrenceToEvent(occurrence, event);

    expect(result.type).toBe('exact');
    expect(result.eventId).toBe('evt_123');
  });

  test('returns linked match when seriesId matches but key differs', () => {
    const event = {
      id: 'evt_456',
      date: '2026-01-15',
      startTime: '19:00',
      venueId: 'v_railway',
      seriesId: 'rs_test'
      // No seriesOccurrenceKey - legacy linkage
    };

    const result = matchOccurrenceToEvent(occurrence, event);

    expect(result.type).toBe('linked');
  });

  test('returns unlinked_match when Event matches but has no seriesId', () => {
    const event = {
      id: 'evt_789',
      date: '2026-01-15',
      startTime: '19:00',
      venueId: 'v_railway',
      title: 'Tuesday Open Mic'
      // No series linkage
    };

    const result = matchOccurrenceToEvent(occurrence, event);

    expect(result.type).toBe('unlinked_match');
    expect(result.confidence).toBe('high');
  });

  test('returns conflict when different Event at same slot', () => {
    const event = {
      id: 'evt_other',
      date: '2026-01-15',
      startTime: '19:00',
      venueId: 'v_railway',
      title: 'Different Event',
      seriesId: 'rs_other_series' // Different series
    };

    const result = matchOccurrenceToEvent(occurrence, event);

    expect(result.type).toBe('conflict');
    expect(result.reason).toContain('Different');
  });

  test('returns null when event is on different date', () => {
    const event = {
      id: 'evt_different_date',
      date: '2026-01-16',
      startTime: '19:00',
      venueId: 'v_railway'
    };

    const result = matchOccurrenceToEvent(occurrence, event);

    expect(result).toBeNull();
  });

  test('returns null when event is at different venue', () => {
    const event = {
      id: 'evt_different_venue',
      date: '2026-01-15',
      startTime: '19:00',
      venueId: 'v_other_venue'
    };

    const result = matchOccurrenceToEvent(occurrence, event);

    expect(result).toBeNull();
  });
});

describe('compareWithExistingEvents', () => {
  const occurrences = [
    {
      occurrenceKey: 'rs_test:2026-01-08',
      seriesId: 'rs_test',
      scheduledLocalDate: '2026-01-08',
      localTime: '19:00',
      venueId: 'v_railway',
      title: 'Tuesday Open Mic'
    },
    {
      occurrenceKey: 'rs_test:2026-01-15',
      seriesId: 'rs_test',
      scheduledLocalDate: '2026-01-15',
      localTime: '19:00',
      venueId: 'v_railway',
      title: 'Tuesday Open Mic'
    },
    {
      occurrenceKey: 'rs_test:2026-01-22',
      seriesId: 'rs_test',
      scheduledLocalDate: '2026-01-22',
      localTime: '19:00',
      venueId: 'v_railway',
      title: 'Tuesday Open Mic'
    }
  ];

  test('identifies occurrences that would be created (no existing event)', () => {
    const existingEvents = [];

    const result = compareWithExistingEvents(occurrences, existingEvents);

    expect(result.wouldCreate).toHaveLength(3);
    expect(result.wouldCreate.map(o => o.occurrenceKey)).toEqual([
      'rs_test:2026-01-08',
      'rs_test:2026-01-15',
      'rs_test:2026-01-22'
    ]);
  });

  test('identifies exact matches (already linked)', () => {
    const existingEvents = [
      {
        id: 'evt_jan15',
        date: '2026-01-15',
        startTime: '19:00',
        venueId: 'v_railway',
        seriesId: 'rs_test',
        seriesOccurrenceKey: 'rs_test:2026-01-15'
      }
    ];

    const result = compareWithExistingEvents(occurrences, existingEvents);

    expect(result.alreadyExists).toHaveLength(1);
    expect(result.alreadyExists[0].occurrenceKey).toBe('rs_test:2026-01-15');
    expect(result.alreadyExists[0].existingEventId).toBe('evt_jan15');
    expect(result.alreadyExists[0].match).toBe('exact');

    expect(result.wouldCreate).toHaveLength(2);
  });

  test('identifies unlinked matches (candidates for adoption)', () => {
    const existingEvents = [
      {
        id: 'evt_unlinked',
        date: '2026-01-15',
        startTime: '19:00',
        venueId: 'v_railway',
        title: 'Tuesday Open Mic'
        // No series linkage
      }
    ];

    const result = compareWithExistingEvents(occurrences, existingEvents);

    expect(result.wouldUpdate).toHaveLength(1);
    expect(result.wouldUpdate[0].occurrenceKey).toBe('rs_test:2026-01-15');
    expect(result.wouldUpdate[0].existingEventId).toBe('evt_unlinked');
    expect(result.wouldUpdate[0].match).toBe('unlinked_match');
  });

  test('identifies conflicts', () => {
    const existingEvents = [
      {
        id: 'evt_conflict',
        date: '2026-01-15',
        startTime: '19:00',
        venueId: 'v_railway',
        title: 'Different Event',
        seriesId: 'rs_other'
      }
    ];

    const result = compareWithExistingEvents(occurrences, existingEvents);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].occurrenceKey).toBe('rs_test:2026-01-15');
    expect(result.conflicts[0].conflictingEventId).toBe('evt_conflict');
  });

  test('handles mixed results', () => {
    const existingEvents = [
      {
        id: 'evt_exact',
        date: '2026-01-08',
        startTime: '19:00',
        venueId: 'v_railway',
        seriesId: 'rs_test',
        seriesOccurrenceKey: 'rs_test:2026-01-08'
      },
      {
        id: 'evt_conflict',
        date: '2026-01-15',
        startTime: '19:00',
        venueId: 'v_railway',
        seriesId: 'rs_other'
      }
      // 2026-01-22 has no event
    ];

    const result = compareWithExistingEvents(occurrences, existingEvents);

    expect(result.alreadyExists).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.wouldCreate).toHaveLength(1);
    expect(result.wouldCreate[0].scheduledLocalDate).toBe('2026-01-22');
  });

  test('handles empty inputs', () => {
    const result = compareWithExistingEvents([], []);

    expect(result.wouldCreate).toHaveLength(0);
    expect(result.wouldUpdate).toHaveLength(0);
    expect(result.alreadyExists).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
  });

  test('ignores events at different venues', () => {
    const existingEvents = [
      {
        id: 'evt_other_venue',
        date: '2026-01-15',
        startTime: '19:00',
        venueId: 'v_different',
        title: 'Tuesday Open Mic'
      }
    ];

    const result = compareWithExistingEvents(occurrences, existingEvents);

    // Should not match - different venue
    expect(result.wouldCreate).toHaveLength(3);
    expect(result.conflicts).toHaveLength(0);
  });

  test('handles time proximity for matching', () => {
    const existingEvents = [
      {
        id: 'evt_close_time',
        date: '2026-01-15',
        startTime: '19:30', // 30 mins later
        venueId: 'v_railway',
        title: 'Tuesday Open Mic'
      }
    ];

    const result = compareWithExistingEvents(occurrences, existingEvents);

    // Close time at same venue should be considered a potential match
    expect(result.wouldUpdate).toHaveLength(1);
    expect(result.wouldUpdate[0].match).toBe('unlinked_match');
    expect(result.wouldUpdate[0].confidence).toBe('medium');
  });
});

describe('compareWithExistingEvents - result shape', () => {
  test('returns structured result object', () => {
    const result = compareWithExistingEvents([], []);

    expect(result).toHaveProperty('wouldCreate');
    expect(result).toHaveProperty('wouldUpdate');
    expect(result).toHaveProperty('alreadyExists');
    expect(result).toHaveProperty('conflicts');
    expect(Array.isArray(result.wouldCreate)).toBe(true);
    expect(Array.isArray(result.wouldUpdate)).toBe(true);
    expect(Array.isArray(result.alreadyExists)).toBe(true);
    expect(Array.isArray(result.conflicts)).toBe(true);
  });
});
