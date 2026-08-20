/**
 * TDD tests for events-lambda festival-tag curator endpoint
 * Per spec: bndy-app/FESTIVAL-CURATOR-PLAN.md §B3
 *
 * POST /api/curator/events/festival-tag
 * { festivalId, festivalName, add: [eventIds], remove: [eventIds] }
 *
 * Tests:
 * - tags an untagged event
 * - re-tag same festival is idempotent success
 * - event tagged to ANOTHER festival -> skipped with reason, unchanged
 * - untag only removes own linkage
 * - >100 ids -> 400
 * - empty add+remove -> 400
 * - 401/403 gates
 */

const jwt = require('jsonwebtoken');
const { handleCuratorFestivalTag } = require('./curator');

const JWT_SECRET = 'test-secret';

function createMockDeps(dynamoOverrides = {}) {
  return {
    dynamodb: {
      put: jest.fn(() => ({ promise: () => Promise.resolve({}) })),
      update: jest.fn(() => ({ promise: () => Promise.resolve({}) })),
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: null }) })),
      query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) })),
      ...dynamoOverrides
    },
    ssm: {
      getParameter: jest.fn(() => ({
        promise: () => Promise.resolve({ Parameter: { Value: JWT_SECRET } })
      }))
    },
    getCorsHeaders: () => ({ 'Content-Type': 'application/json' })
  };
}

function createSessionCookie(payload = { userId: 'user-123' }) {
  return `bndy_session=${jwt.sign(payload, JWT_SECRET)}`;
}

function createEvent(overrides = {}) {
  return {
    headers: {},
    cookies: [],
    body: '{}',
    pathParameters: {},
    ...overrides
  };
}

const curatorUser = { cognito_id: 'user-123', role: 'curator', display_name: 'Test Curator' };
const regularUser = { cognito_id: 'user-789', role: 'user', display_name: 'Regular User' };

describe('Festival Tag - Auth Gates', () => {
  it('returns 401 without session cookie', async () => {
    const deps = createMockDeps();
    const event = createEvent({
      body: JSON.stringify({ festivalId: 'fest-1', add: ['event-1'] })
    });

    const res = await handleCuratorFestivalTag(deps, event);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toMatch(/authenticated/i);
  });

  it('returns 403 for regular user (not curator/staff)', async () => {
    const deps = createMockDeps({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: regularUser }) }))
    });
    const event = createEvent({
      cookies: [createSessionCookie({ userId: 'user-789' })],
      body: JSON.stringify({ festivalId: 'fest-1', add: ['event-1'] })
    });

    const res = await handleCuratorFestivalTag(deps, event);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/curator/i);
  });
});

describe('Festival Tag - Validation', () => {
  it('returns 400 when festivalId is missing', async () => {
    const deps = createMockDeps({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: curatorUser }) }))
    });
    const event = createEvent({
      cookies: [createSessionCookie()],
      body: JSON.stringify({ add: ['event-1'] })
    });

    const res = await handleCuratorFestivalTag(deps, event);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/festivalId.*required/i);
  });

  it('returns 400 when both add and remove are empty', async () => {
    const deps = createMockDeps({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: curatorUser }) }))
    });
    const event = createEvent({
      cookies: [createSessionCookie()],
      body: JSON.stringify({ festivalId: 'fest-1', add: [], remove: [] })
    });

    const res = await handleCuratorFestivalTag(deps, event);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/at least one/i);
  });

  it('returns 400 when >100 ids total', async () => {
    const deps = createMockDeps({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: curatorUser }) }))
    });
    const manyIds = Array.from({ length: 101 }, (_, i) => `event-${i}`);
    const event = createEvent({
      cookies: [createSessionCookie()],
      body: JSON.stringify({ festivalId: 'fest-1', add: manyIds })
    });

    const res = await handleCuratorFestivalTag(deps, event);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/100/);
  });
});

