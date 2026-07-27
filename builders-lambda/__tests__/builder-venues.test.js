// builders-lambda builder-venues tests
// TDD: Tests written FIRST (RED phase)
// These tests will FAIL until venue routes are implemented

// Mock AWS SDK DynamoDB (must be before require)
const mockDynamoDBPut = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockDynamoDBGet = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockDynamoDBQuery = jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });
const mockDynamoDBUpdate = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockDynamoDBDelete = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockDynamoDBBatchGet = jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Responses: {} }) });

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: mockDynamoDBPut,
      get: mockDynamoDBGet,
      query: mockDynamoDBQuery,
      update: mockDynamoDBUpdate,
      delete: mockDynamoDBDelete,
      batchGet: mockDynamoDBBatchGet,
    })),
  },
  SSM: jest.fn(() => ({
    getParameter: jest.fn().mockReturnValue({
      promise: () => Promise.resolve({ Parameter: { Value: 'test-jwt-secret' } }),
    }),
  })),
}));

// Mock JWT verification
const mockVerifyToken = jest.fn();
jest.mock('jsonwebtoken', () => ({
  verify: mockVerifyToken,
}));

const { handler } = require('../handler');

// Test data factories
const createValidBuilder = (overrides = {}) => ({
  id: 'builder-123',
  user_id: 'user-456',
  name: 'Congleton Live Music',
  slug: 'congleton',
  status: 'published',
  coverage: { type: 'postcode_radius', postcode: 'CW12 1AA', radius: 15 },
  theme: {
    primaryColor: '#ff00ff',
    secondaryColor: '#00ffff',
    backgroundColor: '#0a0a0a',
    foregroundColor: '#ffffff',
    defaultMode: 'dark',
  },
  created_at: '2026-06-01T12:00:00Z',
  updated_at: '2026-06-01T12:00:00Z',
  ...overrides,
});

const createValidVenue = (overrides = {}) => ({
  id: 'venue-789',
  name: 'The Blue Note',
  postcode: 'CW12 2AB',
  lat: 53.162,
  lng: -2.218,
  ...overrides,
});

const createBuilderVenue = (overrides = {}) => ({
  id: 'bv-123',
  builder_id: 'builder-123',
  venue_id: 'venue-789',
  selection: 'manual',
  featured: false,
  display_order: 1,
  created_at: '2026-06-01T12:00:00Z',
  ...overrides,
});

const createAuthenticatedEvent = (method, path, overrides = {}) => ({
  requestContext: { http: { method, path } },
  headers: { origin: 'https://backstage.bndy.co.uk' },
  cookies: ['bndy_session=valid-token'],
  pathParameters: {},
  queryStringParameters: {},
  body: null,
  ...overrides,
});

