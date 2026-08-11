/**
 * Curator route tests (backlog feature 4) — venues lambda.
 * The same gate + whitelist + log pattern runs in events and artists.
 */

process.env.JWT_SECRET = 'test-jwt-secret';

const mockDynamoDB = {
  get: jest.fn(),
  put: jest.fn(),
  update: jest.fn(),
  query: jest.fn(),
  scan: jest.fn(),
  delete: jest.fn()
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (p) => ({ promise: () => mockDynamoDB.get(p) }),
      put: (p) => ({ promise: () => mockDynamoDB.put(p) }),
      update: (p) => ({ promise: () => mockDynamoDB.update(p) }),
      query: (p) => ({ promise: () => mockDynamoDB.query(p) }),
      scan: (p) => ({ promise: () => mockDynamoDB.scan(p) }),
      delete: (p) => ({ promise: () => mockDynamoDB.delete(p) })
    }))
  },
  SSM: jest.fn(() => ({
    getParameter: () => ({ promise: () => Promise.reject(new Error('use env')) })
  }))
}));

jest.mock('../handlers/venues-routes', () => ({
  handleUpdateVenue: jest.fn().mockResolvedValue({ statusCode: 200, headers: {}, body: '{}' })
}));

const jwt = require('jsonwebtoken');
const AWS = require('aws-sdk');
const { handleUpdateVenue } = require('../handlers/venues-routes');
const { handleCuratorUpdateVenue, handleCuratorHideVenue, handleCuratorRestoreVenue } = require('../handlers/curator');

const deps = {
  dynamodb: new AWS.DynamoDB.DocumentClient(),
  ssm: new AWS.SSM(),
  getCorsHeaders: () => ({})
};

const token = (userId) => jwt.sign({ userId }, 'test-jwt-secret', { expiresIn: '1d' });

const makeEvent = (method, path, { userId, body, id } = {}) => ({
  requestContext: { http: { method, path } },
  cookies: userId ? [`bndy_session=${token(userId)}`] : [],
  headers: {},
  pathParameters: { id: id || 'v1' },
  body: body ? JSON.stringify(body) : undefined
});

// bndy-users records by role
const userRecord = (role, extra = {}) => ({ Item: { cognito_id: 'u1', display_name: 'Cara', role, ...extra } });

// dynamodb.get is used for BOTH the role lookup (bndy-users) and the name
// lookup (bndy-venues) — route on TableName.
const wireGets = (roleItem, venueItem = { Item: { id: 'v1', name: 'The Vic' } }) => {
  mockDynamoDB.get.mockImplementation((p) =>
    p.TableName === 'bndy-users' ? Promise.resolve(roleItem) : Promise.resolve(venueItem)
  );
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDynamoDB.update.mockResolvedValue({});
  mockDynamoDB.put.mockResolvedValue({});
});

describe('curator venue edit', () => {
  test('401 with no session', async () => {
    const res = await handleCuratorUpdateVenue(deps, makeEvent('PUT', '/api/curator/venues/v1', { body: { website: 'https://x' } }));
    expect(res.statusCode).toBe(401);
  });

  test('403 for a plain user', async () => {
    wireGets(userRecord('user'));
    const res = await handleCuratorUpdateVenue(deps, makeEvent('PUT', '/api/curator/venues/v1', { userId: 'u1', body: { website: 'https://x' } }));
    expect(res.statusCode).toBe(403);
    expect(handleUpdateVenue).not.toHaveBeenCalled();
  });

  test('curator edit passes the whitelist through and logs activity', async () => {
    wireGets(userRecord('curator'));
    const res = await handleCuratorUpdateVenue(deps, makeEvent('PUT', '/api/curator/venues/v1', {
      userId: 'u1',
      body: { website: 'https://x', name: 'HACKED', googlePlaceId: 'HACKED', latitude: 1 }
    }));
    expect(res.statusCode).toBe(200);
    const passed = handleUpdateVenue.mock.calls[0][2];
    expect(passed).toEqual({ website: 'https://x' }); // identity fields stripped
    const logPut = mockDynamoDB.put.mock.calls.find(c => c[0].TableName === 'bndy-activity-log');
    expect(logPut[0].Item.action).toBe('edit');
    expect(logPut[0].Item.entity_type).toBe('venue');
  });

  test('curator cannot blank the postcode', async () => {
    wireGets(userRecord('curator'));
    const res = await handleCuratorUpdateVenue(deps, makeEvent('PUT', '/api/curator/venues/v1', {
      userId: 'u1', body: { postcode: '' }
    }));
    expect(res.statusCode).toBe(422);
    expect(handleUpdateVenue).not.toHaveBeenCalled();
  });

  test('body with only forbidden fields is a 400', async () => {
    wireGets(userRecord('curator'));
    const res = await handleCuratorUpdateVenue(deps, makeEvent('PUT', '/api/curator/venues/v1', {
      userId: 'u1', body: { name: 'New Name' }
    }));
    expect(res.statusCode).toBe(400);
  });
});

describe('curator venue hide / restore', () => {
  test('curator hide sets the hidden flag and logs', async () => {
    wireGets(userRecord('curator'));
    const res = await handleCuratorHideVenue(deps, makeEvent('POST', '/api/curator/venues/v1/hide', {
      userId: 'u1', body: { reason: 'duplicate' }
    }));
    expect(res.statusCode).toBe(200);
    const upd = mockDynamoDB.update.mock.calls[0][0];
    expect(upd.TableName).toBe('bndy-venues');
    expect(upd.UpdateExpression).toContain('#hidden = :true');
    const logPut = mockDynamoDB.put.mock.calls.find(c => c[0].TableName === 'bndy-activity-log');
    expect(logPut[0].Item.action).toBe('hide');
    expect(logPut[0].Item.detail).toBe('duplicate');
  });

  test('curator cannot restore — staff only', async () => {
    wireGets(userRecord('curator'));
    const res = await handleCuratorRestoreVenue(deps, makeEvent('POST', '/api/curator/venues/v1/restore', { userId: 'u1' }));
    expect(res.statusCode).toBe(403);
  });

  test('staff restore clears the hidden flag', async () => {
    wireGets(userRecord('staff'));
    const res = await handleCuratorRestoreVenue(deps, makeEvent('POST', '/api/curator/venues/v1/restore', { userId: 'u1' }));
    expect(res.statusCode).toBe(200);
    const upd = mockDynamoDB.update.mock.calls[0][0];
    expect(upd.UpdateExpression).toContain('#hidden = :false');
    expect(upd.UpdateExpression).toContain('REMOVE hidden_by, hidden_at, hidden_reason');
  });

  test('platformAdmin passes every gate without a role field', async () => {
    wireGets({ Item: { cognito_id: 'u1', display_name: 'Jason', platformAdmin: true } });
    const res = await handleCuratorRestoreVenue(deps, makeEvent('POST', '/api/curator/venues/v1/restore', { userId: 'u1' }));
    expect(res.statusCode).toBe(200);
  });
});
