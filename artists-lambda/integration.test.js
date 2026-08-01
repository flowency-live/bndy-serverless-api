/**
 * Artists Integration API Tests
 *
 * Tests for the /api/integration/artists endpoint:
 * - API key authentication
 * - Find-or-create semantics (wraps existing search + create)
 * - Duplicate prevention via name + location matching
 * - Social media URL support
 */

const mockDynamoDB = {
  query: jest.fn(),
  put: jest.fn(),
  scan: jest.fn(),
  get: jest.fn(),
  transactWrite: jest.fn().mockResolvedValue({}),
  delete: jest.fn().mockResolvedValue({})
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      scan: (params) => ({ promise: () => mockDynamoDB.scan(params) }),
      get: (params) => ({ promise: () => mockDynamoDB.get(params) }),
      transactWrite: (params) => ({ promise: () => mockDynamoDB.transactWrite(params) }),
      delete: (params) => ({ promise: () => mockDynamoDB.delete(params) })
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

// Set environment variables before requiring handler
process.env.INTEGRATION_API_KEYS = 'test-api-key-123,another-valid-key';

const { handler } = require('./handler');

describe('Artists Integration API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createIntegrationEvent = (body, apiKey = 'test-api-key-123') => ({
    requestContext: {
      http: {
        method: 'POST',
        path: '/api/integration/artists'
      }
    },
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  describe('API Key Authentication', () => {
    it('should reject requests without API key', async () => {
      const event = createIntegrationEvent({ name: 'Test Artist', location: 'Bristol' }, null);
      delete event.headers['x-api-key'];

      const result = await handler(event, {});

      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body)).toEqual({
        error: 'Invalid or missing API key'
      });
    });

    it('should reject requests with invalid API key', async () => {
      const event = createIntegrationEvent({ name: 'Test Artist', location: 'Bristol' }, 'invalid-key');

      const result = await handler(event, {});

      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body)).toEqual({
        error: 'Invalid or missing API key'
      });
    });

    it('should accept requests with valid API key', async () => {
      // Mock no existing artists found
      mockDynamoDB.query.mockResolvedValue({ Items: [] });
      mockDynamoDB.put.mockResolvedValue({});

      const event = createIntegrationEvent({ name: 'Test Artist', location: 'Bristol' });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(201);
    });
  });

  describe('Input Validation', () => {
    it('should reject requests without name', async () => {
      const event = createIntegrationEvent({ location: 'Bristol' });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('name');
    });

    it('should reject requests without location', async () => {
      const event = createIntegrationEvent({ name: 'Test Artist' });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('location');
    });
  });

  describe('Find-or-Create Logic', () => {
    it('should return existing artist when exact name match found', async () => {
      const existingArtist = {
        id: 'existing-artist-123',
        name: 'The Fleece Band',
        name_lower: 'the fleece band',
        name_prefix: 'th',
        location: 'Bristol',
        profileImageUrl: 'https://example.com/image.jpg'
      };

      // Mock GSI query returns existing artist
      mockDynamoDB.query.mockResolvedValue({
        Items: [existingArtist]
      });

      const event = createIntegrationEvent({
        name: 'The Fleece Band',
        location: 'Bristol'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.isNew).toBe(false);
      expect(body.artist.id).toBe('existing-artist-123');
      expect(body.matchMethod).toBe('name_match');
    });

    it('should create new artist when no match found', async () => {
      // Mock no existing artists found
      mockDynamoDB.query.mockResolvedValue({ Items: [] });
      mockDynamoDB.put.mockResolvedValue({});

      const event = createIntegrationEvent({
        name: 'Brand New Artist',
        location: 'Manchester'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.isNew).toBe(true);
      expect(body.artist.name).toBe('Brand New Artist');
      expect(body.artist.location).toBe('Manchester');
      expect(body.matchMethod).toBe('new_artist_created');

      // Verify artist was created in DynamoDB
      expect(mockDynamoDB.put).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'bndy-artists',
          Item: expect.objectContaining({
            name: 'Brand New Artist',
            location: 'Manchester',
            ai_created: true,
            needs_review: true,
            source: 'integration_api'
          })
        })
      );
    });

    it('should create new artist when match score too low', async () => {
      const lowMatchArtist = {
        id: 'low-match-123',
        name: 'Something Completely Different',
        name_lower: 'so',
        name_prefix: 'so',
        location: 'London'
      };

      // Mock GSI returns artist but with low match score
      mockDynamoDB.query.mockResolvedValue({
        Items: [lowMatchArtist]
      });
      mockDynamoDB.put.mockResolvedValue({});

      const event = createIntegrationEvent({
        name: 'Sonic Youth Tribute',
        location: 'Bristol'
      });

      const result = await handler(event, {});

      // Should create new because match score is low
      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.isNew).toBe(true);
    });
  });

  describe('Social Media URLs', () => {
    it('should store social media URLs when provided', async () => {
      mockDynamoDB.query.mockResolvedValue({ Items: [] });
      mockDynamoDB.put.mockResolvedValue({});

      const event = createIntegrationEvent({
        name: 'Social Media Artist',
        location: 'Bristol',
        facebookUrl: 'https://facebook.com/testartist',
        instagramUrl: 'https://instagram.com/testartist',
        websiteUrl: 'https://testartist.com',
        spotifyUrl: 'https://open.spotify.com/artist/123'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(201);
      expect(mockDynamoDB.put).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({
            facebookUrl: 'https://facebook.com/testartist',
            instagramUrl: 'https://instagram.com/testartist',
            websiteUrl: 'https://testartist.com',
            spotifyUrl: 'https://open.spotify.com/artist/123'
          })
        })
      );
    });
  });

  describe('Response Format', () => {
    it('should return consistent response structure for existing artist', async () => {
      const existingArtist = {
        id: 'existing-123',
        name: 'Existing Artist',
        name_lower: 'existing artist',
        name_prefix: 'ex',
        location: 'Bristol',
        facebookUrl: 'https://facebook.com/existing'
      };

      mockDynamoDB.query.mockResolvedValue({ Items: [existingArtist] });

      const event = createIntegrationEvent({
        name: 'Existing Artist',
        location: 'Bristol'
      });

      const result = await handler(event, {});
      const body = JSON.parse(result.body);

      expect(body).toHaveProperty('success', true);
      expect(body).toHaveProperty('artist');
      expect(body).toHaveProperty('isNew', false);
      expect(body).toHaveProperty('matchMethod');
      expect(body.artist).toHaveProperty('id');
      expect(body.artist).toHaveProperty('name');
      expect(body.artist).toHaveProperty('location');
    });

    it('should return consistent response structure for new artist', async () => {
      mockDynamoDB.query.mockResolvedValue({ Items: [] });
      mockDynamoDB.put.mockResolvedValue({});

      const event = createIntegrationEvent({
        name: 'New Artist',
        location: 'Manchester'
      });

      const result = await handler(event, {});
      const body = JSON.parse(result.body);

      expect(body).toHaveProperty('success', true);
      expect(body).toHaveProperty('artist');
      expect(body).toHaveProperty('isNew', true);
      expect(body).toHaveProperty('matchMethod', 'new_artist_created');
      expect(body.artist).toHaveProperty('id');
      expect(body.artist).toHaveProperty('name', 'New Artist');
      expect(body.artist).toHaveProperty('location', 'Manchester');
    });
  });
});