describe('Builder Venues API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
    process.env.BUILDERS_TABLE = 'bndy-builders';
    process.env.BUILDER_VENUES_TABLE = 'bndy-builder-venues';
    process.env.VENUES_TABLE = 'bndy-venues';
    process.env.USERS_TABLE = 'bndy-users';
    process.env.BUILDER_WHITELIST = 'user-456';
  });

  // ========== GET /api/builders/:id/venues ==========
  describe('GET /api/builders/:id/venues', () => {
    beforeEach(() => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-456',
        username: 'testuser',
      });

      mockDynamoDBGet.mockReturnValue({
        promise: () => Promise.resolve({
          Item: { cognito_id: 'user-456', platformAdmin: false },
        }),
      });
    });

    test('should return empty array when no venues configured', async () => {
      // Mock builder exists
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      // Mock no builder-venues
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      const event = createAuthenticatedEvent('GET', '/api/builders/builder-123/venues', {
        pathParameters: { id: 'builder-123' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.venues).toEqual([]);
    });

    test('should return venues with details', async () => {
      const builderVenues = [
        createBuilderVenue({ id: 'bv-1', venue_id: 'venue-1', featured: true }),
        createBuilderVenue({ id: 'bv-2', venue_id: 'venue-2', featured: false }),
      ];

      const venues = [
        createValidVenue({ id: 'venue-1', name: 'Venue One' }),
        createValidVenue({ id: 'venue-2', name: 'Venue Two' }),
      ];

      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: builderVenues }),
      });

      // Mock batch get for venue details
      mockDynamoDBBatchGet.mockReturnValue({
        promise: () => Promise.resolve({
          Responses: {
            'bndy-venues': venues,
          },
        }),
      });

      const event = createAuthenticatedEvent('GET', '/api/builders/builder-123/venues', {
        pathParameters: { id: 'builder-123' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.venues).toHaveLength(2);
      expect(body.venues[0].venue.name).toBeDefined();
      expect(body.venues[0].featured).toBeDefined();
    });

    test('should return 404 for non-existent builder', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: null }),
        });

      const event = createAuthenticatedEvent('GET', '/api/builders/builder-999/venues', {
        pathParameters: { id: 'builder-999' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
    });

    test('should reject if user is not owner', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: createValidBuilder({ user_id: 'user-999' }),
          }),
        });

      const event = createAuthenticatedEvent('GET', '/api/builders/builder-123/venues', {
        pathParameters: { id: 'builder-123' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(403);
    });
  });

  // ========== POST /api/builders/:id/venues ==========
  describe('POST /api/builders/:id/venues', () => {
    beforeEach(() => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-456',
        username: 'testuser',
      });

      mockDynamoDBGet.mockReturnValue({
        promise: () => Promise.resolve({
          Item: { cognito_id: 'user-456', platformAdmin: false },
        }),
      });
    });

    test('should add venue to builder', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidVenue() }),
        });

      // Check venue not already added
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      mockDynamoDBPut.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders/builder-123/venues', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({
          venue_id: 'venue-789',
          selection: 'manual',
          featured: true,
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(201);
      expect(mockDynamoDBPut).toHaveBeenCalled();
      const body = JSON.parse(result.body);
      expect(body.builderVenue.venue_id).toBe('venue-789');
      expect(body.builderVenue.featured).toBe(true);
    });

    test('should reject duplicate venue', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidVenue() }),
        });

      // Venue already exists
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [createBuilderVenue()] }),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders/builder-123/venues', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({ venue_id: 'venue-789' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body).error).toContain('already added');
    });

    test('should reject non-existent venue', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: null }), // Venue doesn't exist
        });

      const event = createAuthenticatedEvent('POST', '/api/builders/builder-123/venues', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({ venue_id: 'venue-999' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body).error).toContain('Venue not found');
    });

    test('should validate selection type', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      const event = createAuthenticatedEvent('POST', '/api/builders/builder-123/venues', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({
          venue_id: 'venue-789',
          selection: 'invalid_type',
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('selection');
    });
  });

  // ========== PUT /api/builders/:id/venues/:venueId ==========
  describe('PUT /api/builders/:id/venues/:venueId', () => {
    beforeEach(() => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-456',
        username: 'testuser',
      });

      mockDynamoDBGet.mockReturnValue({
        promise: () => Promise.resolve({
          Item: { cognito_id: 'user-456', platformAdmin: false },
        }),
      });
    });

    test('should update venue featured status', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      // Find existing builder-venue
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [createBuilderVenue()] }),
      });

      mockDynamoDBUpdate.mockReturnValue({
        promise: () => Promise.resolve({
          Attributes: createBuilderVenue({ featured: true }),
        }),
      });

      const event = createAuthenticatedEvent('PUT', '/api/builders/builder-123/venues/venue-789', {
        pathParameters: { id: 'builder-123', venueId: 'venue-789' },
        body: JSON.stringify({ featured: true }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.builderVenue.featured).toBe(true);
    });

    test('should update venue display order', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [createBuilderVenue()] }),
      });

      mockDynamoDBUpdate.mockReturnValue({
        promise: () => Promise.resolve({
          Attributes: createBuilderVenue({ display_order: 5 }),
        }),
      });

      const event = createAuthenticatedEvent('PUT', '/api/builders/builder-123/venues/venue-789', {
        pathParameters: { id: 'builder-123', venueId: 'venue-789' },
        body: JSON.stringify({ display_order: 5 }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.builderVenue.display_order).toBe(5);
    });

    test('should return 404 for non-configured venue', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      // Venue not found in builder-venues
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      const event = createAuthenticatedEvent('PUT', '/api/builders/builder-123/venues/venue-999', {
        pathParameters: { id: 'builder-123', venueId: 'venue-999' },
        body: JSON.stringify({ featured: true }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
    });
  });

  // ========== DELETE /api/builders/:id/venues/:venueId ==========
  describe('DELETE /api/builders/:id/venues/:venueId', () => {
    beforeEach(() => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-456',
        username: 'testuser',
      });

      mockDynamoDBGet.mockReturnValue({
        promise: () => Promise.resolve({
          Item: { cognito_id: 'user-456', platformAdmin: false },
        }),
      });
    });

    test('should remove venue from builder', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      // Find existing builder-venue
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [createBuilderVenue()] }),
      });

      mockDynamoDBDelete.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const event = createAuthenticatedEvent('DELETE', '/api/builders/builder-123/venues/venue-789', {
        pathParameters: { id: 'builder-123', venueId: 'venue-789' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(204);
      expect(mockDynamoDBDelete).toHaveBeenCalled();
    });

    test('should return 404 for non-configured venue', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      const event = createAuthenticatedEvent('DELETE', '/api/builders/builder-123/venues/venue-999', {
        pathParameters: { id: 'builder-123', venueId: 'venue-999' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
    });

    test('should reject if user is not owner', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: createValidBuilder({ user_id: 'user-999' }),
          }),
        });

      const event = createAuthenticatedEvent('DELETE', '/api/builders/builder-123/venues/venue-789', {
        pathParameters: { id: 'builder-123', venueId: 'venue-789' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(403);
    });
  });

  // ========== Selection Types ==========
  describe('Venue Selection Types', () => {
    beforeEach(() => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-456',
        username: 'testuser',
      });

      mockDynamoDBGet.mockReturnValue({
        promise: () => Promise.resolve({
          Item: { cognito_id: 'user-456', platformAdmin: false },
        }),
      });
    });

    test('should accept selection type: auto', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidVenue() }),
        });

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      mockDynamoDBPut.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders/builder-123/venues', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({ venue_id: 'venue-789', selection: 'auto' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(201);
    });

    test('should accept selection type: manual', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidVenue() }),
        });

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      mockDynamoDBPut.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders/builder-123/venues', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({ venue_id: 'venue-789', selection: 'manual' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(201);
    });

    test('should accept selection type: excluded', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidVenue() }),
        });

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      mockDynamoDBPut.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders/builder-123/venues', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({ venue_id: 'venue-789', selection: 'excluded' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(201);
    });
  });

  // ========== Extended Venue Management Fields ==========
  describe('PUT /api/builders/:id/venues/:venueId (extended fields)', () => {
    beforeEach(() => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-456',
        username: 'testuser',
      });

      mockDynamoDBGet.mockReturnValue({
        promise: () => Promise.resolve({
          Item: { cognito_id: 'user-456', platformAdmin: false },
        }),
      });
    });

    test('should update standard_fee field', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [createBuilderVenue()] }),
      });

      mockDynamoDBUpdate.mockReturnValue({
        promise: () => Promise.resolve({
          Attributes: createBuilderVenue({ standard_fee: '£150' }),
        }),
      });

      const event = createAuthenticatedEvent('PUT', '/api/builders/builder-123/venues/venue-789', {
        pathParameters: { id: 'builder-123', venueId: 'venue-789' },
        body: JSON.stringify({ standard_fee: '£150' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.builderVenue.standard_fee).toBe('£150');
    });

    test('should update payment_terms field', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [createBuilderVenue()] }),
      });

      mockDynamoDBUpdate.mockReturnValue({
        promise: () => Promise.resolve({
          Attributes: createBuilderVenue({ payment_terms: 'Cash on night' }),
        }),
      });

      const event = createAuthenticatedEvent('PUT', '/api/builders/builder-123/venues/venue-789', {
        pathParameters: { id: 'builder-123', venueId: 'venue-789' },
        body: JSON.stringify({ payment_terms: 'Cash on night' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.builderVenue.payment_terms).toBe('Cash on night');
    });

    test('should update notes field', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [createBuilderVenue()] }),
      });

      mockDynamoDBUpdate.mockReturnValue({
        promise: () => Promise.resolve({
          Attributes: createBuilderVenue({ notes: 'Great venue, friendly staff' }),
        }),
      });

      const event = createAuthenticatedEvent('PUT', '/api/builders/builder-123/venues/venue-789', {
        pathParameters: { id: 'builder-123', venueId: 'venue-789' },
        body: JSON.stringify({ notes: 'Great venue, friendly staff' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.builderVenue.notes).toBe('Great venue, friendly staff');
    });

    test('should update contact fields', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [createBuilderVenue()] }),
      });

      mockDynamoDBUpdate.mockReturnValue({
        promise: () => Promise.resolve({
          Attributes: createBuilderVenue({
            contact_name: 'John Smith',
            contact_email: 'john@bluenote.com',
            contact_phone: '01onal261 123456',
          }),
        }),
      });

      const event = createAuthenticatedEvent('PUT', '/api/builders/builder-123/venues/venue-789', {
        pathParameters: { id: 'builder-123', venueId: 'venue-789' },
        body: JSON.stringify({
          contact_name: 'John Smith',
          contact_email: 'john@bluenote.com',
          contact_phone: '01onal261 123456',
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.builderVenue.contact_name).toBe('John Smith');
      expect(body.builderVenue.contact_email).toBe('john@bluenote.com');
    });

    test('should accept null to clear optional fields', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [createBuilderVenue({ standard_fee: '£150' })] }),
      });

      mockDynamoDBUpdate.mockReturnValue({
        promise: () => Promise.resolve({
          Attributes: createBuilderVenue({ standard_fee: null }),
        }),
      });

      const event = createAuthenticatedEvent('PUT', '/api/builders/builder-123/venues/venue-789', {
        pathParameters: { id: 'builder-123', venueId: 'venue-789' },
        body: JSON.stringify({ standard_fee: null }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.builderVenue.standard_fee).toBeNull();
    });

    test('should reject invalid email format', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [createBuilderVenue()] }),
      });

      const event = createAuthenticatedEvent('PUT', '/api/builders/builder-123/venues/venue-789', {
        pathParameters: { id: 'builder-123', venueId: 'venue-789' },
        body: JSON.stringify({ contact_email: 'not-a-valid-email' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('email');
    });
  });

  // ========== Bulk Venue Selection ==========
  describe('POST /api/builders/:id/venues/bulk', () => {
    beforeEach(() => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-456',
        username: 'testuser',
      });

      mockDynamoDBGet.mockReturnValue({
        promise: () => Promise.resolve({
          Item: { cognito_id: 'user-456', platformAdmin: false },
        }),
      });
    });

    test('should create multiple venue associations', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      // No existing builder-venues
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      // Venues exist
      mockDynamoDBBatchGet.mockReturnValue({
        promise: () => Promise.resolve({
          Responses: {
            'bndy-venues': [
              createValidVenue({ id: 'venue-1' }),
              createValidVenue({ id: 'venue-2' }),
              createValidVenue({ id: 'venue-3' }),
            ],
          },
        }),
      });

      mockDynamoDBPut.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders/builder-123/venues/bulk', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({
          venues: [
            { venue_id: 'venue-1', selection: 'manual' },
            { venue_id: 'venue-2', selection: 'manual' },
            { venue_id: 'venue-3', selection: 'excluded' },
          ],
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.created).toBe(3);
      expect(body.skipped).toBe(0);
    });

    test('should skip venues already associated', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      // One venue already exists
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({
          Items: [createBuilderVenue({ venue_id: 'venue-1' })],
        }),
      });

      // All venues exist in bndy-venues
      mockDynamoDBBatchGet.mockReturnValue({
        promise: () => Promise.resolve({
          Responses: {
            'bndy-venues': [
              createValidVenue({ id: 'venue-1' }),
              createValidVenue({ id: 'venue-2' }),
            ],
          },
        }),
      });

      mockDynamoDBPut.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders/builder-123/venues/bulk', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({
          venues: [
            { venue_id: 'venue-1', selection: 'manual' },
            { venue_id: 'venue-2', selection: 'manual' },
          ],
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.created).toBe(1);
      expect(body.skipped).toBe(1);
    });

    test('should return created and skipped counts', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      // Two venues already exist
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({
          Items: [
            createBuilderVenue({ venue_id: 'venue-1' }),
            createBuilderVenue({ venue_id: 'venue-2' }),
          ],
        }),
      });

      mockDynamoDBBatchGet.mockReturnValue({
        promise: () => Promise.resolve({
          Responses: {
            'bndy-venues': [
              createValidVenue({ id: 'venue-1' }),
              createValidVenue({ id: 'venue-2' }),
              createValidVenue({ id: 'venue-3' }),
              createValidVenue({ id: 'venue-4' }),
            ],
          },
        }),
      });

      mockDynamoDBPut.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders/builder-123/venues/bulk', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({
          venues: [
            { venue_id: 'venue-1', selection: 'manual' },
            { venue_id: 'venue-2', selection: 'manual' },
            { venue_id: 'venue-3', selection: 'manual' },
            { venue_id: 'venue-4', selection: 'excluded' },
          ],
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.created).toBe(2);
      expect(body.skipped).toBe(2);
      expect(body.created + body.skipped).toBe(4);
    });

    test('should validate venues array is provided', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      const event = createAuthenticatedEvent('POST', '/api/builders/builder-123/venues/bulk', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({}),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('venues');
    });

    test('should validate each venue has venue_id', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: createValidBuilder() }),
        });

      const event = createAuthenticatedEvent('POST', '/api/builders/builder-123/venues/bulk', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({
          venues: [
            { selection: 'manual' }, // missing venue_id
          ],
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('venue_id');
    });

    test('should reject if user is not owner', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: createValidBuilder({ user_id: 'user-999' }),
          }),
        });

      const event = createAuthenticatedEvent('POST', '/api/builders/builder-123/venues/bulk', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({
          venues: [{ venue_id: 'venue-1', selection: 'manual' }],
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(403);
    });
  });
});
