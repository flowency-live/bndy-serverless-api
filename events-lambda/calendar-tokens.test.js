/**
 * Calendar Token Service Tests
 *
 * Tests for calendar subscription token management:
 * - Token generation (with cal_ prefix)
 * - Token validation
 * - Token revocation
 * - Scope enforcement
 */

const {
  generateToken,
  validateToken,
  createCalendarToken,
  getCalendarTokens,
  revokeCalendarToken,
  updateTokenLastUsed
} = require('./calendar-tokens');

// Mock DynamoDB
const mockDynamoDB = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  update: jest.fn(),
  delete: jest.fn()
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      get: (params) => ({ promise: () => mockDynamoDB.get(params) }),
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      update: (params) => ({ promise: () => mockDynamoDB.update(params) }),
      delete: (params) => ({ promise: () => mockDynamoDB.delete(params) })
    }))
  }
}));

describe('calendar-tokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('generateToken', () => {
    it('should generate a token with cal_ prefix', () => {
      const token = generateToken();

      expect(token).toMatch(/^cal_[a-f0-9-]{36}$/);
    });

    it('should generate unique tokens', () => {
      const tokens = new Set();
      for (let i = 0; i < 100; i++) {
        tokens.add(generateToken());
      }
      expect(tokens.size).toBe(100);
    });
  });

  describe('createCalendarToken', () => {
    it('should create a token with correct attributes', async () => {
      mockDynamoDB.put.mockResolvedValue({});

      const result = await createCalendarToken({
        userId: 'user-123',
        artistId: 'artist-456',
        scope: 'full'
      });

      expect(result.token).toMatch(/^cal_/);
      expect(result.userId).toBe('user-123');
      expect(result.artistId).toBe('artist-456');
      expect(result.scope).toBe('full');
      expect(result.subscriptionUrl).toContain(result.token);
      expect(result.webcalUrl).toMatch(/^webcal:/);
      expect(result.revokedAt).toBeNull();

      expect(mockDynamoDB.put).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'bndy-calendar-tokens',
          Item: expect.objectContaining({
            token: result.token,
            userId: 'user-123',
            artistId: 'artist-456',
            scope: 'full'
          })
        })
      );
    });

    it('should validate scope parameter', async () => {
      await expect(createCalendarToken({
        userId: 'user-123',
        artistId: 'artist-456',
        scope: 'invalid'
      })).rejects.toThrow('Invalid scope');
    });

    it('should accept all valid scopes', async () => {
      mockDynamoDB.put.mockResolvedValue({});

      for (const scope of ['full', 'public', 'personal']) {
        const result = await createCalendarToken({
          userId: 'user-123',
          artistId: 'artist-456',
          scope
        });
        expect(result.scope).toBe(scope);
      }
    });
  });

  describe('validateToken', () => {
    it('should return token data for valid token', async () => {
      const tokenData = {
        token: 'cal_valid-token',
        userId: 'user-123',
        artistId: 'artist-456',
        scope: 'full',
        createdAt: '2025-01-01T10:00:00Z',
        lastUsedAt: '2025-01-01T10:00:00Z',
        revokedAt: null
      };

      mockDynamoDB.get.mockResolvedValue({ Item: tokenData });

      const result = await validateToken('cal_valid-token');

      expect(result).toEqual(tokenData);
      expect(mockDynamoDB.get).toHaveBeenCalledWith({
        TableName: 'bndy-calendar-tokens',
        Key: { token: 'cal_valid-token' }
      });
    });

    it('should return null for non-existent token', async () => {
      mockDynamoDB.get.mockResolvedValue({ Item: undefined });

      const result = await validateToken('cal_nonexistent');

      expect(result).toBeNull();
    });

    it('should return null for revoked token', async () => {
      const tokenData = {
        token: 'cal_revoked-token',
        userId: 'user-123',
        artistId: 'artist-456',
        scope: 'full',
        revokedAt: '2025-01-15T10:00:00Z'
      };

      mockDynamoDB.get.mockResolvedValue({ Item: tokenData });

      const result = await validateToken('cal_revoked-token');

      expect(result).toBeNull();
    });

    it('should reject tokens without cal_ prefix', async () => {
      const result = await validateToken('invalid-token-format');

      expect(result).toBeNull();
      expect(mockDynamoDB.get).not.toHaveBeenCalled();
    });
  });

  describe('getCalendarTokens', () => {
    it('should return all tokens for a user and artist', async () => {
      const tokens = [
        {
          token: 'cal_token-1',
          userId: 'user-123',
          artistId: 'artist-456',
          scope: 'full',
          createdAt: '2025-01-01T10:00:00Z'
        },
        {
          token: 'cal_token-2',
          userId: 'user-123',
          artistId: 'artist-456',
          scope: 'public',
          createdAt: '2025-01-02T10:00:00Z'
        }
      ];

      mockDynamoDB.query.mockResolvedValue({ Items: tokens });

      const result = await getCalendarTokens('user-123', 'artist-456');

      expect(result).toEqual(tokens);
      expect(mockDynamoDB.query).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'bndy-calendar-tokens',
          IndexName: 'userId-index',
          KeyConditionExpression: 'userId = :userId',
          FilterExpression: 'artistId = :artistId AND attribute_not_exists(revokedAt)',
          ExpressionAttributeValues: {
            ':userId': 'user-123',
            ':artistId': 'artist-456'
          }
        })
      );
    });

    it('should return empty array when no tokens exist', async () => {
      mockDynamoDB.query.mockResolvedValue({ Items: [] });

      const result = await getCalendarTokens('user-123', 'artist-456');

      expect(result).toEqual([]);
    });
  });

  describe('revokeCalendarToken', () => {
    it('should mark token as revoked', async () => {
      mockDynamoDB.get.mockResolvedValue({
        Item: {
          token: 'cal_to-revoke',
          userId: 'user-123',
          artistId: 'artist-456'
        }
      });
      mockDynamoDB.update.mockResolvedValue({});

      await revokeCalendarToken('cal_to-revoke', 'user-123');

      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'bndy-calendar-tokens',
          Key: { token: 'cal_to-revoke' },
          UpdateExpression: 'SET revokedAt = :revokedAt',
          ExpressionAttributeValues: expect.objectContaining({
            ':revokedAt': expect.any(String)
          })
        })
      );
    });

    it('should throw error if token not found', async () => {
      mockDynamoDB.get.mockResolvedValue({ Item: undefined });

      await expect(revokeCalendarToken('cal_nonexistent', 'user-123'))
        .rejects.toThrow('Token not found');
    });

    it('should throw error if user does not own the token', async () => {
      mockDynamoDB.get.mockResolvedValue({
        Item: {
          token: 'cal_other-user',
          userId: 'other-user',
          artistId: 'artist-456'
        }
      });

      await expect(revokeCalendarToken('cal_other-user', 'user-123'))
        .rejects.toThrow('Unauthorized');
    });
  });

  describe('updateTokenLastUsed', () => {
    it('should update lastUsedAt timestamp', async () => {
      mockDynamoDB.update.mockResolvedValue({});

      await updateTokenLastUsed('cal_active-token');

      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'bndy-calendar-tokens',
          Key: { token: 'cal_active-token' },
          UpdateExpression: 'SET lastUsedAt = :lastUsedAt',
          ExpressionAttributeValues: expect.objectContaining({
            ':lastUsedAt': expect.any(String)
          })
        })
      );
    });
  });

  describe('token format', () => {
    it('should generate URL-safe tokens', () => {
      for (let i = 0; i < 50; i++) {
        const token = generateToken();
        // Should only contain URL-safe characters
        expect(token).toMatch(/^[a-zA-Z0-9_-]+$/);
      }
    });
  });
});
