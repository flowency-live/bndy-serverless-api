/**
 * Series Uniqueness Tests
 *
 * Prevent duplicate Series at the same venue with similar schedule.
 */

const {
  generateSeriesKey,
  checkSeriesUniqueness,
  reserveSeriesKey
} = require('./series-uniqueness');

describe('generateSeriesKey', () => {
  test('generates key for weekly session', () => {
    const session = {
      venueId: 'v_railway',
      name: 'Tuesday Open Mic',
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: [2] // Tuesday
      }
    };

    const key = generateSeriesKey(session);

    expect(key).toBe('series:v_railway:tuesday_open_mic:weekly:2');
  });

  test('generates key for fortnightly session', () => {
    const session = {
      venueId: 'v_pub',
      name: 'Acoustic Night',
      recurrence: {
        frequency: 'weekly',
        interval: 2,
        daysOfWeek: [5] // Friday
      }
    };

    const key = generateSeriesKey(session);

    expect(key).toBe('series:v_pub:acoustic_night:fortnightly:5');
  });

  test('generates key for monthly_by_weekday session', () => {
    const session = {
      venueId: 'v_hall',
      name: 'First Sunday Session',
      recurrence: {
        frequency: 'monthly_by_weekday',
        ordinal: 1,
        weekday: 0 // Sunday
      }
    };

    const key = generateSeriesKey(session);

    expect(key).toBe('series:v_hall:first_sunday_session:monthly:1st:0');
  });

  test('generates key for last weekday monthly session', () => {
    const session = {
      venueId: 'v_club',
      name: 'Last Friday Blues',
      recurrence: {
        frequency: 'monthly_by_weekday',
        ordinal: -1,
        weekday: 5 // Friday
      }
    };

    const key = generateSeriesKey(session);

    expect(key).toBe('series:v_club:last_friday_blues:monthly:last:5');
  });

  test('generates key for monthly_by_date session', () => {
    const session = {
      venueId: 'v_venue',
      name: '15th of the Month',
      recurrence: {
        frequency: 'monthly_by_date',
        dayOfMonth: 15
      }
    };

    const key = generateSeriesKey(session);

    expect(key).toBe('series:v_venue:15th_of_the_month:monthly:day15');
  });

  test('normalises session name', () => {
    const session = {
      venueId: 'v_test',
      name: "Joe's Open Mic Night!!",
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: [3]
      }
    };

    const key = generateSeriesKey(session);

    expect(key).toBe('series:v_test:joes_open_mic_night:weekly:3');
  });

  test('handles multiple weekdays', () => {
    const session = {
      venueId: 'v_test',
      name: 'Weekend Sessions',
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        daysOfWeek: [5, 6] // Friday and Saturday
      }
    };

    const key = generateSeriesKey(session);

    // Should include all weekdays sorted
    expect(key).toBe('series:v_test:weekend_sessions:weekly:5,6');
  });

  test('throws on missing venueId', () => {
    const session = {
      name: 'Test',
      recurrence: { frequency: 'weekly', interval: 1, daysOfWeek: [1] }
    };

    expect(() => generateSeriesKey(session)).toThrow('venueId is required');
  });

  test('throws on missing name', () => {
    const session = {
      venueId: 'v_test',
      recurrence: { frequency: 'weekly', interval: 1, daysOfWeek: [1] }
    };

    expect(() => generateSeriesKey(session)).toThrow('name is required');
  });

  test('throws on missing recurrence', () => {
    const session = {
      venueId: 'v_test',
      name: 'Test'
    };

    expect(() => generateSeriesKey(session)).toThrow('recurrence is required');
  });
});

describe('checkSeriesUniqueness', () => {
  const mockDynamodb = {
    get: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns null when no existing series', async () => {
    mockDynamodb.get.mockReturnValue({
      promise: () => Promise.resolve({})
    });

    const session = {
      venueId: 'v_test',
      name: 'New Session',
      recurrence: { frequency: 'weekly', interval: 1, daysOfWeek: [2] }
    };

    const result = await checkSeriesUniqueness(mockDynamodb, session);

    expect(result).toBeNull();
  });

  test('returns existing series when duplicate found', async () => {
    mockDynamodb.get.mockReturnValue({
      promise: () => Promise.resolve({
        Item: {
          key: 'series:v_test:tuesday_session:weekly:2',
          refId: 'rs_existing',
          entityType: 'recurring-session'
        }
      })
    });

    const session = {
      venueId: 'v_test',
      name: 'Tuesday Session',
      recurrence: { frequency: 'weekly', interval: 1, daysOfWeek: [2] }
    };

    const result = await checkSeriesUniqueness(mockDynamodb, session);

    expect(result).toEqual({
      key: 'series:v_test:tuesday_session:weekly:2',
      refId: 'rs_existing',
      entityType: 'recurring-session'
    });
  });
});

describe('reserveSeriesKey', () => {
  const mockDynamodb = {
    put: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('reserves key successfully', async () => {
    mockDynamodb.put.mockReturnValue({
      promise: () => Promise.resolve({})
    });

    const session = {
      id: 'rs_new',
      venueId: 'v_test',
      name: 'New Session',
      recurrence: { frequency: 'weekly', interval: 1, daysOfWeek: [2] }
    };

    const result = await reserveSeriesKey(mockDynamodb, session);

    expect(result.success).toBe(true);
    expect(mockDynamodb.put).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: expect.any(String),
        Item: expect.objectContaining({
          key: 'series:v_test:new_session:weekly:2',
          refId: 'rs_new',
          entityType: 'recurring-session'
        }),
        ConditionExpression: 'attribute_not_exists(#k)'
      })
    );
  });

  test('returns conflict when key already exists', async () => {
    mockDynamodb.put.mockReturnValue({
      promise: () => Promise.reject({ code: 'ConditionalCheckFailedException' })
    });

    const session = {
      id: 'rs_new',
      venueId: 'v_test',
      name: 'Existing Session',
      recurrence: { frequency: 'weekly', interval: 1, daysOfWeek: [2] }
    };

    const result = await reserveSeriesKey(mockDynamodb, session);

    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
  });
});
