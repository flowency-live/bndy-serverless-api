/**
 * Memberships Lambda - BOLA (Broken Object Level Authorization) Tests
 *
 * SEC-AUD-003: Membership endpoints require artist-scoped authorization
 *
 * These tests verify that:
 * 1. GET /api/memberships/all (godmode) requires platformAdmin
 * 2. POST /api/artists/{id}/members requires artist admin role
 * 3. PUT /api/memberships/{id} requires artist admin role
 * 4. DELETE /api/memberships/{id} requires artist admin role (or self-removal)
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
  update: jest.fn(),
  batchGet: jest.fn()
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
      batchGet: (params) => ({ promise: () => mockDynamoDB.batchGet(params) })
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

describe('Memberships Lambda - BOLA Security', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Helper to create JWT session token
  const createSessionToken = (userId = 'test-user-id') => {
    return jwt.sign(
      { userId, email: 'test@example.com', username: 'testuser' },
      'test-jwt-secret',
      { expiresIn: '90d' }
    );
  };

  // Mock user lookup for platformAdmin check
  const mockUserLookup = (userId, platformAdmin = false) => {
    mockDynamoDB.get.mockImplementation((params) => {
      if (params.TableName === 'bndy-users' && params.Key?.cognito_id === userId) {
        return Promise.resolve({
          Item: {
            cognito_id: userId,
            email: 'test@example.com',
            platformAdmin
          }
        });
      }
      return Promise.resolve({ Item: null });
    });
  };

  // Mock membership lookup for artist admin check
  const mockMembershipLookup = (userId, artistId, role = 'member') => {
    mockDynamoDB.query.mockImplementation((params) => {
      if (params.TableName === 'bndy-artist-memberships' && params.IndexName === 'artist_id-index') {
        if (params.FilterExpression?.includes('user_id')) {
          // Query with user filter - return user's membership
          return Promise.resolve({
            Items: role ? [{
              membership_id: 'member-1',
              user_id: userId,
              artist_id: artistId,
              role: role
            }] : []
          });
        }
        // General artist members query
        return Promise.resolve({
          Items: [{
            membership_id: 'member-1',
            user_id: userId,
            artist_id: artistId,
            role: role
          }]
        });
      }
      return Promise.resolve({ Items: [] });
    });
  };

  describe('GET /api/memberships/all - Godmode List All', () => {
    const createListAllEvent = (sessionToken = null) => ({
      requestContext: {
        http: {
          method: 'GET',
          path: '/api/memberships/all'
        }
      },
      headers: { origin: 'https://backstage.bndy.co.uk' },
      cookies: sessionToken ? [`bndy_session=${sessionToken}`] : []
    });

    it('should return 401 when not authenticated', async () => {
      const event = createListAllEvent();
      const response = await handler(event, {});

      expect(response.statusCode).toBe(401);
    });

    it('should return 403 when user is not platformAdmin', async () => {
      const sessionToken = createSessionToken('regular-user');
      const event = createListAllEvent(sessionToken);

      mockUserLookup('regular-user', false);

      const response = await handler(event, {});

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toMatch(/platform admin/i);
    });

    it('should return 200 when user is platformAdmin', async () => {
      const sessionToken = createSessionToken('admin-user');
      const event = createListAllEvent(sessionToken);

      mockUserLookup('admin-user', true);
      mockDynamoDB.scan.mockResolvedValue({ Items: [] });

      const response = await handler(event, {});

      expect(response.statusCode).toBe(200);
    });
  });

  describe('POST /api/artists/{id}/members - Add Member', () => {
    const createAddMemberEvent = (artistId, sessionToken = null, body = {}) => ({
      requestContext: {
        http: {
          method: 'POST',
          path: `/api/artists/${artistId}/members`
        }
      },
      pathParameters: { artistId },
      headers: { origin: 'https://backstage.bndy.co.uk' },
      cookies: sessionToken ? [`bndy_session=${sessionToken}`] : [],
      body: JSON.stringify({ userId: 'new-member-id', role: 'member', ...body })
    });

    it('should return 401 when not authenticated', async () => {
      const event = createAddMemberEvent('artist-1');
      const response = await handler(event, {});

      expect(response.statusCode).toBe(401);
    });

    it('should return 403 when user is not artist admin', async () => {
      const sessionToken = createSessionToken('regular-member');
      const event = createAddMemberEvent('artist-1', sessionToken);

      // User exists but not platformAdmin
      mockUserLookup('regular-member', false);

      // User is a member but not admin of this artist
      mockMembershipLookup('regular-member', 'artist-1', 'member');

      // Artist exists
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-artists') {
          return Promise.resolve({ Item: { id: 'artist-1', name: 'Test Band' } });
        }
        if (params.TableName === 'bndy-users') {
          return Promise.resolve({
            Item: { cognito_id: 'regular-member', platformAdmin: false }
          });
        }
        return Promise.resolve({ Item: null });
      });

      const response = await handler(event, {});

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toMatch(/admin|not authorized/i);
    });

    it('should return 403 when user has no membership in the artist', async () => {
      const sessionToken = createSessionToken('outsider-user');
      const event = createAddMemberEvent('artist-1', sessionToken);

      mockUserLookup('outsider-user', false);

      // User has NO membership in this artist
      mockMembershipLookup('outsider-user', 'artist-1', null);

      const response = await handler(event, {});

      expect(response.statusCode).toBe(403);
    });

    it('should return 201 when user is artist admin', async () => {
      const sessionToken = createSessionToken('artist-admin');
      const event = createAddMemberEvent('artist-1', sessionToken);

      mockUserLookup('artist-admin', false);

      // User is admin of this artist
      mockMembershipLookup('artist-admin', 'artist-1', 'admin');

      // Artist exists
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-artists') {
          return Promise.resolve({ Item: { id: 'artist-1', name: 'Test Band' } });
        }
        if (params.TableName === 'bndy-users') {
          return Promise.resolve({
            Item: { cognito_id: 'artist-admin', platformAdmin: false }
          });
        }
        return Promise.resolve({ Item: null });
      });

      // No existing membership for new user
      mockDynamoDB.query.mockImplementation((params) => {
        if (params.FilterExpression?.includes('user_id') &&
            params.ExpressionAttributeValues?.[':userId'] === 'new-member-id') {
          return Promise.resolve({ Items: [] });
        }
        if (params.FilterExpression?.includes('user_id') &&
            params.ExpressionAttributeValues?.[':userId'] === 'artist-admin') {
          return Promise.resolve({
            Items: [{
              membership_id: 'admin-membership',
              user_id: 'artist-admin',
              artist_id: 'artist-1',
              role: 'admin'
            }]
          });
        }
        return Promise.resolve({ Items: [] });
      });

      mockDynamoDB.put.mockResolvedValue({});

      const response = await handler(event, {});

      expect(response.statusCode).toBe(201);
    });

    it('should return 201 when user is platformAdmin (even without membership)', async () => {
      const sessionToken = createSessionToken('platform-admin');
      const event = createAddMemberEvent('artist-1', sessionToken);

      // Platform admin, no membership needed
      mockUserLookup('platform-admin', true);

      // Artist exists
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-artists') {
          return Promise.resolve({ Item: { id: 'artist-1', name: 'Test Band' } });
        }
        if (params.TableName === 'bndy-users') {
          return Promise.resolve({
            Item: { cognito_id: 'platform-admin', platformAdmin: true }
          });
        }
        return Promise.resolve({ Item: null });
      });

      mockDynamoDB.query.mockResolvedValue({ Items: [] }); // No existing membership
      mockDynamoDB.put.mockResolvedValue({});

      const response = await handler(event, {});

      expect(response.statusCode).toBe(201);
    });
  });

  describe('PUT /api/memberships/{id} - Update Membership', () => {
    const createUpdateEvent = (membershipId, sessionToken = null, body = {}) => ({
      requestContext: {
        http: {
          method: 'PUT',
          path: `/api/memberships/${membershipId}`
        }
      },
      pathParameters: { membershipId },
      headers: { origin: 'https://backstage.bndy.co.uk' },
      cookies: sessionToken ? [`bndy_session=${sessionToken}`] : [],
      body: JSON.stringify({ displayName: 'New Name', ...body })
    });

    it('should return 401 when not authenticated', async () => {
      const event = createUpdateEvent('membership-1');
      const response = await handler(event, {});

      expect(response.statusCode).toBe(401);
    });

    it('should return 403 when user is not artist admin for this membership', async () => {
      const sessionToken = createSessionToken('regular-member');
      const event = createUpdateEvent('membership-1', sessionToken);

      mockUserLookup('regular-member', false);

      // Membership exists for different user
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-artist-memberships') {
          return Promise.resolve({
            Item: {
              membership_id: 'membership-1',
              user_id: 'other-user',
              artist_id: 'artist-1',
              role: 'member'
            }
          });
        }
        if (params.TableName === 'bndy-users') {
          return Promise.resolve({
            Item: { cognito_id: 'regular-member', platformAdmin: false }
          });
        }
        return Promise.resolve({ Item: null });
      });

      // User is only a member, not admin
      mockMembershipLookup('regular-member', 'artist-1', 'member');

      const response = await handler(event, {});

      expect(response.statusCode).toBe(403);
    });

    it('should return 200 when user updates their own membership', async () => {
      const sessionToken = createSessionToken('self-user');
      const event = createUpdateEvent('membership-1', sessionToken);

      mockUserLookup('self-user', false);

      // Membership belongs to the requesting user
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-artist-memberships') {
          return Promise.resolve({
            Item: {
              membership_id: 'membership-1',
              user_id: 'self-user',
              artist_id: 'artist-1',
              role: 'member'
            }
          });
        }
        if (params.TableName === 'bndy-users') {
          return Promise.resolve({
            Item: { cognito_id: 'self-user', platformAdmin: false }
          });
        }
        return Promise.resolve({ Item: null });
      });

      mockDynamoDB.update.mockResolvedValue({
        Attributes: {
          membership_id: 'membership-1',
          user_id: 'self-user',
          artist_id: 'artist-1',
          role: 'member',
          display_name: 'New Name'
        }
      });

      const response = await handler(event, {});

      expect(response.statusCode).toBe(200);
    });

    it('should return 403 when non-admin tries to escalate role', async () => {
      const sessionToken = createSessionToken('self-user');
      const event = createUpdateEvent('membership-1', sessionToken, { role: 'admin' });

      mockUserLookup('self-user', false);

      // User's own membership
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-artist-memberships') {
          return Promise.resolve({
            Item: {
              membership_id: 'membership-1',
              user_id: 'self-user',
              artist_id: 'artist-1',
              role: 'member'
            }
          });
        }
        if (params.TableName === 'bndy-users') {
          return Promise.resolve({
            Item: { cognito_id: 'self-user', platformAdmin: false }
          });
        }
        return Promise.resolve({ Item: null });
      });

      const response = await handler(event, {});

      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.error).toMatch(/role|admin|escalat/i);
    });
  });

  describe('DELETE /api/memberships/{id} - Delete Membership', () => {
    const createDeleteEvent = (membershipId, sessionToken = null) => ({
      requestContext: {
        http: {
          method: 'DELETE',
          path: `/api/memberships/${membershipId}`
        }
      },
      pathParameters: { membershipId },
      headers: { origin: 'https://backstage.bndy.co.uk' },
      cookies: sessionToken ? [`bndy_session=${sessionToken}`] : []
    });

    it('should return 401 when not authenticated', async () => {
      const event = createDeleteEvent('membership-1');
      const response = await handler(event, {});

      expect(response.statusCode).toBe(401);
    });

    it('should return 403 when user is not artist admin or owner', async () => {
      const sessionToken = createSessionToken('attacker-user');
      const event = createDeleteEvent('membership-1', sessionToken);

      mockUserLookup('attacker-user', false);

      // Membership belongs to someone else
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-artist-memberships') {
          return Promise.resolve({
            Item: {
              membership_id: 'membership-1',
              user_id: 'victim-user',
              artist_id: 'artist-1',
              role: 'member'
            }
          });
        }
        if (params.TableName === 'bndy-users') {
          return Promise.resolve({
            Item: { cognito_id: 'attacker-user', platformAdmin: false }
          });
        }
        return Promise.resolve({ Item: null });
      });

      // Attacker has no membership in this artist
      mockDynamoDB.query.mockResolvedValue({ Items: [] });

      const response = await handler(event, {});

      expect(response.statusCode).toBe(403);
    });

    it('should return 200 when user deletes their own membership (self-removal)', async () => {
      const sessionToken = createSessionToken('leaving-user');
      const event = createDeleteEvent('membership-1', sessionToken);

      mockUserLookup('leaving-user', false);

      // Membership belongs to requesting user
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-artist-memberships') {
          return Promise.resolve({
            Item: {
              membership_id: 'membership-1',
              user_id: 'leaving-user',
              artist_id: 'artist-1',
              role: 'member'
            }
          });
        }
        if (params.TableName === 'bndy-users') {
          return Promise.resolve({
            Item: { cognito_id: 'leaving-user', platformAdmin: false }
          });
        }
        return Promise.resolve({ Item: null });
      });

      // Mock cascade cleanup operations
      mockDynamoDB.scan.mockResolvedValue({ Items: [] });
      mockDynamoDB.query.mockResolvedValue({ Items: [] });
      mockDynamoDB.delete.mockResolvedValue({});

      const response = await handler(event, {});

      expect(response.statusCode).toBe(200);
    });

    it('should return 200 when artist admin deletes another member', async () => {
      const sessionToken = createSessionToken('artist-admin');
      const event = createDeleteEvent('membership-1', sessionToken);

      mockUserLookup('artist-admin', false);

      // Membership belongs to different user
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-artist-memberships' && params.Key?.membership_id === 'membership-1') {
          return Promise.resolve({
            Item: {
              membership_id: 'membership-1',
              user_id: 'other-member',
              artist_id: 'artist-1',
              role: 'member'
            }
          });
        }
        if (params.TableName === 'bndy-users') {
          return Promise.resolve({
            Item: { cognito_id: 'artist-admin', platformAdmin: false }
          });
        }
        return Promise.resolve({ Item: null });
      });

      // Admin is admin of this artist
      mockDynamoDB.query.mockImplementation((params) => {
        if (params.IndexName === 'artist_id-index' && params.FilterExpression?.includes('user_id')) {
          return Promise.resolve({
            Items: [{
              membership_id: 'admin-membership',
              user_id: 'artist-admin',
              artist_id: 'artist-1',
              role: 'admin'
            }]
          });
        }
        return Promise.resolve({ Items: [] });
      });

      // Mock cascade cleanup
      mockDynamoDB.scan.mockResolvedValue({ Items: [] });
      mockDynamoDB.delete.mockResolvedValue({});

      const response = await handler(event, {});

      expect(response.statusCode).toBe(200);
    });
  });
});
