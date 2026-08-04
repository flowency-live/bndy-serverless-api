/**
 * DELETE /api/songs/:id Authorization Tests
 *
 * SEC-XX: Godmode authorization - require platformAdmin for DELETE operations
 */

const mockDynamoDB = {
  get: jest.fn(),
  put: jest.fn(),
  scan: jest.fn(),
  query: jest.fn(),
  delete: jest.fn()
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (params) => ({ promise: () => mockDynamoDB.get(params) }),
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      scan: (params) => ({ promise: () => mockDynamoDB.scan(params) }),
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      delete: (params) => ({ promise: () => mockDynamoDB.delete(params) })
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

describe('DELETE /api/songs/:id - Authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createSessionToken = (userId = 'test-user-id') => {
    return jwt.sign(
      { userId, email: 'test@example.com', username: 'testuser' },
      'test-jwt-secret',
      { expiresIn: '90d' }
    );
  };

  const createDeleteEvent = (songId, sessionToken = null, force = false) => ({
    requestContext: {
      http: {
        method: 'DELETE',
        path: `/api/songs/${songId}`
      }
    },
    pathParameters: { id: songId },
    queryStringParameters: force ? { force: 'true' } : {},
    headers: { origin: 'https://backstage.bndy.co.uk' },
    cookies: sessionToken ? [`bndy_session=${sessionToken}`] : []
  });

  it('should return 401 when no session cookie is present', async () => {
    const event = createDeleteEvent('test-song-id');
    const response = await handler(event, {});

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/not authenticated/i);
  });

  it('should return 403 when user is not platformAdmin', async () => {
    const sessionToken = createSessionToken('regular-user-id');
    const event = createDeleteEvent('test-song-id', sessionToken);

    mockDynamoDB.get.mockImplementation((params) => {
      if (params.TableName === 'bndy-users') {
        return Promise.resolve({
          Item: { cognito_id: 'regular-user-id', platformAdmin: false }
        });
      }
      return Promise.resolve({ Item: null });
    });

    const response = await handler(event, {});

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/platform admin/i);
  });

  it('should proceed with deletion when user is platformAdmin', async () => {
    const sessionToken = createSessionToken('admin-user-id');
    const event = createDeleteEvent('test-song-id', sessionToken);

    mockDynamoDB.get.mockImplementation((params) => {
      if (params.TableName === 'bndy-users') {
        return Promise.resolve({
          Item: { cognito_id: 'admin-user-id', platformAdmin: true }
        });
      }
      return Promise.resolve({ Item: null });
    });

    // Mock: No artist-songs reference this song
    mockDynamoDB.query.mockResolvedValue({ Items: [] });
    mockDynamoDB.delete.mockResolvedValue({});

    const response = await handler(event, {});

    // Should succeed (204) or conflict (409) - not 401/403
    expect(response.statusCode).not.toBe(401);
    expect(response.statusCode).not.toBe(403);
  });

  it('should require auth for force delete as well', async () => {
    const event = createDeleteEvent('test-song-id', null, true);
    const response = await handler(event, {});

    expect(response.statusCode).toBe(401);
  });
});
