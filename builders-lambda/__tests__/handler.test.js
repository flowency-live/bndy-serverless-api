// builders-lambda handler tests
// TDD: Tests written FIRST (RED phase)
// These tests will FAIL until handler.js is implemented

// Mock AWS SDK DynamoDB (must be before require)
const mockDynamoDBPut = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockDynamoDBGet = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockDynamoDBQuery = jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });
const mockDynamoDBUpdate = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockDynamoDBDelete = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockDynamoDBScan = jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: mockDynamoDBPut,
      get: mockDynamoDBGet,
      query: mockDynamoDBQuery,
      update: mockDynamoDBUpdate,
      delete: mockDynamoDBDelete,
      scan: mockDynamoDBScan,
    })),
  },
  SSM: jest.fn(() => ({
    getParameter: jest.fn().mockReturnValue({
      promise: () => Promise.resolve({ Parameter: { Value: 'test-jwt-secret' } }),
    }),
  })),
}));

// Mock JWT verification (must be before require)
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
  description: 'Live music in Congleton and surrounding areas',
  branding: {
    logoUrl: 'https://example.com/logo.png',
    tagline: 'Music in the heart of Cheshire',
  },
  theme: {
    primaryColor: '#ff00ff',
    secondaryColor: '#00ffff',
    backgroundColor: '#0a0a0a',
    foregroundColor: '#ffffff',
    defaultMode: 'dark',
  },
  coverage: {
    type: 'postcode_radius',
    postcode: 'CW12 1AA',
    radius: 15,
  },
  status: 'published',
  created_at: '2026-06-01T12:00:00Z',
  updated_at: '2026-06-01T12:00:00Z',
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

