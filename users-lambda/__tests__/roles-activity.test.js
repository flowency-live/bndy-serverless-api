/**
 * Users Lambda - Role management + activity log tests (backlog feature 4)
 *
 * Routes:
 *   PUT /users/{userId}/role        platformAdmin only. Sets role on the user record.
 *   GET /users/activity             own activity, newest first
 *   GET /users/activity/all         platformAdmin: recent activity across all users
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
      get: (params) => ({ promise: () => mockDynamoDB.get(params) }),
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      scan: (params) => ({ promise: () => mockDynamoDB.scan(params) }),
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      delete: (params) => ({ promise: () => mockDynamoDB.delete(params) }),
      update: (params) => ({ promise: () => mockDynamoDB.update(params) }),
      createSet: (values) => ({ values, type: 'String' })
    }))
  },
  SSM: jest.fn(() => ({
    getParameter: () => ({
      promise: () => Promise.resolve({ Parameter: { Value: 'test-jwt-secret' } })
    })
  }))
}));

const jwt = require('jsonwebtoken');
const { handler } = require('../handler');

const token = (userId = 'admin-cognito-id') =>
  jwt.sign({ userId, email: 'a@b.c', username: 'admin' }, 'test-jwt-secret', { expiresIn: '90d' });

const makeEvent = (method, path, { tok, body, pathParameters, queryStringParameters } = {}) => ({
  requestContext: { http: { method, path } },
  cookies: tok ? [`bndy_session=${tok}`] : [],
  headers: {},
  pathParameters,
  queryStringParameters,
  body: body ? JSON.stringify(body) : undefined
});

const adminUser = { cognito_id: 'admin-cognito-id', user_id: 'admin-uuid', platformAdmin: true, display_name: 'Jason' };
const normalUser = { cognito_id: 'user-cognito-id', user_id: 'user-uuid', display_name: 'Norm' };

describe('PUT /users/{userId}/role', () => {
  beforeEach(() => jest.clearAllMocks());

  test('401 when not authenticated', async () => {
    const res = await handler(makeEvent('PUT', '/users/target-uuid/role', {
      pathParameters: { userId: 'target-uuid' }, body: { role: 'curator' }
    }), {});
    expect(res.statusCode).toBe(401);
  });

  test('403 for a non-admin caller', async () => {
    mockDynamoDB.get.mockResolvedValue({ Item: normalUser });
    const res = await handler(makeEvent('PUT', '/users/target-uuid/role', {
      tok: token('user-cognito-id'), pathParameters: { userId: 'target-uuid' }, body: { role: 'curator' }
    }), {});
    expect(res.statusCode).toBe(403);
  });

  test('400 on an unknown role value', async () => {
    mockDynamoDB.get.mockResolvedValue({ Item: adminUser });
    const res = await handler(makeEvent('PUT', '/users/target-uuid/role', {
      tok: token(), pathParameters: { userId: 'target-uuid' }, body: { role: 'wizard' }
    }), {});
    expect(res.statusCode).toBe(400);
  });

  test('admin sets curator role; role update + activity log written', async () => {
    mockDynamoDB.get.mockResolvedValue({ Item: adminUser });
    mockDynamoDB.scan.mockResolvedValue({ Items: [{ cognito_id: 'target-cognito', user_id: 'target-uuid', display_name: 'Cara' }] });
    mockDynamoDB.update.mockResolvedValue({});
    mockDynamoDB.put.mockResolvedValue({});

    const res = await handler(makeEvent('PUT', '/users/target-uuid/role', {
      tok: token(), pathParameters: { userId: 'target-uuid' }, body: { role: 'curator' }
    }), {});

    expect(res.statusCode).toBe(200);
    const upd = mockDynamoDB.update.mock.calls[0][0];
    expect(upd.Key).toEqual({ cognito_id: 'target-cognito' });
    expect(upd.ExpressionAttributeValues[':role']).toBe('curator');

    const logPut = mockDynamoDB.put.mock.calls.find(c => c[0].TableName === 'bndy-activity-log');
    expect(logPut).toBeTruthy();
    expect(logPut[0].Item.action).toBe('set-role');
    expect(logPut[0].Item.gsi_pk).toBe('ALL');
  });

  test('404 when the target user does not exist', async () => {
    mockDynamoDB.get.mockResolvedValue({ Item: adminUser });
    mockDynamoDB.scan.mockResolvedValue({ Items: [] });
    const res = await handler(makeEvent('PUT', '/users/missing/role', {
      tok: token(), pathParameters: { userId: 'missing' }, body: { role: 'curator' }
    }), {});
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /users/activity', () => {
  beforeEach(() => jest.clearAllMocks());

  test('401 when not authenticated', async () => {
    const res = await handler(makeEvent('GET', '/users/activity'), {});
    expect(res.statusCode).toBe(401);
  });

  test('returns own entries newest first via query on the caller partition', async () => {
    mockDynamoDB.query.mockResolvedValue({ Items: [
      { user_id: 'user-cognito-id', sk: '2026-08-11T10:00:00Z#b', action: 'edit', entity_type: 'venue', entity_id: 'v1', entity_name: 'The Vic', at: '2026-08-11T10:00:00Z' }
    ] });
    const res = await handler(makeEvent('GET', '/users/activity', { tok: token('user-cognito-id') }), {});
    expect(res.statusCode).toBe(200);
    const q = mockDynamoDB.query.mock.calls[0][0];
    expect(q.TableName).toBe('bndy-activity-log');
    expect(q.ExpressionAttributeValues[':uid']).toBe('user-cognito-id');
    expect(q.ScanIndexForward).toBe(false);
    const body = JSON.parse(res.body);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].action).toBe('edit');
  });
});

describe('GET /users/activity/all', () => {
  beforeEach(() => jest.clearAllMocks());

  test('403 for a non-admin caller', async () => {
    mockDynamoDB.get.mockResolvedValue({ Item: normalUser });
    const res = await handler(makeEvent('GET', '/users/activity/all', { tok: token('user-cognito-id') }), {});
    expect(res.statusCode).toBe(403);
  });

  test('admin reads the ALL partition on the index, newest first', async () => {
    mockDynamoDB.get.mockResolvedValue({ Item: adminUser });
    mockDynamoDB.query.mockResolvedValue({ Items: [
      { user_id: 'x', sk: '2026-08-11T10:00:00Z#a', action: 'hide', entity_type: 'artist', entity_id: 'a1', at: '2026-08-11T10:00:00Z', gsi_pk: 'ALL' }
    ] });
    const res = await handler(makeEvent('GET', '/users/activity/all', { tok: token() }), {});
    expect(res.statusCode).toBe(200);
    const q = mockDynamoDB.query.mock.calls[0][0];
    expect(q.IndexName).toBe('AllByTime');
    expect(q.ExpressionAttributeValues[':all']).toBe('ALL');
    expect(q.ScanIndexForward).toBe(false);
  });

  test('action filter narrows to hide entries', async () => {
    mockDynamoDB.get.mockResolvedValue({ Item: adminUser });
    mockDynamoDB.query.mockResolvedValue({ Items: [] });
    const res = await handler(makeEvent('GET', '/users/activity/all', {
      tok: token(), queryStringParameters: { action: 'hide' }
    }), {});
    expect(res.statusCode).toBe(200);
    const q = mockDynamoDB.query.mock.calls[0][0];
    expect(q.FilterExpression).toContain('#action = :action');
    expect(q.ExpressionAttributeValues[':action']).toBe('hide');
  });
});
