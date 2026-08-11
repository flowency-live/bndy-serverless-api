/**
 * Users Lambda - Favourites Tests
 *
 * Backlog feature 3: favourites live as string sets on the bndy-users record.
 * Routes:
 *   GET  /users/favourites          -> { artistIds: [], venueIds: [] }
 *   POST /users/favourites/toggle   -> { type, id, favourite } idempotent add/remove
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

// DocumentClient sets: emulate createSet with a marker object.
const fakeSet = (values) => ({ values, type: 'String' });

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (params) => ({ promise: () => mockDynamoDB.get(params) }),
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      scan: (params) => ({ promise: () => mockDynamoDB.scan(params) }),
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      delete: (params) => ({ promise: () => mockDynamoDB.delete(params) }),
      update: (params) => ({ promise: () => mockDynamoDB.update(params) }),
      createSet: (values) => fakeSet(values)
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

const createSessionToken = (userId = 'test-user-id') =>
  jwt.sign({ userId, email: 'test@example.com', username: 'testuser' }, 'test-jwt-secret', {
    expiresIn: '90d'
  });

const makeEvent = (method, path, { token, body } = {}) => ({
  requestContext: { http: { method, path } },
  cookies: token ? [`bndy_session=${token}`] : [],
  headers: {},
  body: body ? JSON.stringify(body) : undefined
});

describe('GET /users/favourites', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 401 when not authenticated', async () => {
    const res = await handler(makeEvent('GET', '/users/favourites'), {});
    expect(res.statusCode).toBe(401);
  });

  test('returns empty arrays for a user with no favourites', async () => {
    mockDynamoDB.get.mockResolvedValue({ Item: { cognito_id: 'test-user-id' } });
    const res = await handler(
      makeEvent('GET', '/users/favourites', { token: createSessionToken() }),
      {}
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ artistIds: [], venueIds: [] });
  });

  test('returns stored favourites as arrays', async () => {
    mockDynamoDB.get.mockResolvedValue({
      Item: {
        cognito_id: 'test-user-id',
        favourite_artist_ids: fakeSet(['a1', 'a2']),
        favourite_venue_ids: fakeSet(['v1'])
      }
    });
    const res = await handler(
      makeEvent('GET', '/users/favourites', { token: createSessionToken() }),
      {}
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.artistIds.sort()).toEqual(['a1', 'a2']);
    expect(body.venueIds).toEqual(['v1']);
  });

  test('returns 404 when the user record is missing', async () => {
    mockDynamoDB.get.mockResolvedValue({});
    const res = await handler(
      makeEvent('GET', '/users/favourites', { token: createSessionToken() }),
      {}
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /users/favourites/toggle', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 401 when not authenticated', async () => {
    const res = await handler(
      makeEvent('POST', '/users/favourites/toggle', {
        body: { type: 'artist', id: 'a1', favourite: true }
      }),
      {}
    );
    expect(res.statusCode).toBe(401);
  });

  test('adds an artist favourite with ADD on the artist set', async () => {
    mockDynamoDB.update.mockResolvedValue({});
    const res = await handler(
      makeEvent('POST', '/users/favourites/toggle', {
        token: createSessionToken(),
        body: { type: 'artist', id: 'a1', favourite: true }
      }),
      {}
    );
    expect(res.statusCode).toBe(200);
    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.Key).toEqual({ cognito_id: 'test-user-id' });
    expect(params.UpdateExpression).toMatch(/^ADD /);
    expect(params.UpdateExpression).toContain('favourite_artist_ids');
    expect(params.ExpressionAttributeValues[':ids'].values).toEqual(['a1']);
    expect(JSON.parse(res.body)).toEqual({ success: true, type: 'artist', id: 'a1', favourite: true });
  });

  test('removes a venue favourite with DELETE on the venue set', async () => {
    mockDynamoDB.update.mockResolvedValue({});
    const res = await handler(
      makeEvent('POST', '/users/favourites/toggle', {
        token: createSessionToken(),
        body: { type: 'venue', id: 'v9', favourite: false }
      }),
      {}
    );
    expect(res.statusCode).toBe(200);
    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).toMatch(/^DELETE /);
    expect(params.UpdateExpression).toContain('favourite_venue_ids');
    expect(params.ExpressionAttributeValues[':ids'].values).toEqual(['v9']);
  });

  test('rejects an unknown type with 400', async () => {
    const res = await handler(
      makeEvent('POST', '/users/favourites/toggle', {
        token: createSessionToken(),
        body: { type: 'gig', id: 'g1', favourite: true }
      }),
      {}
    );
    expect(res.statusCode).toBe(400);
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });

  test('rejects a missing id with 400', async () => {
    const res = await handler(
      makeEvent('POST', '/users/favourites/toggle', {
        token: createSessionToken(),
        body: { type: 'artist', favourite: true }
      }),
      {}
    );
    expect(res.statusCode).toBe(400);
  });

  test('rejects a non-boolean favourite flag with 400', async () => {
    const res = await handler(
      makeEvent('POST', '/users/favourites/toggle', {
        token: createSessionToken(),
        body: { type: 'artist', id: 'a1', favourite: 'yes' }
      }),
      {}
    );
    expect(res.statusCode).toBe(400);
  });

  test('rejects an oversize id with 400', async () => {
    const res = await handler(
      makeEvent('POST', '/users/favourites/toggle', {
        token: createSessionToken(),
        body: { type: 'artist', id: 'x'.repeat(201), favourite: true }
      }),
      {}
    );
    expect(res.statusCode).toBe(400);
  });
});
