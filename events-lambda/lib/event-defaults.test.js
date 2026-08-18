// RUNBOOK §5.6 regression test.
// This rule was broken once: an agent asked Jason for a gig start time, then
// invented 20:00 for a Saturday. The correct answer was 21:00. This test stops
// that class of defect returning.

const { defaultStartTime, resolveStartTime, DEFAULT_END_TIME } = require('./event-defaults');

describe('RUNBOOK §5.6 default start times', () => {
  test('Friday and Saturday default to 21:00', () => {
    expect(defaultStartTime('2026-08-14')).toBe('21:00'); // Friday
    expect(defaultStartTime('2026-08-15')).toBe('21:00'); // Saturday
  });

  test('Sunday defaults to 19:00', () => {
    expect(defaultStartTime('2026-08-16')).toBe('19:00');
  });

  test('Monday to Thursday default to 20:00', () => {
    expect(defaultStartTime('2026-08-10')).toBe('20:00'); // Monday
    expect(defaultStartTime('2026-08-11')).toBe('20:00'); // Tuesday
    expect(defaultStartTime('2026-08-12')).toBe('20:00'); // Wednesday
    expect(defaultStartTime('2026-08-13')).toBe('20:00'); // Thursday
  });

  test('an afternoon gig defaults to 14:00 on any day', () => {
    expect(defaultStartTime('2026-08-15', true)).toBe('14:00');
    expect(defaultStartTime('2026-08-16', true)).toBe('14:00');
    expect(defaultStartTime('2026-08-12', true)).toBe('14:00');
  });

  test('a malformed date does not throw', () => {
    expect(defaultStartTime('not-a-date')).toBe('20:00');
  });

  test('the day boundary is stable, no timezone rollover', () => {
    // Midday UTC is used internally. A date must not slip to the previous day.
    expect(defaultStartTime('2026-01-03')).toBe('21:00'); // Saturday
    expect(defaultStartTime('2026-01-04')).toBe('19:00'); // Sunday
    expect(defaultStartTime('2026-12-25')).toBe('21:00'); // Friday
  });
});

describe('resolveStartTime', () => {
  test('a supplied time always wins and is not marked defaulted', () => {
    expect(resolveStartTime('2026-08-15', '19:30')).toEqual({
      startTime: '19:30',
      defaulted: false
    });
  });

  test('a missing time is defaulted and flagged', () => {
    expect(resolveStartTime('2026-08-15')).toEqual({
      startTime: '21:00',
      defaulted: true
    });
  });

  test('an empty or whitespace time is treated as missing', () => {
    expect(resolveStartTime('2026-08-15', '')).toEqual({ startTime: '21:00', defaulted: true });
    expect(resolveStartTime('2026-08-15', '   ')).toEqual({ startTime: '21:00', defaulted: true });
  });

  test('the Cover-Story defect: Saturday 15 Aug 2026 is 21:00, never 20:00', () => {
    const result = resolveStartTime('2026-08-15');
    expect(result.startTime).toBe('21:00');
    expect(result.startTime).not.toBe('20:00');
    expect(result.defaulted).toBe(true);
  });
});

describe('end time', () => {
  test('defaults to midnight', () => {
    expect(DEFAULT_END_TIME).toBe('00:00');
  });
});