describe('Builders Lambda Handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
    process.env.BUILDERS_TABLE = 'bndy-builders';
    process.env.USERS_TABLE = 'bndy-users';
    // Feature flag: comma-separated list of whitelisted user IDs
    process.env.BUILDER_WHITELIST = 'user-admin,user-456';
  });

  // ========== FEATURE FLAG TESTS (Phase 0) ==========
  describe('Feature Flag: BUILDER_WHITELIST', () => {
    test('should reject request from non-whitelisted user', async () => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-not-whitelisted',
        username: 'outsider',
      });

      // Mock user lookup (no platformAdmin)
      mockDynamoDBGet.mockReturnValue({
        promise: () => Promise.resolve({
          Item: { cognito_id: 'user-not-whitelisted', platformAdmin: false },
        }),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders', {
        body: JSON.stringify({ name: 'My Builder', slug: 'mybuilder' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body).error).toContain('Builder feature not enabled');
    });

    test('should allow request from whitelisted user', async () => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-456',
        username: 'whitelisted',
      });

      mockDynamoDBGet.mockReturnValue({
        promise: () => Promise.resolve({
          Item: { cognito_id: 'user-456', platformAdmin: false },
        }),
      });

      // Mock slug uniqueness check
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      mockDynamoDBPut.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders', {
        body: JSON.stringify({
          name: 'Congleton Live',
          slug: 'congleton',
          theme: {
            primaryColor: '#ff00ff',
            secondaryColor: '#00ffff',
            backgroundColor: '#0a0a0a',
            foregroundColor: '#ffffff',
            defaultMode: 'dark',
          },
          coverage: { type: 'manual' },
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(201);
    });

    test('should allow platformAdmin regardless of whitelist', async () => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-platform-admin',
        username: 'admin',
      });

      mockDynamoDBGet.mockReturnValue({
        promise: () => Promise.resolve({
          Item: { cognito_id: 'user-platform-admin', platformAdmin: true },
        }),
      });

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      mockDynamoDBPut.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders', {
        body: JSON.stringify({
          name: 'Admin Builder',
          slug: 'adminbuilder',
          theme: {
            primaryColor: '#ff00ff',
            secondaryColor: '#00ffff',
            backgroundColor: '#0a0a0a',
            foregroundColor: '#ffffff',
            defaultMode: 'dark',
          },
          coverage: { type: 'manual' },
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(201);
    });
  });

  // ========== AUTHENTICATION TESTS ==========
  describe('Authentication', () => {
    test('should reject request with missing JWT', async () => {
      const event = createAuthenticatedEvent('GET', '/api/builders', {
        cookies: [],
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body).error).toContain('Not authenticated');
    });

    test('should reject request with invalid JWT', async () => {
      mockVerifyToken.mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const event = createAuthenticatedEvent('GET', '/api/builders', {
        cookies: ['bndy_session=invalid-token'],
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body).error).toContain('Invalid session');
    });
  });

  // ========== GET /api/builders/by-subdomain/:slug (PUBLIC - no auth) ==========
  describe('GET /api/builders/by-subdomain/:slug', () => {
    test('should return 404 for unknown slug', async () => {
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      const event = {
        requestContext: { http: { method: 'GET', path: '/api/builders/by-subdomain/unknown' } },
        headers: {},
        cookies: [],
        pathParameters: { slug: 'unknown' },
        queryStringParameters: {},
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body).error).toContain('Builder not found');
    });

    test('should return builder config for valid slug', async () => {
      const mockBuilder = createValidBuilder();

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [mockBuilder] }),
      });

      const event = {
        requestContext: { http: { method: 'GET', path: '/api/builders/by-subdomain/congleton' } },
        headers: {},
        cookies: [],
        pathParameters: { slug: 'congleton' },
        queryStringParameters: {},
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.builder.slug).toBe('congleton');
      expect(body.builder.name).toBe('Congleton Live Music');
    });

    test('should include theme and coverage in response', async () => {
      const mockBuilder = createValidBuilder();

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [mockBuilder] }),
      });

      const event = {
        requestContext: { http: { method: 'GET', path: '/api/builders/by-subdomain/congleton' } },
        headers: {},
        cookies: [],
        pathParameters: { slug: 'congleton' },
        queryStringParameters: {},
      };

      const result = await handler(event);

      const body = JSON.parse(result.body);
      expect(body.builder.theme).toEqual({
        primaryColor: '#ff00ff',
        secondaryColor: '#00ffff',
        backgroundColor: '#0a0a0a',
        foregroundColor: '#ffffff',
        defaultMode: 'dark',
      });
      expect(body.builder.coverage).toEqual({
        type: 'postcode_radius',
        postcode: 'CW12 1AA',
        radius: 15,
      });
    });

    test('should return 404 for draft builder', async () => {
      const draftBuilder = createValidBuilder({ status: 'draft' });

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [draftBuilder] }),
      });

      const event = {
        requestContext: { http: { method: 'GET', path: '/api/builders/by-subdomain/congleton' } },
        headers: {},
        cookies: [],
        pathParameters: { slug: 'congleton' },
        queryStringParameters: {},
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
    });

    test('should return 404 for suspended builder', async () => {
      const suspendedBuilder = createValidBuilder({ status: 'suspended' });

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [suspendedBuilder] }),
      });

      const event = {
        requestContext: { http: { method: 'GET', path: '/api/builders/by-subdomain/congleton' } },
        headers: {},
        cookies: [],
        pathParameters: { slug: 'congleton' },
        queryStringParameters: {},
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
    });
  });

  // ========== GET /api/builders (user's builders) ==========
  describe('GET /api/builders', () => {
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

    test('should return empty array for user with no builders', async () => {
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      const event = createAuthenticatedEvent('GET', '/api/builders');

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.builders).toEqual([]);
    });

    test('should return builders for authenticated user', async () => {
      const mockBuilders = [
        createValidBuilder({ id: 'builder-1', name: 'Builder One' }),
        createValidBuilder({ id: 'builder-2', name: 'Builder Two', slug: 'buildertwo' }),
      ];

      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: mockBuilders }),
      });

      const event = createAuthenticatedEvent('GET', '/api/builders');

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.builders).toHaveLength(2);
    });
  });

  // ========== POST /api/builders ==========
  describe('POST /api/builders', () => {
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

    test('should reject duplicate slug', async () => {
      // Mock existing builder with same slug
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({
          Items: [createValidBuilder({ slug: 'congleton' })],
        }),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders', {
        body: JSON.stringify({
          name: 'Another Congleton',
          slug: 'congleton',
          theme: {
            primaryColor: '#ff00ff',
            secondaryColor: '#00ffff',
            backgroundColor: '#0a0a0a',
            foregroundColor: '#ffffff',
            defaultMode: 'dark',
          },
          coverage: { type: 'manual' },
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body).error).toContain('Slug already taken');
    });

    test('should create builder with valid data', async () => {
      // Mock no existing slug
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      mockDynamoDBPut.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders', {
        body: JSON.stringify({
          name: 'Congleton Live Music',
          slug: 'congleton',
          description: 'Live music in Congleton',
          theme: {
            primaryColor: '#ff00ff',
            secondaryColor: '#00ffff',
            backgroundColor: '#0a0a0a',
            foregroundColor: '#ffffff',
            defaultMode: 'dark',
          },
          coverage: {
            type: 'postcode_radius',
            postcode: 'CW12 1AA',
            radius: 15,
          },
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(201);
      expect(mockDynamoDBPut).toHaveBeenCalled();

      const putCall = mockDynamoDBPut.mock.calls[0][0];
      expect(putCall.Item.name).toBe('Congleton Live Music');
      expect(putCall.Item.slug).toBe('congleton');
      expect(putCall.Item.user_id).toBe('user-456');
      expect(putCall.Item.status).toBe('draft'); // New builders start as draft
    });

    test('should validate coverage schema - postcode_radius', async () => {
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders', {
        body: JSON.stringify({
          name: 'Test Builder',
          slug: 'testbuilder',
          theme: {
            primaryColor: '#ff00ff',
            secondaryColor: '#00ffff',
            backgroundColor: '#0a0a0a',
            foregroundColor: '#ffffff',
            defaultMode: 'dark',
          },
          coverage: {
            type: 'postcode_radius',
            // Missing postcode and radius
          },
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('postcode');
    });

    test('should validate coverage schema - postcode_areas', async () => {
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders', {
        body: JSON.stringify({
          name: 'Test Builder',
          slug: 'testbuilder',
          theme: {
            primaryColor: '#ff00ff',
            secondaryColor: '#00ffff',
            backgroundColor: '#0a0a0a',
            foregroundColor: '#ffffff',
            defaultMode: 'dark',
          },
          coverage: {
            type: 'postcode_areas',
            // Missing areas array
          },
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('areas');
    });

    test('should validate coverage schema - bounding_box', async () => {
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders', {
        body: JSON.stringify({
          name: 'Test Builder',
          slug: 'testbuilder',
          theme: {
            primaryColor: '#ff00ff',
            secondaryColor: '#00ffff',
            backgroundColor: '#0a0a0a',
            foregroundColor: '#ffffff',
            defaultMode: 'dark',
          },
          coverage: {
            type: 'bounding_box',
            // Missing sw and ne
          },
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('bounding_box');
    });

    test('should validate slug format (URL-safe)', async () => {
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders', {
        body: JSON.stringify({
          name: 'Test Builder',
          slug: 'invalid slug!@#', // Invalid characters
          theme: {
            primaryColor: '#ff00ff',
            secondaryColor: '#00ffff',
            backgroundColor: '#0a0a0a',
            foregroundColor: '#ffffff',
            defaultMode: 'dark',
          },
          coverage: { type: 'manual' },
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('slug');
    });

    test('should validate theme required fields', async () => {
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      const event = createAuthenticatedEvent('POST', '/api/builders', {
        body: JSON.stringify({
          name: 'Test Builder',
          slug: 'testbuilder',
          // Missing theme
          coverage: { type: 'manual' },
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('theme');
    });
  });

  // ========== PUT /api/builders/:id ==========
  describe('PUT /api/builders/:id', () => {
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

    test('should reject if user is not owner', async () => {
      // Mock builder owned by different user
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: createValidBuilder({ user_id: 'user-999' }), // Different owner
          }),
        });

      const event = createAuthenticatedEvent('PUT', '/api/builders/builder-123', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({ name: 'Updated Name' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(403);
      expect(JSON.parse(result.body).error).toContain('Not authorized');
    });

    test('should allow platformAdmin to update any builder', async () => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-admin',
        username: 'admin',
      });

      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-admin', platformAdmin: true },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: createValidBuilder({ user_id: 'user-999' }), // Different owner
          }),
        });

      mockDynamoDBUpdate.mockReturnValue({
        promise: () => Promise.resolve({
          Attributes: createValidBuilder({ name: 'Updated by Admin' }),
        }),
      });

      const event = createAuthenticatedEvent('PUT', '/api/builders/builder-123', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({ name: 'Updated by Admin' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
    });

    test('should update theme config', async () => {
      const existingBuilder = createValidBuilder({ user_id: 'user-456' });

      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: existingBuilder }),
        });

      mockDynamoDBUpdate.mockReturnValue({
        promise: () => Promise.resolve({
          Attributes: {
            ...existingBuilder,
            theme: {
              primaryColor: '#00ff00',
              secondaryColor: '#ff0000',
              backgroundColor: '#ffffff',
              foregroundColor: '#000000',
              defaultMode: 'light',
            },
          },
        }),
      });

      const event = createAuthenticatedEvent('PUT', '/api/builders/builder-123', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({
          theme: {
            primaryColor: '#00ff00',
            secondaryColor: '#ff0000',
            backgroundColor: '#ffffff',
            foregroundColor: '#000000',
            defaultMode: 'light',
          },
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.builder.theme.primaryColor).toBe('#00ff00');
    });

    test('should update coverage config', async () => {
      const existingBuilder = createValidBuilder({ user_id: 'user-456' });

      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: existingBuilder }),
        });

      mockDynamoDBUpdate.mockReturnValue({
        promise: () => Promise.resolve({
          Attributes: {
            ...existingBuilder,
            coverage: {
              type: 'postcode_areas',
              areas: ['CW', 'ST'],
            },
          },
        }),
      });

      const event = createAuthenticatedEvent('PUT', '/api/builders/builder-123', {
        pathParameters: { id: 'builder-123' },
        body: JSON.stringify({
          coverage: {
            type: 'postcode_areas',
            areas: ['CW', 'ST'],
          },
        }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.builder.coverage.type).toBe('postcode_areas');
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

      const event = createAuthenticatedEvent('PUT', '/api/builders/builder-999', {
        pathParameters: { id: 'builder-999' },
        body: JSON.stringify({ name: 'Updated Name' }),
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
    });
  });

  // ========== DELETE /api/builders/:id ==========
  describe('DELETE /api/builders/:id', () => {
    beforeEach(() => {
      mockVerifyToken.mockReturnValue({
        userId: 'user-456',
        username: 'testuser',
      });
    });

    test('should delete builder owned by user', async () => {
      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: createValidBuilder({ user_id: 'user-456' }),
          }),
        });

      mockDynamoDBDelete.mockReturnValue({
        promise: () => Promise.resolve({}),
      });

      const event = createAuthenticatedEvent('DELETE', '/api/builders/builder-123', {
        pathParameters: { id: 'builder-123' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(204);
      expect(mockDynamoDBDelete).toHaveBeenCalled();
    });

    test('should reject delete if user is not owner', async () => {
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

      const event = createAuthenticatedEvent('DELETE', '/api/builders/builder-123', {
        pathParameters: { id: 'builder-123' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(403);
    });
  });

  // ========== PUT /api/builders/:id/publish ==========
  describe('PUT /api/builders/:id/publish', () => {
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

    test('should publish draft builder', async () => {
      const draftBuilder = createValidBuilder({ user_id: 'user-456', status: 'draft' });

      mockDynamoDBGet
        .mockReturnValueOnce({
          promise: () => Promise.resolve({
            Item: { cognito_id: 'user-456', platformAdmin: false },
          }),
        })
        .mockReturnValueOnce({
          promise: () => Promise.resolve({ Item: draftBuilder }),
        });

      mockDynamoDBUpdate.mockReturnValue({
        promise: () => Promise.resolve({
          Attributes: { ...draftBuilder, status: 'published' },
        }),
      });

      const event = createAuthenticatedEvent('PUT', '/api/builders/builder-123/publish', {
        pathParameters: { id: 'builder-123' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.builder.status).toBe('published');
    });
  });

  // ========== RESPONSE HEADER TESTS ==========
  describe('Response Headers', () => {
    test('should leave CORS headers to API Gateway', async () => {
      mockDynamoDBQuery.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });

      const event = {
        requestContext: { http: { method: 'GET', path: '/api/builders/by-subdomain/test' } },
        headers: { origin: 'https://congleton.bndy.live' },
        cookies: [],
        pathParameters: { slug: 'test' },
        queryStringParameters: {},
      };

      const result = await handler(event);

      expect(result.headers['Content-Type']).toBe('application/json');
      expect(result.headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(result.headers['Access-Control-Allow-Credentials']).toBeUndefined();
    });

    test('should handle OPTIONS preflight', async () => {
      const event = {
        requestContext: { http: { method: 'OPTIONS', path: '/api/builders' } },
        headers: { origin: 'https://backstage.bndy.co.uk' },
        cookies: [],
      };

      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(result.headers['Content-Type']).toBe('application/json');
      expect(result.headers['Access-Control-Allow-Methods']).toBeUndefined();
    });
  });
});
