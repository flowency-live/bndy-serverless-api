/**
 * Tests for gigging projection logic
 *
 * The projection job computes two derived fields for each artist:
 * - giggingStatus: "Y" when artist has future public gigs, removed otherwise
 * - giggingUntil: ISO date of the latest public, unhidden, future event
 *
 * These fields power the GSI that enables fast gigging artist queries.
 */

const { computeGiggingProjection, extractArtistIds, shouldSkipWrite } = require('./gigging-projection');

describe('computeGiggingProjection', () => {
  const today = '2026-08-31';

  describe('giggingUntil calculation', () => {
    test('returns latest future date when artist has multiple future events', () => {
      const events = [
        { date: '2026-09-01', hidden: false, visibility: 'public' },
        { date: '2026-12-25', hidden: false, visibility: 'public' },
        { date: '2026-10-15', hidden: false, visibility: 'public' },
      ];

      const result = computeGiggingProjection(events, today);

      expect(result.giggingUntil).toBe('2026-12-25');
      expect(result.giggingStatus).toBe('Y');
    });

    test('returns null when artist has no future events', () => {
      const events = [
        { date: '2026-08-01', hidden: false, visibility: 'public' },
        { date: '2026-07-15', hidden: false, visibility: 'public' },
      ];

      const result = computeGiggingProjection(events, today);

      expect(result.giggingUntil).toBeNull();
      expect(result.giggingStatus).toBeNull();
    });

    test('returns null when artist has no events', () => {
      const events = [];

      const result = computeGiggingProjection(events, today);

      expect(result.giggingUntil).toBeNull();
      expect(result.giggingStatus).toBeNull();
    });
  });

  describe('hidden events filtering', () => {
    test('excludes hidden events from calculation', () => {
      const events = [
        { date: '2026-12-25', hidden: true, visibility: 'public' },
        { date: '2026-09-01', hidden: false, visibility: 'public' },
      ];

      const result = computeGiggingProjection(events, today);

      expect(result.giggingUntil).toBe('2026-09-01');
    });

    test('returns null when all future events are hidden', () => {
      const events = [
        { date: '2026-12-25', hidden: true, visibility: 'public' },
        { date: '2026-09-01', hidden: true, visibility: 'public' },
      ];

      const result = computeGiggingProjection(events, today);

      expect(result.giggingUntil).toBeNull();
      expect(result.giggingStatus).toBeNull();
    });
  });

  describe('visibility filtering', () => {
    test('excludes private events from calculation', () => {
      const events = [
        { date: '2026-12-25', hidden: false, visibility: 'private' },
        { date: '2026-09-01', hidden: false, visibility: 'public' },
      ];

      const result = computeGiggingProjection(events, today);

      expect(result.giggingUntil).toBe('2026-09-01');
    });

    test('treats undefined visibility as public (legacy events)', () => {
      const events = [
        { date: '2026-12-25', hidden: false },
        { date: '2026-09-01', hidden: false, visibility: 'public' },
      ];

      const result = computeGiggingProjection(events, today);

      expect(result.giggingUntil).toBe('2026-12-25');
    });

    test('excludes draft events from calculation', () => {
      const events = [
        { date: '2026-12-25', hidden: false, visibility: 'draft' },
        { date: '2026-09-01', hidden: false, visibility: 'public' },
      ];

      const result = computeGiggingProjection(events, today);

      expect(result.giggingUntil).toBe('2026-09-01');
    });
  });

  describe('today boundary', () => {
    test('includes events on today', () => {
      const events = [
        { date: '2026-08-31', hidden: false, visibility: 'public' },
      ];

      const result = computeGiggingProjection(events, '2026-08-31');

      expect(result.giggingUntil).toBe('2026-08-31');
      expect(result.giggingStatus).toBe('Y');
    });

    test('excludes events before today', () => {
      const events = [
        { date: '2026-08-30', hidden: false, visibility: 'public' },
      ];

      const result = computeGiggingProjection(events, '2026-08-31');

      expect(result.giggingUntil).toBeNull();
      expect(result.giggingStatus).toBeNull();
    });
  });
});

describe('extractArtistIds', () => {
  test('extracts artistId when present', () => {
    const event = { artistId: 'artist-1' };

    const ids = extractArtistIds(event);

    expect(ids).toContain('artist-1');
  });

  test('extracts collaboratingArtistIds when present', () => {
    const event = {
      artistId: 'artist-1',
      collaboratingArtistIds: ['artist-2', 'artist-3'],
    };

    const ids = extractArtistIds(event);

    expect(ids).toContain('artist-1');
    expect(ids).toContain('artist-2');
    expect(ids).toContain('artist-3');
  });

  test('extracts legacy artistIds when present', () => {
    const event = {
      artistIds: ['artist-1', 'artist-2'],
    };

    const ids = extractArtistIds(event);

    expect(ids).toContain('artist-1');
    expect(ids).toContain('artist-2');
  });

  test('deduplicates artist IDs', () => {
    const event = {
      artistId: 'artist-1',
      artistIds: ['artist-1', 'artist-2'],
      collaboratingArtistIds: ['artist-2', 'artist-3'],
    };

    const ids = extractArtistIds(event);

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  test('returns empty array when no artist IDs present', () => {
    const event = { venueId: 'venue-1' };

    const ids = extractArtistIds(event);

    expect(ids).toEqual([]);
  });

  test('filters out null and undefined values', () => {
    const event = {
      artistId: null,
      collaboratingArtistIds: [undefined, 'artist-1', null],
    };

    const ids = extractArtistIds(event);

    expect(ids).toEqual(['artist-1']);
  });
});

describe('shouldSkipWrite', () => {
  test('returns true when values are identical', () => {
    const current = { giggingStatus: 'Y', giggingUntil: '2026-12-25' };
    const next = { giggingStatus: 'Y', giggingUntil: '2026-12-25' };

    expect(shouldSkipWrite(current, next)).toBe(true);
  });

  test('returns false when giggingUntil changes', () => {
    const current = { giggingStatus: 'Y', giggingUntil: '2026-12-25' };
    const next = { giggingStatus: 'Y', giggingUntil: '2026-12-26' };

    expect(shouldSkipWrite(current, next)).toBe(false);
  });

  test('returns false when giggingStatus changes from Y to null', () => {
    const current = { giggingStatus: 'Y', giggingUntil: '2026-12-25' };
    const next = { giggingStatus: null, giggingUntil: null };

    expect(shouldSkipWrite(current, next)).toBe(false);
  });

  test('returns false when giggingStatus changes from null to Y', () => {
    const current = { giggingStatus: null, giggingUntil: null };
    const next = { giggingStatus: 'Y', giggingUntil: '2026-12-25' };

    expect(shouldSkipWrite(current, next)).toBe(false);
  });

  test('returns true when both are null', () => {
    const current = { giggingStatus: null, giggingUntil: null };
    const next = { giggingStatus: null, giggingUntil: null };

    expect(shouldSkipWrite(current, next)).toBe(true);
  });

  test('handles undefined as equivalent to null', () => {
    const current = { giggingStatus: undefined, giggingUntil: undefined };
    const next = { giggingStatus: null, giggingUntil: null };

    expect(shouldSkipWrite(current, next)).toBe(true);
  });
});
