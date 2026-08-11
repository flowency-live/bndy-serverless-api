/**
 * Users Lambda - Flag a problem tests (backlog feature 6)
 *
 * Routes:
 *   POST /api/community/flags       PUBLIC - anyone flags a record with a reason
 *   GET  /users/flags               platformAdmin - open flags for godmode
 *   PUT  /users/flags/{flagId}/resolve  platformAdmin - close a flag
 */

process.env.JWT_SECRET = 'test-jwt-secret';

const mockDynamoDB = {
  get: jest.fn(),
  put: jest.fn(),
  scan: jest.fn(),
  query: jest.fn(),
  delete: jest.fn(),
  update: jest.fn()
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (p) => ({ promise: () => mockDynamoDB.get(p) }),
      put: (p) => ({ promise: () => mockDynamoDB.put(p) }),
      scan: (p) => ({ promise: () => mockDynamoDB.scan(p) }),
      query: (p) => ({ promise: () => mockDynamoDB.query(p) }),
      delete: (p) => ({ promise: () => mockDynamoDB.delete(p) }),
      update: (p) => ({ promise: () => mockDynamoDB.update(p) }),
      createSet: (v) => ({ values: v, type: 'String' })
    }))
  },
  SSM: jest.fn(() => ({
    getParameter: () => ({ promise: () => Promise.resolve({ Parameter: { Value: 'test-jwt-secret' } }) })
  }))
}));

const jwt = require('jsonwebtoken');
const { handler } = require('../handler');

const token = (userId = 'user-1') =>
  jwt.sign({ userId, username: 'u' }, 'test-jwt-secret', { expiresIn: '1d' });

const makeEvent = (method, path, { tok, body, pathParameters } = {}) => ({
  requestContext: { http: { method, path } },
  cookies: tok ? [`bndy_session=${tok}`] : [],
  headers: {},
  pathParameters,
  body: body ? JSON.stringify(body) : undefined
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDynamoDB.put.mockResolvedValue({});
  mockDynamoDB.update.mockResolvedValue({});
});

describe('POST /api/community/flags', () => {
  test('anonymous flag is accepted and stored open', async () => {
    const res = await handler(makeEvent('POST', '/api/community/flags', {
      body: { entityType: 'venue', entityId: 'v1', entityName: 'The Vic', reason: 'This venue closed down last month' }
    }), {});
    expect(res.statusCode).toBe(200);
    const flagPut = mockDynamoDB.put.mock.calls.find(c => c[0].TableName === 'bndy-flags');
    expect(flagPut[0].Item.status).toBe('open');
    expect(flagPut[0].Item.reporter_user_id).toBeNull();
    expect(flagPut[0].Item.gsi_status).toBe('open');
    // the activity feed also gets a row so godmode sees it at once
    const logPut = mockDynamoDB.put.mock.calls.find(c => c[0].TableName === 'bndy-activity-log');
    expect(logPut[0].Item.action).toBe('flag');
    expect(logPut[0].Item.user_id).toBe('anonymous');
  });

  test('signed-in flag records the reporter', async () => {
    mockDynamoDB.get.mockResolvedValue({ Item: { cognito_id: 'user-1', display_name: 'Norm' } });
    const res = await handler(makeEvent('POST', '/api/community/flags', {
      tok: token('user-1'),
      body: { entityType: 'artist', entityId: 'a1', reason: 'Wrong Facebook page linked' }
    }), {});
    expect(res.statusCode).toBe(200);
    const flagPut = mockDynamoDB.put.mock.calls.find(c => c[0].TableName === 'bndy-flags');
    expect(flagPut[0].Item.reporter_user_id).toBe('user-1');
  });

  test('bad entityType is a 400', async () => {
    const res = await handler(makeEvent('POST', '/api/community/flags', {
      body: { entityType: 'gig', entityId: 'x', reason: 'valid reason here' }
    }), {});
    expect(res.statusCode).toBe(400);
  });

  test('reason too short is a 400', async () => {
    const res = await handler(makeEvent('POST', '/api/community/flags', {
      body: { entityType: 'venue', entityId: 'v1', reason: 'x' }
    }), {});
    expect(res.statusCode).toBe(400);
  });

  test('reason too long is a 400', async () => {
    const res = await handler(makeEvent('POST', '/api/community/flags', {
      body: { entityType: 'venue', entityId: 'v1', reason: 'x'.repeat(501) }
    }), {});
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /users/flags', () => {
  test('403 for a non-admin', async () => {
    mockDynamoDB.get.mockResolvedValue({ Item: { cognito_id: 'user-1' } });
    const res = await handler(makeEvent('GET', '/users/flags', { tok: token('user-1') }), {});
    expect(res.statusCode).toBe(403);
  });

  test('admin lists open flags newest first', async () => {
    mockDynamoDB.get.mockResolvedValue({ Item: { cognito_id: 'admin-1', platformAdmin: true } });
    mockDynamoDB.query.mockResolvedValue({ Items: [
      { id: 'f1', entity_type: 'venue', entity_id: 'v1', reason: 'closed', status: 'open', created_at: '2026-08-11T10:00:00Z' }
    ] });
    const res = await handler(makeEvent('GET', '/users/flags', { tok: token('admin-1') }), {});
    expect(res.statusCode).toBe(200);
    const q = mockDynamoDB.query.mock.calls[0][0];
    expect(q.TableName).toBe('bndy-flags');
    expect(q.IndexName).toBe('ByStatus');
    expect(q.ExpressionAttributeValues[':open']).toBe('open');
    expect(JSON.parse(res.body).flags).toHaveLength(1);
  });
});

describe('PUT /users/flags/{flagId}/resolve', () => {
  test('admin resolves a flag', async () => {
    mockDynamoDB.get.mockResolvedValue({ Item: { cognito_id: 'admin-1', platformAdmin: true, display_name: 'Jason' } });
    const res = await handler(makeEvent('PUT', '/users/flags/f1/resolve', {
      tok: token('admin-1'), pathParameters: { flagId: 'f1' }
    }), {});
    expect(res.statusCode).toBe(200);
    const upd = mockDynamoDB.update.mock.calls[0][0];
    expect(upd.TableName).toBe('bndy-flags');
    expect(upd.Key).toEqual({ id: 'f1' });
    expect(upd.ExpressionAttributeValues[':resolved']).toBe('resolved');
  });

  test('403 for a non-admin', async () => {
    mockDynamoDB.get.mockResolvedValue({ Item: { cognito_id: 'user-1' } });
    const res = await handler(makeEvent('PUT', '/users/flags/f1/resolve', {
      tok: token('user-1'), pathParameters: { flagId: 'f1' }
    }), {});
    expect(res.statusCode).toBe(403);
  });
});