describe('Festival Tag - Add Operations', () => {
  it('tags an untagged event', async () => {
    const updateMock = jest.fn(() => ({ promise: () => Promise.resolve({}) }));
    const putMock = jest.fn(() => ({ promise: () => Promise.resolve({}) }));
    const deps = createMockDeps({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: curatorUser }) })),
      update: updateMock,
      put: putMock
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      body: JSON.stringify({
        festivalId: 'fest-abc',
        festivalName: 'Test Festival',
        add: ['event-1']
      })
    });

    const res = await handleCuratorFestivalTag(deps, event);
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.tagged).toContain('event-1');
    expect(body.skipped).toHaveLength(0);

    // Verify update was called with correct condition
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      ConditionExpression: expect.stringMatching(/attribute_not_exists\(festivalId\)|festivalId = :fid/),
      UpdateExpression: expect.stringMatching(/SET festivalId = :fid/)
    }));
  });

  it('re-tag same festival is idempotent success', async () => {
    // When event is already tagged to THIS festival, update succeeds (festivalId = :fid)
    const updateMock = jest.fn(() => ({ promise: () => Promise.resolve({}) }));
    const deps = createMockDeps({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: curatorUser }) })),
      update: updateMock,
      put: jest.fn(() => ({ promise: () => Promise.resolve({}) }))
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      body: JSON.stringify({
        festivalId: 'fest-abc',
        festivalName: 'Test Festival',
        add: ['event-already-tagged']
      })
    });

    const res = await handleCuratorFestivalTag(deps, event);
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.tagged).toContain('event-already-tagged');
  });

  it('event tagged to ANOTHER festival -> skipped with reason, unchanged', async () => {
    const updateMock = jest.fn(() => ({
      promise: () => Promise.reject({ code: 'ConditionalCheckFailedException' })
    }));
    const deps = createMockDeps({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: curatorUser }) })),
      update: updateMock,
      put: jest.fn(() => ({ promise: () => Promise.resolve({}) }))
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      body: JSON.stringify({
        festivalId: 'fest-abc',
        festivalName: 'Test Festival',
        add: ['event-owned-by-other']
      })
    });

    const res = await handleCuratorFestivalTag(deps, event);
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.tagged).toHaveLength(0);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].id).toBe('event-owned-by-other');
    expect(body.skipped[0].reason).toMatch(/not found|another festival/i);
  });

  it('tags multiple events in one call', async () => {
    const updateMock = jest.fn(() => ({ promise: () => Promise.resolve({}) }));
    const deps = createMockDeps({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: curatorUser }) })),
      update: updateMock,
      put: jest.fn(() => ({ promise: () => Promise.resolve({}) }))
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      body: JSON.stringify({
        festivalId: 'fest-abc',
        festivalName: 'Test Festival',
        add: ['event-1', 'event-2', 'event-3']
      })
    });

    const res = await handleCuratorFestivalTag(deps, event);
    const body = JSON.parse(res.body);

    expect(body.tagged).toHaveLength(3);
    expect(updateMock).toHaveBeenCalledTimes(3);
  });
});

describe('Festival Tag - Remove Operations', () => {
  it('untag removes linkage when event is tagged to this festival', async () => {
    const updateMock = jest.fn(() => ({ promise: () => Promise.resolve({}) }));
    const deps = createMockDeps({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: curatorUser }) })),
      update: updateMock,
      put: jest.fn(() => ({ promise: () => Promise.resolve({}) }))
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      body: JSON.stringify({
        festivalId: 'fest-abc',
        remove: ['event-tagged-to-abc']
      })
    });

    const res = await handleCuratorFestivalTag(deps, event);
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.untagged).toContain('event-tagged-to-abc');

    // Verify remove condition
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      ConditionExpression: expect.stringMatching(/festivalId = :fid/),
      UpdateExpression: expect.stringMatching(/REMOVE festivalId/)
    }));
  });

  it('untag skips when event is tagged to ANOTHER festival', async () => {
    const updateMock = jest.fn(() => ({
      promise: () => Promise.reject({ code: 'ConditionalCheckFailedException' })
    }));
    const deps = createMockDeps({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: curatorUser }) })),
      update: updateMock,
      put: jest.fn(() => ({ promise: () => Promise.resolve({}) }))
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      body: JSON.stringify({
        festivalId: 'fest-abc',
        remove: ['event-tagged-to-xyz']
      })
    });

    const res = await handleCuratorFestivalTag(deps, event);
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.untagged).toHaveLength(0);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].reason).toMatch(/not found|not tagged to this festival/i);
  });
});

describe('Festival Tag - Mixed Add/Remove', () => {
  it('handles add and remove in one call', async () => {
    let callCount = 0;
    const updateMock = jest.fn(() => {
      callCount++;
      // First 2 are adds, last 1 is remove
      return { promise: () => Promise.resolve({}) };
    });
    const deps = createMockDeps({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: curatorUser }) })),
      update: updateMock,
      put: jest.fn(() => ({ promise: () => Promise.resolve({}) }))
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      body: JSON.stringify({
        festivalId: 'fest-abc',
        festivalName: 'Test Festival',
        add: ['event-new-1', 'event-new-2'],
        remove: ['event-old-1']
      })
    });

    const res = await handleCuratorFestivalTag(deps, event);
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.tagged).toHaveLength(2);
    expect(body.untagged).toHaveLength(1);
    expect(updateMock).toHaveBeenCalledTimes(3);
  });
});

describe('Festival Tag - Activity Logging', () => {
  it('logs activity with counts', async () => {
    const putMock = jest.fn(() => ({ promise: () => Promise.resolve({}) }));
    const deps = createMockDeps({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: curatorUser }) })),
      update: jest.fn(() => ({ promise: () => Promise.resolve({}) })),
      put: putMock
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      body: JSON.stringify({
        festivalId: 'fest-abc',
        festivalName: 'Activity Test Festival',
        add: ['event-1', 'event-2']
      })
    });

    await handleCuratorFestivalTag(deps, event);

    const activityPut = putMock.mock.calls.find(c => c[0].TableName === 'bndy-activity-log');
    expect(activityPut).toBeDefined();
    expect(activityPut[0].Item.action).toBe('festival-tag');
    expect(activityPut[0].Item.entity_type).toBe('festival');
    expect(activityPut[0].Item.entity_id).toBe('fest-abc');
    expect(activityPut[0].Item.detail).toMatch(/tagged 2/);
  });
});
