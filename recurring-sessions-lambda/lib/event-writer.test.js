/**
 * Event Writer Tests
 *
 * Write Events to bndy-events from projected occurrences.
 */

const {
  generateEventFromOccurrence,
  generateOccurrenceUniqueKey,
  generateEventNaturalKey,
  writeEvent,
  writeBatch
} = require('./event-writer');

describe('generateOccurrenceUniqueKey', () => {
  test('generates key from seriesId and date', () => {
    const key = generateOccurrenceUniqueKey('rs_abc123', '2026-01-15');
    expect(key).toBe('seriesOccurrence:rs_abc123:2026-01-15');
  });

  test('throws on missing seriesId', () => {
    expect(() => generateOccurrenceUniqueKey(null, '2026-01-15'))
      .toThrow('seriesId is required');
  });

  test('throws on missing date', () => {
    expect(() => generateOccurrenceUniqueKey('rs_test', null))
      .toThrow('date is required');
  });
});

describe('generateEventNaturalKey', () => {
  test('generates key for open mic (no artist)', () => {
    const event = {
      venueId: 'v_railway',
      date: '2026-01-15',
      startTime: '19:00',
      isOpenMic: true
    };

    const key = generateEventNaturalKey(event);

    expect(key).toBe('event:v_railway:OPENMIC:19:00:2026-01-15');
  });

  test('generates key with artistId', () => {
    const event = {
      venueId: 'v_railway',
      artistId: 'a_host',
      date: '2026-01-15',
      startTime: '19:00'
    };

    const key = generateEventNaturalKey(event);

    expect(key).toBe('event:v_railway:a_host:19:00:2026-01-15');
  });

  test('uses OPENMIC when artistId is missing', () => {
    const event = {
      venueId: 'v_railway',
      date: '2026-01-15',
      startTime: '19:00'
    };

    const key = generateEventNaturalKey(event);

    expect(key).toBe('event:v_railway:OPENMIC:19:00:2026-01-15');
  });
});

describe('generateEventFromOccurrence', () => {
  const occurrence = {
    occurrenceKey: 'rs_test:2026-01-15',
    seriesId: 'rs_test',
    scheduledLocalDate: '2026-01-15',
    localTime: '19:00',
    localEndTime: '22:00',
    utcStart: '2026-01-15T19:00:00.000Z',
    venueId: 'v_railway',
    title: 'Tuesday Open Mic'
  };

  const series = {
    id: 'rs_test',
    sessionType: 'open_mic',
    description: 'Weekly open mic night',
    createdBy: 'user_123'
  };

  test('generates Event with all required fields', () => {
    const event = generateEventFromOccurrence(occurrence, series);

    expect(event).toMatchObject({
      title: 'Tuesday Open Mic',
      venueId: 'v_railway',
      date: '2026-01-15',
      startTime: '19:00',
      endTime: '22:00',
      type: 'community',
      isOpenMic: true,
      isPublic: true,
      status: 'active',
      seriesId: 'rs_test',
      seriesOccurrenceKey: 'rs_test:2026-01-15',
      source: 'recurring-session-projection'
    });
  });

  test('generates unique event ID', () => {
    const event1 = generateEventFromOccurrence(occurrence, series);
    const event2 = generateEventFromOccurrence(occurrence, series);

    // IDs should be generated (even if same occurrence)
    expect(event1.id).toBeDefined();
    expect(event1.id).toMatch(/^evt_/);
  });

  test('includes createdAt and updatedAt', () => {
    const event = generateEventFromOccurrence(occurrence, series);

    expect(event.createdAt).toBeDefined();
    expect(event.updatedAt).toBeDefined();
  });

  test('sets isOpenMic based on sessionType', () => {
    const openMicEvent = generateEventFromOccurrence(occurrence, {
      ...series,
      sessionType: 'open_mic'
    });
    expect(openMicEvent.isOpenMic).toBe(true);

    const jamEvent = generateEventFromOccurrence(occurrence, {
      ...series,
      sessionType: 'jam_session'
    });
    expect(jamEvent.isOpenMic).toBe(false);
  });

  test('includes description if provided', () => {
    const event = generateEventFromOccurrence(occurrence, series);

    expect(event.description).toBe('Weekly open mic night');
  });
});

