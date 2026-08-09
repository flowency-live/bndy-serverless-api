/**
 * Users Lambda - Godmode Authorization Tests
 *
 * SEC-AUD-002: Godmode endpoints require platformAdmin
 *
 * These tests verify that:
 * 1. GET /users (list all users) requires platformAdmin
 * 2. DELETE /users/{userId} requires platformAdmin
 * 3. Unauthenticated requests return 401
 * 4. Authenticated non-admin requests return 403
 */

// Set JWT_SECRET before requiring handler
process.env.JWT_SECRET = 'test-jwt-secret';

// Mock AWS SDK before requiring handler
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
      update: (params) => ({ promise: () => mockDynamoDB.update(params) })
    }))
  },
  SSM: jest.fn(() => ({
    getParameter: () => ({
      promise: () => Promise.resolve({ Parameter: { Value: 'test-jwt-secret' } })
    })
  }))
}));

// Mock jsonwebtoken
const jwt = require('jsonwebtoken');

const { handler } = require('../handler');

describe('Users Lambda - Godmode Authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Helper to create a valid JWT session token
  const createSessionToken = (userId = 'test-user-id', platformAdmin = false) => {
    return jwt.sign(
      { userId, email: 'test@example.com', username: 'testuser', platformAdmin },
      'test-jwt-secret',
      { expiresIn: '90d' }
    );
  };

  // Create GET /users event
  const createListUsersEvent = (sessionToken = null) => ({
    requestContext: {
      http: {
        method: 'GET',
        path: '/users'
      }
    },
    headers: {
      origin: 'https://backstage.bndy.co.uk'
    },
    cookies: sessionToken ? [`bndy_session=${sessionToken}`] : []
  });

  // Create DELETE /users/{userId} event
  const createDeleteUserEvent = (userId, sessionToken = null) => ({
    requestContext: {
      http: {
        method: 'DELETE',
        path: `/users/${userId}`
      }
    },
    pathParameters: {
      userId: userId
    },
    headers: {
      origin: 'https://backstage.bndy.co.uk'
    },
    cookies: sessionToken ? [`bndy_session=${sessionToken}`] : []
  });

  describe('GET /users - List All Users', () => {
    describe('Unauthenticated requests', () => {
      it('should return 401 when no session cookie is present', async () => {
        const event = createListUsersEvent();

        const response = await handler(event, {});

        expect(response.statusCode).toBe(401);
        const body = JSON.parse(response.body);
        expect(body.error).toMatch(/not authenticated/i);
      });

      it('should return 401 when session token is invalid', async () => {
        const event = createListUsersEvent('invalid-token');

        const response = await handler(event, {});

        expect(response.statusCode).toBe(401);
        const body = JSON.parse(response.body);
        expect(body.error).toMatch(/invalid session/i);
      });
    });

    describe('Authenticated non-admin requests', () => {
      it('should return 403 when user is not platformAdmin', async () => {
        const sessionToken = createSessionToken('regular-user-id', false);
        const event = createListUsersEvent(sessionToken);

        // Mock user lookup - user exists but is NOT platformAdmin
        mockDynamoDB.get.mockImplementation((params) => {
          if (params.TableName === 'bndy-users') {
            return Promise.resolve({
              Item: {
                cognito_id: 'regular-user-id',
                email: 'user@example.com',
                platformAdmin: false
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

      it('should return 403 when platformAdmin is undefined', async () => {
        const sessionToken = createSessionToken('new-user-id');
        const event = createListUsersEvent(sessionToken);

        // Mock user lookup - user exists but has no platformAdmin field
        mockDynamoDB.get.mockImplementation((params) => {
          if (params.TableName === 'bndy-users') {
            return Promise.resolve({
              Item: {
                cognito_id: 'new-user-id',
                email: 'newuser@example.com'
                // platformAdmin field is missing
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
      it('should return 200 with user list when user is platformAdmin', async () => {
        const sessionToken = createSessionToken('admin-user-id', true);
        const event = createListUsersEvent(sessionToken);

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

        // Mock scan for users list
        mockDynamoDB.scan.mockImplementation((params) => {
          if (params.TableName === 'bndy-users') {
            return Promise.resolve({
              Items: [
                { user_id: 'user-1', cognito_id: 'cog-1', email: 'user1@example.com', username: 'user1' },
                { user_id: 'user-2', cognito_id: 'cog-2', email: 'user2@example.com', username: 'user2' }
              ]
            });
          }
          if (params.TableName === 'bndy-artist-memberships') {
            return Promise.resolve({ Items: [] });
          }
          return Promise.resolve({ Items: [] });
        });

        const response = await handler(event, {});

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.users).toBeDefined();
        expect(body.count).toBe(2);
      });
    });
  });

  describe('DELETE /users/{userId}', () => {
    describe('Unauthenticated requests', () => {
      it('should return 401 when no session cookie is present', async () => {
        const event = createDeleteUserEvent('target-user-id');

        const response = await handler(event, {});

        expect(response.statusCode).toBe(401);
        const body = JSON.parse(response.body);
        expect(body.error).toMatch(/not authenticated/i);
      });

      it('should return 401 when session token is invalid', async () => {
        const event = createDeleteUserEvent('target-user-id', 'invalid-token');

        const response = await handler(event, {});

        expect(response.statusCode).toBe(401);
        const body = JSON.parse(response.body);
        expect(body.error).toMatch(/invalid session/i);
      });
    });

    describe('Authenticated non-admin requests', () => {
      it('should return 403 when user is not platformAdmin', async () => {
        const sessionToken = createSessionToken('regular-user-id', false);
        const event = createDeleteUserEvent('target-user-id', sessionToken);

        // Mock user lookup - user exists but is NOT platformAdmin
        mockDynamoDB.get.mockImplementation((params) => {
          if (params.TableName === 'bndy-users') {
            return Promise.resolve({
              Item: {
                cognito_id: 'regular-user-id',
                email: 'user@example.com',
                platformAdmin: false
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

      it('should return 403 even when deleting own account (godmode only)', async () => {
        // User trying to delete themselves - still requires platformAdmin
        const sessionToken = createSessionToken('regular-user-id', false);
        const event = createDeleteUserEvent('regular-user-id', sessionToken);

        mockDynamoDB.get.mockImplementation((params) => {
          if (params.TableName === 'bndy-users') {
            return Promise.resolve({
              Item: {
                cognito_id: 'regular-user-id',
                email: 'user@example.com',
                platformAdmin: false
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
      it('should return 200 when platformAdmin deletes a user', async () => {
        const sessionToken = createSessionToken('admin-user-id', true);
        const event = createDeleteUserEvent('target-user-id', sessionToken);

        // Mock user lookup for admin
        mockDynamoDB.get.mockImplementation((params) => {
          if (params.TableName === 'bndy-users' && params.Key?.cognito_id === 'admin-user-id') {
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

        // Mock scan for target user and memberships
        mockDynamoDB.scan.mockImplementation((params) => {
          if (params.TableName === 'bndy-users') {
            return Promise.resolve({
              Items: [{
                user_id: 'target-user-id',
                cognito_id: 'target-cognito-id',
                email: 'target@example.com'
              }]
            });
          }
          if (params.TableName === 'bndy-artist-memberships') {
            return Promise.resolve({ Items: [] });
          }
          return Promise.resolve({ Items: [] });
        });

        // Mock successful delete
        mockDynamoDB.delete.mockResolvedValue({});

        const response = await handler(event, {});

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.message).toMatch(/deleted/i);
      });

      it('should return 404 when target user does not exist', async () => {
        const sessionToken = createSessionToken('admin-user-id', true);
        const event = createDeleteUserEvent('nonexistent-user-id', sessionToken);

        // Mock user lookup for admin
        mockDynamoDB.get.mockImplementation((params) => {
          if (params.TableName === 'bndy-users' && params.Key?.cognito_id === 'admin-user-id') {
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

        // Mock scan - no user found
        mockDynamoDB.scan.mockImplementation((params) => {
          return Promise.resolve({ Items: [] });
        });

        const response = await handler(event, {});

        expect(response.statusCode).toBe(404);
        const body = JSON.parse(response.body);
        expect(body.error).toMatch(/not found/i);
      });
    });
  });
});
