/**
 * WP-05A: MCP service token on event lifecycle routes.
 *
 * The projection engine in bndy-enrichment cancels, uncancels, hides and
 * restores events with the MCP service token. These tests pin the gate:
 *
 * - valid Bearer MCP_SERVICE_TOKEN acts as staff on all four routes
 * - invalid Bearer is 401 and NEVER falls through to the cookie path
 * - missing MCP_SERVICE_TOKEN config is 500
 * - the cookie curator path is unchanged
 * - the audit row names the actor MCP
 */

const jwt = require('jsonwebtoken');
const {
  handleCuratorCancelEvent,
  handleCuratorUncancelEvent,
  handleCuratorHideEvent,
  handleCuratorRestoreEvent
} = require('./curator');

const JWT_SECRET = 'test-secret';
const SERVICE_TOKEN = 'svc-token-abc';

const OLD_TOKEN = process.env.MCP_SERVICE_TOKEN;
beforeAll(() => { process.env.MCP_SERVICE_TOKEN = SERVICE_TOKEN; });
afterAll(() => { if (OLD_TOKEN === undefined) delete process.env.MCP_SERVICE_TOKEN; else process.env.MCP_SERVICE_TOKEN = OLD_TOKEN; });

const curatorUser = { cognito_id: 'user-123', role: 'curator', display_name: 'Test Curator' };

function createMockDeps() {
  const dynamodb = {
    put: jest.fn(() => ({ promise: () => Promise.resolve({}) })),
    update: jest.fn(() => ({ promise: () => Promise.resolve({}) })),
    get: jest.fn(({ TableName, Key }) => ({
      promise: () => {
        if (TableName === 'bndy-users') return Promise.resolve({ Item: curatorUser });
        if (TableName === 'bndy-events') return Promise.resolve({ Item: { id: Key.id, title: 'Test Gig' } });
        return Promise.resolve({ Item: null });
      }
    })),
    query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) }))
  };
  return {
    dynamodb,
    ssm: {
      getParameter: jest.fn(() => ({ promise: () => Promise.resolve({ Parameter: { Value: JWT_SECRET } }) }))
    },
    getCorsHeaders: () => ({ 'Content-Type': 'application/json' })
  };
}

function mcpEvent(overrides = {}) {
  return {
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    cookies: [],
    body: '{}',
    pathParameters: { id: 'evt-1' },
    ...overrides
  };
}

function cookieEvent(overrides = {}) {
  return {
    headers: {},
    cookies: [`bndy_session=${jwt.sign({ userId: 'user-123' }, JWT_SECRET)}`],
    body: '{}',
    pathParameters: { id: 'evt-1' },
    ...overrides
  };
}

describe('WP-05A: MCP service token on lifecycle routes', () => {
  it('cancel with valid service token returns 200 and sets cancelled', async () => {
    const deps = createMockDeps();
    const res = await handleCuratorCancelEvent(deps, mcpEvent({ body: JSON.stringify({ reason: 'source cancelled' }) }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true, id: 'evt-1', cancelled: true });
    const update = deps.dynamodb.update.mock.calls.find(([p]) => p.TableName === 'bndy-events');
    expect(update[0].UpdateExpression).toContain('cancelled = :true');
    expect(update[0].ExpressionAttributeValues[':by']).toBe('mcp-service');
    expect(update[0].ExpressionAttributeValues[':reason']).toBe('source cancelled');
  });

  it('cancel audit row names the actor MCP', async () => {
    const deps = createMockDeps();
    await handleCuratorCancelEvent(deps, mcpEvent());
    const audit = deps.dynamodb.put.mock.calls.find(([p]) => p.TableName === 'bndy-activity-log');
    expect(audit).toBeDefined();
    expect(audit[0].Item.actor_name).toBe('MCP');
  });

  it('uncancel with valid service token returns 200', async () => {
    const deps = createMockDeps();
    const res = await handleCuratorUncancelEvent(deps, mcpEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).cancelled).toBe(false);
  });

  it('hide with valid service token returns 200', async () => {
    const deps = createMockDeps();
    const res = await handleCuratorHideEvent(deps, mcpEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).hidden).toBe(true);
  });

  it('restore with valid service token passes the staff-only gate', async () => {
    const deps = createMockDeps();
    const res = await handleCuratorRestoreEvent(deps, mcpEvent());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).hidden).toBe(false);
  });

  it('invalid bearer is 401 and performs no write', async () => {
    const deps = createMockDeps();
    const res = await handleCuratorCancelEvent(deps, mcpEvent({ headers: { Authorization: 'Bearer wrong-token' } }));
    expect(res.statusCode).toBe(401);
    expect(deps.dynamodb.update).not.toHaveBeenCalled();
  });

  it('invalid bearer never falls through to a valid cookie', async () => {
    const deps = createMockDeps();
    const event = cookieEvent();
    event.headers = { Authorization: 'Bearer wrong-token' };
    const res = await handleCuratorCancelEvent(deps, event);
    expect(res.statusCode).toBe(401);
    expect(deps.dynamodb.update).not.toHaveBeenCalled();
  });

  it('missing MCP_SERVICE_TOKEN config is 500', async () => {
    const saved = process.env.MCP_SERVICE_TOKEN;
    delete process.env.MCP_SERVICE_TOKEN;
    try {
      const deps = createMockDeps();
      const res = await handleCuratorCancelEvent(deps, mcpEvent());
      expect(res.statusCode).toBe(500);
    } finally {
      process.env.MCP_SERVICE_TOKEN = saved;
    }
  });

  it('cookie curator path is unchanged', async () => {
    const deps = createMockDeps();
    const res = await handleCuratorCancelEvent(deps, cookieEvent({ body: JSON.stringify({ reason: 'double booked' }) }));
    expect(res.statusCode).toBe(200);
    const update = deps.dynamodb.update.mock.calls.find(([p]) => p.TableName === 'bndy-events');
    expect(update[0].ExpressionAttributeValues[':by']).toBe('user-123');
  });

  it('no bearer and no cookie is 401', async () => {
    const deps = createMockDeps();
    const res = await handleCuratorCancelEvent(deps, mcpEvent({ headers: {} }));
    expect(res.statusCode).toBe(401);
  });
});
