// notifications-lambda handler tests
// Following TDD approach: Tests written FIRST (RED phase)
// These tests will FAIL until handler.js is implemented

// Mock AWS SDK DynamoDB (must be before require)
const mockDynamoDBPut = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockDynamoDBGet = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockDynamoDBQuery = jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });
const mockDynamoDBUpdate = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockDynamoDBDelete = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: mockDynamoDBPut,
      get: mockDynamoDBGet,
      query: mockDynamoDBQuery,
      update: mockDynamoDBUpdate,
      delete: mockDynamoDBDelete,
    })),
  },
}));

// Mock JWT verification (must be before require)
const mockVerifyToken = jest.fn();
jest.mock('jsonwebtoken', () => ({
  verify: mockVerifyToken,
}));

const { handler } = require('../handler');

describe('Notifications Lambda Handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
    process.env.NOTIFICATIONS_TABLE = 'bndy-notifications';
  });

  // ========== NOTIFICATION GROUPING TESTS ==========
  describe('Notification Grouping Logic (5-minute window)', () => {
    test('should group song_added notifications within 5 minutes', async () => {
      const artistId = 'artist-123';
      const userId = 'user-456';
      const now = new Date();
      const fourMinutesAgo = new Date(now - 4 * 60 * 1000);

      // Mock existing notification within 5-minute window
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({
          Items: [{
            id: 'notif-1',
            artist_id: artistId,
            type: 'song_added',
            metadata: JSON.stringify({ count: 2, songTitle: 'Song 1' }),
            created_at: fourMinutesAgo.toISOString(),
          }],
        }),
      });

      mockDynamoDBUpdate.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const payload = {
        action: 'create',
        type: 'song_added',
        artistId,
        performedByUserId: userId,
        performedByName: 'John Doe',
        metadata: {
          songId: 'song-789',
          songTitle: 'New Song',
        },
      };

      const result = await handler(payload);

      // Should update existing notification, not create new one
      expect(mockDynamoDBUpdate).toHaveBeenCalled();
      expect(mockDynamoDBPut).not.toHaveBeenCalled();
      expect(result.statusCode).toBe(200);
    });

    test('should NOT group song_added notifications outside 5-minute window', async () => {
      const artistId = 'artist-123';
      const now = new Date();
      const sixMinutesAgo = new Date(now - 6 * 60 * 1000);

      // Mock existing notification OUTSIDE 5-minute window
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({
          Items: [{
            id: 'notif-1',
            artist_id: artistId,
            type: 'song_added',
            created_at: sixMinutesAgo.toISOString(),
          }],
        }),
      });

      mockDynamoDBPut.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const payload = {
        action: 'create',
        type: 'song_added',
        artistId,
        performedByUserId: 'user-456',
        performedByName: 'John Doe',
        metadata: { songId: 'song-789', songTitle: 'New Song' },
      };

      await handler(payload);

      // Should create new notification
      expect(mockDynamoDBPut).toHaveBeenCalled();
      expect(mockDynamoDBUpdate).not.toHaveBeenCalled();
    });

    test('should NOT group non-song_added notification types', async () => {
      mockDynamoDBPut.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const payload = {
        action: 'create',
        type: 'gig_added',
        artistId: 'artist-123',
        performedByUserId: 'user-456',
        performedByName: 'John Doe',
        metadata: { eventId: 'event-789', venueName: 'The Venue' },
      };

      await handler(payload);

      // Should always create new notification for non-song types
      expect(mockDynamoDBPut).toHaveBeenCalled();
      expect(mockDynamoDBQuery).not.toHaveBeenCalled();
    });
  });

  // ========== AUTHORIZATION TESTS ==========
  describe('Authorization Logic (User Ownership)', () => {
    test('should reject request with missing JWT', async () => {
      const event = {
        requestContext: { http: { method: 'GET', path: '/api/notifications' } },
        headers: {},
        cookies: [],
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body).error).toContain('No authorization token');
    });

    test('should reject request with invalid JWT', async () => {
      mockVerifyToken.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const event = {
        requestContext: { http: { method: 'GET', path: '/api/notifications' } },
        headers: {},
        cookies: ['bndy_session=invalid-token'],
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body).error).toContain('Invalid token');
    });

    test('should allow request with valid JWT', async () => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-123',
        username: 'testuser',
      });

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      const event = {
        requestContext: { http: { method: 'GET', path: '/api/notifications' } },
        headers: {},
        cookies: ['bndy_session=valid-token'],
        queryStringParameters: {},
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(mockVerifyToken).toHaveBeenCalled();
    });

    test('should prevent user from accessing another users notifications', async () => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-123',
        username: 'testuser',
      });

      mockDynamoDBGet.mockReturnValue({
        promise: () => Promise.resolve({
          Item: {
            id: 'notif-1',
            user_id: 'user-999', // Different user
            message: 'Secret notification',
          },
        }),
      });

      const event = {
        requestContext: { http: { method: 'DELETE', path: '/api/notifications/notif-1' } },
        headers: {},
        cookies: ['bndy_session=valid-token'],
        pathParameters: { id: 'notif-1' },
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body).error).toContain('Forbidden');
    });
  });

  // ========== GET /api/notifications TESTS ==========
  describe('GET /api/notifications', () => {
    beforeEach(() => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-123',
        username: 'testuser',
      });
    });

    test('should return notifications for authenticated user', async () => {
      const mockNotifications = [
        {
          id: 'notif-1',
          user_id: 'user-123',
          artist_id: 'artist-456',
          type: 'song_added',
          message: 'New song added',
          metadata: '{}',
          read: false,
          created_at: new Date().toISOString(),
        },
      ];

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: mockNotifications }),
      });

      const event = {
        requestContext: { http: { method: 'GET', path: '/api/notifications' } },
        headers: {},
        cookies: ['bndy_session=valid-token'],
        queryStringParameters: {},
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.notifications).toHaveLength(1);
      expect(body.notifications[0].id).toBe('notif-1');
    });

    test('should filter notifications by artistId', async () => {
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      const event = {
        requestContext: { http: { method: 'GET', path: '/api/notifications' } },
        headers: {},
        cookies: ['bndy_session=valid-token'],
        queryStringParameters: { artistId: 'artist-456' },
      };

      await handler(event);

      expect(mockDynamoDBQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          FilterExpression: expect.stringContaining('artist_id'),
        })
      );
    });

    test('should support pagination with limit', async () => {
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [], LastEvaluatedKey: null }),
      });

      const event = {
        requestContext: { http: { method: 'GET', path: '/api/notifications' } },
        headers: {},
        cookies: ['bndy_session=valid-token'],
        queryStringParameters: { limit: '25' },
      };

      await handler(event);

      expect(mockDynamoDBQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          Limit: 25,
        })
      );
    });
  });

  // ========== PUT /api/notifications/{id}/read TESTS ==========
  describe('PUT /api/notifications/{id}/read', () => {
    beforeEach(() => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-123',
        username: 'testuser',
      });
    });

    test('should mark notification as read', async () => {
      mockDynamoDBGet.mockReturnValue({
        promise: () => Promise.resolve({
          Item: {
            id: 'notif-1',
            user_id: 'user-123',
            read: false,
          },
        }),
      });

      mockDynamoDBUpdate.mockReturnValue({
        promise: () => Promise.resolve({
          Attributes: {
            id: 'notif-1',
            read: true,
          },
        }),
      });

      const event = {
        requestContext: { http: { method: 'PUT', path: '/api/notifications/notif-1/read' } },
        headers: {},
        cookies: ['bndy_session=valid-token'],
        pathParameters: { id: 'notif-1' },
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(mockDynamoDBUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.stringContaining('read'),
          ExpressionAttributeValues: expect.objectContaining({
            ':read': true,
          }),
        })
      );
    });

    test('should return 404 for non-existent notification', async () => {
      mockDynamoDBGet.mockReturnValue({
        promise: () => Promise.resolve({ Item: null }),
      });

      const event = {
        requestContext: { http: { method: 'PUT', path: '/api/notifications/notif-999/read' } },
        headers: {},
        cookies: ['bndy_session=valid-token'],
        pathParameters: { id: 'notif-999' },
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
    });
  });

  // ========== DELETE /api/notifications/{id} TESTS ==========
  describe('DELETE /api/notifications/{id}', () => {
    beforeEach(() => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-123',
        username: 'testuser',
      });
    });

    test('should delete notification', async () => {
      mockDynamoDBGet.mockReturnValue({
        promise: () => Promise.resolve({
          Item: {
            id: 'notif-1',
            user_id: 'user-123',
          },
        }),
      });

      mockDynamoDBDelete.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const event = {
        requestContext: { http: { method: 'DELETE', path: '/api/notifications/notif-1' } },
        headers: {},
        cookies: ['bndy_session=valid-token'],
        pathParameters: { id: 'notif-1' },
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(204);
      expect(mockDynamoDBDelete).toHaveBeenCalledWith(
        expect.objectContaining({
          Key: { id: 'notif-1' },
        })
      );
    });

    test('should return 404 for non-existent notification', async () => {
      mockDynamoDBGet.mockReturnValue({
        promise: () => Promise.resolve({ Item: null }),
      });

      const event = {
        requestContext: { http: { method: 'DELETE', path: '/api/notifications/notif-999' } },
        headers: {},
        cookies: ['bndy_session=valid-token'],
        pathParameters: { id: 'notif-999' },
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
    });
  });

  // ========== POST /api/notifications/mark-all-read TESTS ==========
  describe('POST /api/notifications/mark-all-read', () => {
    beforeEach(() => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-123',
        username: 'testuser',
      });
    });

    test('should mark all unread notifications as read', async () => {
      const unreadNotifications = [
        { id: 'notif-1', user_id: 'user-123', read: false },
        { id: 'notif-2', user_id: 'user-123', read: false },
      ];

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: unreadNotifications }),
      });

      mockDynamoDBUpdate.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const event = {
        requestContext: { http: { method: 'POST', path: '/api/notifications/mark-all-read' } },
        headers: {},
        cookies: ['bndy_session=valid-token'],
        body: JSON.stringify({ artistId: 'artist-456' }),
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.count).toBe(2);
      expect(mockDynamoDBUpdate).toHaveBeenCalledTimes(2);
    });

    test('should return count of 0 when no unread notifications', async () => {
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      const event = {
        requestContext: { http: { method: 'POST', path: '/api/notifications/mark-all-read' } },
        headers: {},
        cookies: ['bndy_session=valid-token'],
        body: JSON.stringify({ artistId: 'artist-456' }),
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.count).toBe(0);
    });
  });

  // ========== INTERNAL CREATE FUNCTION TESTS ==========
  describe('Internal Create Function (Lambda Invocation)', () => {
    test('should create notification from Lambda invocation payload', async () => {
      mockDynamoDBPut.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const payload = {
        action: 'create',
        type: 'gig_added',
        artistId: 'artist-123',
        performedByUserId: 'user-456',
        performedByName: 'John Doe',
        metadata: {
          eventId: 'event-789',
          venueName: 'The Venue',
          eventDate: '2025-12-01',
        },
      };

      const result = await handler(payload);

      expect(result.statusCode).toBe(200);
      expect(mockDynamoDBPut).toHaveBeenCalled();

      const putCall = mockDynamoDBPut.mock.calls[0][0];
      expect(putCall.Item.type).toBe('gig_added');
      expect(putCall.Item.artist_id).toBe('artist-123');
      expect(putCall.Item.expires_at).toBeGreaterThan(Date.now() / 1000);
    });

    test('should set TTL to 30 days from creation', async () => {
      mockDynamoDBPut.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const payload = {
        action: 'create',
        type: 'song_added',
        artistId: 'artist-123',
        performedByUserId: 'user-456',
        performedByName: 'John Doe',
        metadata: { songId: 'song-789', songTitle: 'New Song' },
      };

      await handler(payload);

      const putCall = mockDynamoDBPut.mock.calls[0][0];
      const thirtyDaysInSeconds = 30 * 24 * 60 * 60;
      const expectedTTL = Math.floor(Date.now() / 1000) + thirtyDaysInSeconds;

      // Allow 10 second tolerance for test execution time
      expect(putCall.Item.expires_at).toBeGreaterThanOrEqual(expectedTTL - 10);
      expect(putCall.Item.expires_at).toBeLessThanOrEqual(expectedTTL + 10);
    });

    test('should reject invalid notification type', async () => {
      const payload = {
        action: 'create',
        type: 'invalid_type',
        artistId: 'artist-123',
        performedByUserId: 'user-456',
        performedByName: 'John Doe',
        metadata: {},
      };

      const result = await handler(payload);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('Invalid notification type');
    });

    test('should reject missing required fields', async () => {
      const payload = {
        action: 'create',
        type: 'song_added',
        // Missing artistId
        performedByUserId: 'user-456',
        metadata: {},
      };

      const result = await handler(payload);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('Missing required fields');
    });
  });
});
