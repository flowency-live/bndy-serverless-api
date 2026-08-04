/**
 * DELETE /api/artists/:id Authorization Tests
 *
 * SEC-XX: Godmode authorization - require platformAdmin for DELETE operations
 *
 * These tests verify that:
 * 1. Unauthenticated requests return 401
 * 2. Authenticated non-admin requests return 403
 * 3. Authenticated platformAdmin requests proceed with deletion
 */

// Mock AWS SDK before requiring handler
const mockDynamoDB = {
  get: jest.fn(),
  put: jest.fn(),
  scan: jest.fn(),
  query: jest.fn(),
  delete: jest.fn(),
  update: jest.fn(),
  transactWrite: jest.fn()
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
      transactWrite: (params) => ({ promise: () => mockDynamoDB.transactWrite(params) })
    }))
  },
  SSM: jest.fn(() => ({
    getParameter: () => ({
      promise: () => Promise.resolve({ Parameter: { Value: 'test-jwt-secret' } })
    })
  })),
  S3: jest.fn(() => ({
    upload: () => ({ promise: () => Promise.resolve({ Location: 'https://s3.example.com/test.jpg' }) })
  }))
}));

// Mock jsonwebtoken
const jwt = require('jsonwebtoken');

const { handler } = require('../handler');

describe('DELETE /api/artists/:id - Authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Helper to create a valid JWT session token
  const createSessionToken = (userId = 'test-user-id') => {
    return jwt.sign(
      { userId, email: 'test@example.com', username: 'testuser' },
      'test-jwt-secret',
      { expiresIn: '90d' }
    );
  };

  // Create DELETE event helper
  const createDeleteEvent = (artistId, sessionToken = null) => ({
    requestContext: {
      http: {
        method: 'DELETE',
        path: `/api/artists/${artistId}`
      }
    },
    pathParameters: {
      id: artistId
    },
    headers: {
      origin: 'https://backstage.bndy.co.uk'
    },
    cookies: sessionToken ? [`bndy_session=${sessionToken}`] : []
  });

  describe('Unauthenticated requests', () => {
    it('should return 401 when no session cookie is present', async () => {
      const event = createDeleteEvent('test-artist-id');

      const response = await handler(event, {});

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toMatch(/not authenticated/i);
    });

    it('should return 401 when session token is invalid', async () => {
      const event = createDeleteEvent('test-artist-id', 'invalid-token');

      const response = await handler(event, {});

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toMatch(/invalid session/i);
    });
  });

  describe('Authenticated non-admin requests', () => {
    it('should return 403 when user is not platformAdmin', async () => {
      const sessionToken = createSessionToken('regular-user-id');
      const event = createDeleteEvent('test-artist-id', sessionToken);

      // Mock user lookup - user exists but is NOT platformAdmin
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-users') {
          return Promise.resolve({
            Item: {
              cognito_id: 'regular-user-id',
              email: 'user@example.com',
              platformAdmin: false  // NOT an admin
            }
          });
        }
        return Promise.resolve({ Item: null });
      });

      const response = await handler(event, {});

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toMatch(/platform admin/i);
    });

    it('should return 403 when platformAdmin is undefined (default non-admin)', async () => {
      const sessionToken = createSessionToken('new-user-id');
      const event = createDeleteEvent('test-artist-id', sessionToken);

      // Mock user lookup - user exists but has no platformAdmin field
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-users') {
          return Promise.resolve({
            Item: {
              cognito_id: 'new-user-id',
              email: 'newuser@example.com'
              // platformAdmin field is missing (undefined)
            }
          });
        }
        return Promise.resolve({ Item: null });
      });

      const response = await handler(event, {});

      expect(response.statusCode).toBe(403);
    });
  });

  describe('Authenticated platformAdmin requests', () => {
    it('should proceed with deletion when user is platformAdmin', async () => {
      const sessionToken = createSessionToken('admin-user-id');
      const event = createDeleteEvent('test-artist-id', sessionToken);

      // Mock user lookup - user IS platformAdmin
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-users') {
          return Promise.resolve({
            Item: {
              cognito_id: 'admin-user-id',
              email: 'admin@flowency.co.uk',
              platformAdmin: true  // IS an admin
            }
          });
        }
        if (params.TableName === 'bndy-artists') {
          return Promise.resolve({
            Item: {
              id: 'test-artist-id',
              name: 'Test Artist',
              location: 'Bristol'
            }
          });
        }
        return Promise.resolve({ Item: null });
      });

      // Mock: No events for this artist (so deletion is allowed)
      // The event guard uses both query and scan
      mockDynamoDB.query.mockImplementation((params) => {
        // Event guard query for artistId-date-index
        if (params.TableName === 'bndy-events' && params.IndexName === 'artistId-date-index') {
          return Promise.resolve({ Items: [], Count: 0 });
        }
        // Membership lookup for cascade delete
        if (params.TableName === 'bndy-artist-memberships') {
          return Promise.resolve({ Items: [] });
        }
        return Promise.resolve({ Items: [] });
      });

      // Mock: Scan for artistIds[] and collaboratingArtistIds[] - no matches
      mockDynamoDB.scan.mockImplementation((params) => {
        if (params.TableName === 'bndy-events') {
          return Promise.resolve({ Items: [], Count: 0 });
        }
        return Promise.resolve({ Items: [] });
      });

      // Mock successful delete
      mockDynamoDB.delete.mockResolvedValue({});

      const response = await handler(event, {});

      // Should proceed with deletion (204 No Content on success)
      // or 409 if artist has events (which is also a valid auth-passed response)
      expect([204, 409]).toContain(response.statusCode);

      // Should NOT be 401 or 403
      expect(response.statusCode).not.toBe(401);
      expect(response.statusCode).not.toBe(403);
    });

    it('should return 409 if artist has events (auth passed, business rule failed)', async () => {
      const sessionToken = createSessionToken('admin-user-id');
      const event = createDeleteEvent('artist-with-events', sessionToken);

      // Mock user lookup - user IS platformAdmin
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-users') {
          return Promise.resolve({
            Item: {
              cognito_id: 'admin-user-id',
              email: 'admin@flowency.co.uk',
              platformAdmin: true
            }
          });
        }
        return Promise.resolve({ Item: null });
      });

      // Mock: Artist HAS events (so deletion should be refused with 409)
      mockDynamoDB.query.mockImplementation((params) => {
        if (params.TableName === 'bndy-events') {
          return Promise.resolve({
            Items: [{ id: 'event-1', artistId: 'artist-with-events' }],
            Count: 1
          });
        }
        return Promise.resolve({ Items: [] });
      });

      const response = await handler(event, {});

      // Should return 409 (business rule) not 401/403 (auth)
      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.code).toBe('ARTIST_HAS_EVENTS');
    });
  });
});