describe('writeEvent', () => {
  const mockDynamodb = {
    transactWrite: jest.fn(),
    get: jest.fn(),
    put: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_MODE = 'enforce';
  });

  const occurrence = {
    occurrenceKey: 'rs_test:2026-01-15',
    seriesId: 'rs_test',
    scheduledLocalDate: '2026-01-15',
    localTime: '19:00',
    utcStart: '2026-01-15T19:00:00.000Z',
    venueId: 'v_railway',
    title: 'Tuesday Open Mic'
  };

  const series = {
    id: 'rs_test',
    sessionType: 'open_mic'
  };

  test('writes event successfully', async () => {
    mockDynamodb.transactWrite.mockReturnValue({
      promise: () => Promise.resolve({})
    });

    const result = await writeEvent(mockDynamodb, occurrence, series);

    expect(result.success).toBe(true);
    expect(result.eventId).toBeDefined();
    expect(mockDynamodb.transactWrite).toHaveBeenCalled();
  });

  test('returns conflict when occurrence key exists', async () => {
    mockDynamodb.transactWrite.mockReturnValue({
      promise: () => Promise.reject({ code: 'TransactionCanceledException' })
    });
    mockDynamodb.get.mockReturnValue({
      promise: () => Promise.resolve({
        Item: {
          key: 'seriesOccurrence:rs_test:2026-01-15',
          refId: 'evt_existing'
        }
      })
    });

    const result = await writeEvent(mockDynamodb, occurrence, series);

    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.existingEventId).toBe('evt_existing');
  });

  test('returns conflict when natural key exists', async () => {
    mockDynamodb.transactWrite.mockReturnValue({
      promise: () => Promise.reject({ code: 'TransactionCanceledException' })
    });
    mockDynamodb.get
      .mockReturnValueOnce({ promise: () => Promise.resolve({}) }) // occurrence key not found
      .mockReturnValueOnce({
        promise: () => Promise.resolve({
          Item: {
            key: 'event:v_railway:OPENMIC:19:00:2026-01-15',
            refId: 'evt_natural_conflict'
          }
        })
      });

    const result = await writeEvent(mockDynamodb, occurrence, series);

    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.conflictType).toBe('natural_key');
  });

  test('respects suppressNotifications option', async () => {
    mockDynamodb.transactWrite.mockReturnValue({
      promise: () => Promise.resolve({})
    });

    const result = await writeEvent(mockDynamodb, occurrence, series, {
      suppressNotifications: true
    });

    expect(result.success).toBe(true);
    // The event should have suppressNotifications flag
    const transactCall = mockDynamodb.transactWrite.mock.calls[0][0];
    const putItem = transactCall.TransactItems.find(
      item => item.Put && item.Put.TableName === 'bndy-events'
    );
    expect(putItem.Put.Item.suppressNotifications).toBe(true);
  });
});

describe('writeBatch', () => {
  const mockDynamodb = {
    transactWrite: jest.fn(),
    get: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_MODE = 'enforce';
  });

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
    }
  ];

  const series = {
    id: 'rs_test',
    sessionType: 'open_mic'
  };

  test('writes all events successfully', async () => {
    mockDynamodb.transactWrite.mockReturnValue({
      promise: () => Promise.resolve({})
    });

    const result = await writeBatch(mockDynamodb, occurrences, series);

    expect(result.created).toHaveLength(2);
    expect(result.conflicts).toHaveLength(0);
    expect(mockDynamodb.transactWrite).toHaveBeenCalledTimes(2);
  });

  test('handles partial success with conflicts', async () => {
    // First succeeds, second fails
    mockDynamodb.transactWrite
      .mockReturnValueOnce({ promise: () => Promise.resolve({}) })
      .mockReturnValueOnce({ promise: () => Promise.reject({ code: 'TransactionCanceledException' }) });

    mockDynamodb.get.mockReturnValue({
      promise: () => Promise.resolve({
        Item: { key: 'seriesOccurrence:rs_test:2026-01-15', refId: 'evt_existing' }
      })
    });

    const result = await writeBatch(mockDynamodb, occurrences, series);

    expect(result.created).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].scheduledLocalDate).toBe('2026-01-15');
  });

  test('returns summary counts', async () => {
    mockDynamodb.transactWrite.mockReturnValue({
      promise: () => Promise.resolve({})
    });

    const result = await writeBatch(mockDynamodb, occurrences, series);

    expect(result.summary).toEqual({
      requested: 2,
      created: 2,
      conflicts: 0
    });
  });

  test('handles empty occurrences array', async () => {
    const result = await writeBatch(mockDynamodb, [], series);

    expect(result.created).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.summary.requested).toBe(0);
  });
});
