/**
 * Users Lambda - API Route Alias Tests
 *
 * Tests that both legacy /users/* paths and new /api/users/* paths
 * hit identical handler logic. Required for bndy.live same-origin auth.
 *
 * CloudFront on bndy.live routes /api/* to API Gateway.
 * backstage.bndy.co.uk uses legacy /users/* paths.
 * Both must work identically.
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

const createSessionToken = (userId = 'test-user-id') =>
  jwt.sign({ userId, email: 'test@example.com', username: 'testuser' }, 'test-jwt-secret', {
    expiresIn: '90d'
  });

const makeEvent = (method, path, token = null, body = null) => ({
  requestContext: { http: { method, path } },
  cookies: token ? [`bndy_session=${token}`] : [],
  headers: {},
  body: body ? JSON.stringify(body) : null
});

describe('API route alias - /api/users/* normalization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default mock for user lookup
    mockDynamoDB.get.mockResolvedValue({ Item: { cognito_id: 'test-user-id' } });
  });

  describe('path normalization - same DynamoDB calls', () => {
    it('GET /users/profile and GET /api/users/profile make identical DB calls', async () => {
      const token = createSessionToken();

      await handler(makeEvent('GET', '/users/profile', token));
      const legacyCalls = [...mockDynamoDB.get.mock.calls];

      mockDynamoDB.get.mockClear();

      await handler(makeEvent('GET', '/api/users/profile', token));
      const aliasCalls = [...mockDynamoDB.get.mock.calls];

      expect(aliasCalls.length).toBe(legacyCalls.length);
      // The TableName and Key should match
      expect(aliasCalls[0][0].TableName).toBe(legacyCalls[0][0].TableName);
      expect(aliasCalls[0][0].Key).toEqual(legacyCalls[0][0].Key);
    });

    it('GET /users/favourites and GET /api/users/favourites make identical DB calls', async () => {
      const token = createSessionToken();

      await handler(makeEvent('GET', '/users/favourites', token));
      const legacyCalls = [...mockDynamoDB.get.mock.calls];

      mockDynamoDB.get.mockClear();

      await handler(makeEvent('GET', '/api/users/favourites', token));
      const aliasCalls = [...mockDynamoDB.get.mock.calls];

      expect(aliasCalls.length).toBe(legacyCalls.length);
      expect(aliasCalls[0][0].TableName).toBe(legacyCalls[0][0].TableName);
    });

    it('POST /users/favourites/toggle and POST /api/users/favourites/toggle return same status', async () => {
      const token = createSessionToken();
      const body = { type: 'artist', id: 'artist-123' };
      mockDynamoDB.update.mockResolvedValue({});

      const legacyRes = await handler(makeEvent('POST', '/users/favourites/toggle', token, body));
      const aliasRes = await handler(makeEvent('POST', '/api/users/favourites/toggle', token, body));

      // Both should reach the same handler and return identical status
      expect(aliasRes.statusCode).toBe(legacyRes.statusCode);
    });

    it('PUT /users/profile and PUT /api/users/profile make identical DB calls', async () => {
      const token = createSessionToken();
      const body = { username: 'newname' };

      await handler(makeEvent('PUT', '/users/profile', token, body));
      const legacyCalls = [...mockDynamoDB.update.mock.calls];

      mockDynamoDB.update.mockClear();

      await handler(makeEvent('PUT', '/api/users/profile', token, body));
      const aliasCalls = [...mockDynamoDB.update.mock.calls];

      expect(aliasCalls.length).toBe(legacyCalls.length);
    });
  });

  describe('status codes match', () => {
    it('unauthenticated requests return same status for both paths', async () => {
      const legacyRes = await handler(makeEvent('GET', '/users/profile'));
      const aliasRes = await handler(makeEvent('GET', '/api/users/profile'));

      expect(aliasRes.statusCode).toBe(legacyRes.statusCode);
    });

    it('authenticated requests return same status for both paths', async () => {
      const token = createSessionToken();

      const legacyRes = await handler(makeEvent('GET', '/users/profile', token));
      const aliasRes = await handler(makeEvent('GET', '/api/users/profile', token));

      expect(aliasRes.statusCode).toBe(legacyRes.statusCode);
    });
  });

  describe('path normalization edge cases', () => {
    it('does not normalize /api/community/flags (different prefix)', async () => {
      // This route should NOT be normalized - it's not /api/users/*
      const token = createSessionToken();
      const event = makeEvent('POST', '/api/community/flags', token, {
        entityType: 'venue',
        entityId: 'v-1',
        reason: 'test'
      });

      // Should still reach the flags handler (no normalization needed)
      const response = await handler(event);
      // 200 expected for valid flag creation
      expect(response.statusCode).toBe(200);
    });

    it('normalizes /api/users/activity to /users/activity', async () => {
      const token = createSessionToken();
      mockDynamoDB.query.mockResolvedValue({ Items: [] });

      const legacyRes = await handler(makeEvent('GET', '/users/activity', token));
      const aliasRes = await handler(makeEvent('GET', '/api/users/activity', token));

      expect(aliasRes.statusCode).toBe(legacyRes.statusCode);
    });

    it('does not normalize paths that only start with /apiusers (no slash)', async () => {
      // A malformed path like /apiusers/profile should not match
      const token = createSessionToken();
      const response = await handler(makeEvent('GET', '/apiusers/profile', token));

      // Should 404 - not a valid route
      expect(response.statusCode).toBe(404);
    });
  });
});
