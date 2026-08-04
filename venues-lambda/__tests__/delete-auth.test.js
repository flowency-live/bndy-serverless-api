/**
 * DELETE /api/venues/:id Authorization Tests
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
  })),
  Lambda: jest.fn(() => ({
    invoke: () => ({ promise: () => Promise.resolve({}) })
  }))
}));

const jwt = require('jsonwebtoken');
const { handler } = require('../handler');

describe('DELETE /api/venues/:id - Authorization', () => {
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

  const createDeleteEvent = (venueId, sessionToken = null) => ({
    requestContext: {
      http: {
        method: 'DELETE',
        path: `/api/venues/${venueId}`
      }
    },
    pathParameters: { id: venueId },
    headers: { origin: 'https://backstage.bndy.co.uk' },
    cookies: sessionToken ? [`bndy_session=${sessionToken}`] : []
  });

  it('should return 401 when no session cookie is present', async () => {
    const event = createDeleteEvent('test-venue-id');
    const response = await handler(event, {});

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toMatch(/not authenticated/i);
  });

  it('should return 403 when user is not platformAdmin', async () => {
    const sessionToken = createSessionToken('regular-user-id');
    const event = createDeleteEvent('test-venue-id', sessionToken);

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
    const event = createDeleteEvent('test-venue-id', sessionToken);

    mockDynamoDB.get.mockImplementation((params) => {
      if (params.TableName === 'bndy-users') {
        return Promise.resolve({
          Item: { cognito_id: 'admin-user-id', platformAdmin: true }
        });
      }
      if (params.TableName === 'bndy-venues') {
        return Promise.resolve({
          Item: { id: 'test-venue-id', name: 'Test Venue' }
        });
      }
      return Promise.resolve({ Item: null });
    });

    mockDynamoDB.delete.mockResolvedValue({});

    const response = await handler(event, {});

    // Should succeed (204) or at least not be 401/403
    expect(response.statusCode).not.toBe(401);
    expect(response.statusCode).not.toBe(403);
  });
});
