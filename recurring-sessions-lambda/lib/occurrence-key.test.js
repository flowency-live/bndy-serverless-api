/**
 * Occurrence Key Tests
 *
 * Deterministic key generation for Series occurrences.
 * Key format: {seriesId}:{scheduledLocalDate}
 */

const {
  generateOccurrenceKey,
  parseOccurrenceKey,
  validateOccurrenceKey
} = require('./occurrence-key');

describe('generateOccurrenceKey', () => {
  test('generates key from seriesId and scheduledLocalDate', () => {
    const key = generateOccurrenceKey('rs_abc123', '2026-09-10');
    expect(key).toBe('rs_abc123:2026-09-10');
  });

  test('handles different date formats consistently', () => {
    // ISO date string
    const key1 = generateOccurrenceKey('rs_xyz', '2026-12-25');
    expect(key1).toBe('rs_xyz:2026-12-25');
  });

  test('same inputs always produce same key (idempotency)', () => {
    const key1 = generateOccurrenceKey('rs_test', '2026-01-15');
    const key2 = generateOccurrenceKey('rs_test', '2026-01-15');
    const key3 = generateOccurrenceKey('rs_test', '2026-01-15');

    expect(key1).toBe(key2);
    expect(key2).toBe(key3);
  });

  test('different dates produce different keys', () => {
    const key1 = generateOccurrenceKey('rs_test', '2026-01-15');
    const key2 = generateOccurrenceKey('rs_test', '2026-01-16');

    expect(key1).not.toBe(key2);
  });

  test('different series produce different keys', () => {
    const key1 = generateOccurrenceKey('rs_series1', '2026-01-15');
    const key2 = generateOccurrenceKey('rs_series2', '2026-01-15');

    expect(key1).not.toBe(key2);
  });

  test('throws on missing seriesId', () => {
    expect(() => generateOccurrenceKey(null, '2026-01-15')).toThrow('seriesId is required');
    expect(() => generateOccurrenceKey(undefined, '2026-01-15')).toThrow('seriesId is required');
    expect(() => generateOccurrenceKey('', '2026-01-15')).toThrow('seriesId is required');
  });

  test('throws on missing scheduledLocalDate', () => {
    expect(() => generateOccurrenceKey('rs_test', null)).toThrow('scheduledLocalDate is required');
    expect(() => generateOccurrenceKey('rs_test', undefined)).toThrow('scheduledLocalDate is required');
    expect(() => generateOccurrenceKey('rs_test', '')).toThrow('scheduledLocalDate is required');
  });

  test('throws on invalid date format', () => {
    expect(() => generateOccurrenceKey('rs_test', '15-01-2026')).toThrow('invalid date format');
    expect(() => generateOccurrenceKey('rs_test', '2026/01/15')).toThrow('invalid date format');
    expect(() => generateOccurrenceKey('rs_test', 'January 15, 2026')).toThrow('invalid date format');
  });
});

describe('parseOccurrenceKey', () => {
  test('extracts seriesId and scheduledLocalDate from key', () => {
    const parsed = parseOccurrenceKey('rs_abc123:2026-09-10');

    expect(parsed).toEqual({
      seriesId: 'rs_abc123',
      scheduledLocalDate: '2026-09-10'
    });
  });

  test('handles series IDs with underscores', () => {
    const parsed = parseOccurrenceKey('rs_my_series_id:2026-12-25');

    expect(parsed).toEqual({
      seriesId: 'rs_my_series_id',
      scheduledLocalDate: '2026-12-25'
    });
  });

  test('returns null for invalid key format', () => {
    expect(parseOccurrenceKey('invalid')).toBeNull();
    expect(parseOccurrenceKey('no-date-here')).toBeNull();
    expect(parseOccurrenceKey('')).toBeNull();
    expect(parseOccurrenceKey(null)).toBeNull();
  });

  test('roundtrip: generate then parse', () => {
    const seriesId = 'rs_roundtrip_test';
    const date = '2026-06-15';

    const key = generateOccurrenceKey(seriesId, date);
    const parsed = parseOccurrenceKey(key);

    expect(parsed.seriesId).toBe(seriesId);
    expect(parsed.scheduledLocalDate).toBe(date);
  });
});

describe('validateOccurrenceKey', () => {
  test('returns null for valid key', () => {
    expect(validateOccurrenceKey('rs_abc123:2026-09-10')).toBeNull();
  });

  test('returns error for missing key', () => {
    expect(validateOccurrenceKey(null)).toBe('occurrence key is required');
    expect(validateOccurrenceKey('')).toBe('occurrence key is required');
  });

  test('returns error for invalid format', () => {
    expect(validateOccurrenceKey('invalid')).toBe('invalid occurrence key format');
    expect(validateOccurrenceKey('no:valid:date')).toBe('invalid occurrence key format');
  });

  test('returns error for invalid date in key', () => {
    // Date that matches format but is invalid (month 13)
    expect(validateOccurrenceKey('rs_test:2026-13-45')).toBe('invalid date in occurrence key');
    // Date that matches format but day doesn't exist (Feb 30)
    expect(validateOccurrenceKey('rs_test:2026-02-30')).toBe('invalid date in occurrence key');
  });

  test('returns error for non-date pattern in key', () => {
    // Doesn't match YYYY-MM-DD pattern at all
    expect(validateOccurrenceKey('rs_test:not-a-date')).toBe('invalid occurrence key format');
  });
});
