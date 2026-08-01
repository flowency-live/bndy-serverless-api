/**
 * Artist Availability Settings Tests
 *
 * Tests for PATCH /api/artists/{id} availability-related fields:
 * - availabilityMode (enum validation)
 * - contactMethod (enum validation)
 * - phoneNumber (optional string)
 * - whatsappNumber (optional string)
 */

const mockDynamoDB = {
  query: jest.fn(),
  put: jest.fn(),
  scan: jest.fn(),
  get: jest.fn(),
  update: jest.fn()
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      scan: (params) => ({ promise: () => mockDynamoDB.scan(params) }),
      get: (params) => ({ promise: () => mockDynamoDB.get(params) }),
      update: (params) => ({ promise: () => mockDynamoDB.update(params) })
    }))
  },
  SSM: jest.fn(() => ({
    getParameter: () => ({
      promise: () => Promise.resolve({ Parameter: { Value: 'test-secret' } })
    })
  })),
  S3: jest.fn(() => ({
    upload: () => ({ promise: () => Promise.resolve({ Location: 'https://s3.example.com/test.jpg' }) })
  }))
}));

const { handler } = require('./handler');

describe('PATCH /api/artists/{id} - Availability Settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Mock user lookup for auth
    mockDynamoDB.get.mockImplementation((params) => {
      if (params.TableName === 'bndy-users') {
        return Promise.resolve({
          Item: { cognito_id: 'admin-1', platformAdmin: true }
        });
      }
      if (params.TableName === 'bndy-artists') {
        return Promise.resolve({
          Item: {
            id: 'artist-123',
            name: 'Test Artist',
            owner_user_id: 'admin-1',
            publishAvailability: false
          }
        });
      }
      return Promise.resolve({ Item: null });
    });
    // Mock membership query (empty for admin)
    mockDynamoDB.query.mockResolvedValue({ Items: [] });
  });

  // Helper: create session cookie for platform admin
  const createAdminSessionCookie = () => {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { userId: 'admin-1' },
      'test-secret',
      { expiresIn: '1h' }
    );
    return `bndy_session=${token}`;
  };

  const createPatchEvent = (artistId, body) => ({
    requestContext: {
      http: {
        method: 'PATCH',
        path: `/api/artists/${artistId}`
      }
    },
    pathParameters: {
      id: artistId
    },
    body: JSON.stringify(body),
    headers: {
      origin: 'https://live.bndy.co.uk',
      Cookie: createAdminSessionCookie()
    }
  });

  describe('availabilityMode Field', () => {
    it('should accept "selected_dates_only" enum value', async () => {
      mockDynamoDB.update.mockResolvedValue({
        Attributes: {
          id: 'artist-123',
          name: 'Test Artist',
          availabilityMode: 'selected_dates_only'
        }
      });

      const event = createPatchEvent('artist-123', {
        availabilityMode: 'selected_dates_only'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.stringContaining('availabilityMode = :availabilityMode'),
          ExpressionAttributeValues: expect.objectContaining({
            ':availabilityMode': 'selected_dates_only'
          })
        })
      );
    });

    it('should accept "free_weekends" enum value', async () => {
      mockDynamoDB.update.mockResolvedValue({
        Attributes: {
          id: 'artist-123',
          name: 'Test Artist',
          availabilityMode: 'free_weekends'
        }
      });

      const event = createPatchEvent('artist-123', {
        availabilityMode: 'free_weekends'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.stringContaining('availabilityMode = :availabilityMode'),
          ExpressionAttributeValues: expect.objectContaining({
            ':availabilityMode': 'free_weekends'
          })
        })
      );
    });

    it('should reject invalid enum value', async () => {
      const event = createPatchEvent('artist-123', {
        availabilityMode: 'invalid_mode'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('availabilityMode');
      expect(mockDynamoDB.update).not.toHaveBeenCalled();
    });
  });

  describe('contactMethod Field', () => {
    it('should accept "phone" enum value', async () => {
      mockDynamoDB.update.mockResolvedValue({
        Attributes: {
          id: 'artist-123',
          name: 'Test Artist',
          contactMethod: 'phone'
        }
      });

      const event = createPatchEvent('artist-123', {
        contactMethod: 'phone'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.stringContaining('contactMethod = :contactMethod'),
          ExpressionAttributeValues: expect.objectContaining({
            ':contactMethod': 'phone'
          })
        })
      );
    });

    it('should accept "whatsapp" enum value', async () => {
      mockDynamoDB.update.mockResolvedValue({
        Attributes: {
          id: 'artist-123',
          name: 'Test Artist',
          contactMethod: 'whatsapp'
        }
      });

      const event = createPatchEvent('artist-123', {
        contactMethod: 'whatsapp'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.stringContaining('contactMethod = :contactMethod'),
          ExpressionAttributeValues: expect.objectContaining({
            ':contactMethod': 'whatsapp'
          })
        })
      );
    });

    it('should reject invalid enum value', async () => {
      const event = createPatchEvent('artist-123', {
        contactMethod: 'email'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('contactMethod');
      expect(mockDynamoDB.update).not.toHaveBeenCalled();
    });
  });

  describe('phoneNumber Field', () => {
    it('should accept valid phone number', async () => {
      mockDynamoDB.update.mockResolvedValue({
        Attributes: {
          id: 'artist-123',
          name: 'Test Artist',
          phoneNumber: '+447123456789'
        }
      });

      const event = createPatchEvent('artist-123', {
        phoneNumber: '+447123456789'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.stringContaining('phoneNumber = :phoneNumber'),
          ExpressionAttributeValues: expect.objectContaining({
            ':phoneNumber': '+447123456789'
          })
        })
      );
    });

    it('should accept null to clear phone number', async () => {
      mockDynamoDB.update.mockResolvedValue({
        Attributes: {
          id: 'artist-123',
          name: 'Test Artist',
          phoneNumber: null
        }
      });

      const event = createPatchEvent('artist-123', {
        phoneNumber: null
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.stringContaining('phoneNumber = :phoneNumber'),
          ExpressionAttributeValues: expect.objectContaining({
            ':phoneNumber': null
          })
        })
      );
    });
  });

  describe('whatsappNumber Field', () => {
    it('should accept valid WhatsApp number', async () => {
      mockDynamoDB.update.mockResolvedValue({
        Attributes: {
          id: 'artist-123',
          name: 'Test Artist',
          whatsappNumber: '+447987654321'
        }
      });

      const event = createPatchEvent('artist-123', {
        whatsappNumber: '+447987654321'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.stringContaining('whatsappNumber = :whatsappNumber'),
          ExpressionAttributeValues: expect.objectContaining({
            ':whatsappNumber': '+447987654321'
          })
        })
      );
    });

    it('should accept null to clear WhatsApp number', async () => {
      mockDynamoDB.update.mockResolvedValue({
        Attributes: {
          id: 'artist-123',
          name: 'Test Artist',
          whatsappNumber: null
        }
      });

      const event = createPatchEvent('artist-123', {
        whatsappNumber: null
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.stringContaining('whatsappNumber = :whatsappNumber'),
          ExpressionAttributeValues: expect.objectContaining({
            ':whatsappNumber': null
          })
        })
      );
    });
  });

  describe('Combined Availability Settings', () => {
    it('should accept all availability fields together', async () => {
      mockDynamoDB.update.mockResolvedValue({
        Attributes: {
          id: 'artist-123',
          name: 'Test Artist',
          publishAvailability: true,
          availabilityMode: 'free_weekends',
          contactMethod: 'whatsapp',
          phoneNumber: '+447123456789',
          whatsappNumber: '+447987654321'
        }
      });

      const event = createPatchEvent('artist-123', {
        publishAvailability: true,
        availabilityMode: 'free_weekends',
        contactMethod: 'whatsapp',
        phoneNumber: '+447123456789',
        whatsappNumber: '+447987654321'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          UpdateExpression: expect.stringMatching(/availabilityMode.*contactMethod.*phoneNumber.*whatsappNumber/s),
          ExpressionAttributeValues: expect.objectContaining({
            ':availabilityMode': 'free_weekends',
            ':contactMethod': 'whatsapp',
            ':phoneNumber': '+447123456789',
            ':whatsappNumber': '+447987654321'
          })
        })
      );
    });
  });
});
