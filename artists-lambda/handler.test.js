/**
 * Artists Handler Tests - GET /api/artists Performance
 *
 * Tests for the public artists list endpoint:
 * - No N+1 queries (only scan, no event count queries)
 * - Cache-Control header for CDN/browser caching
 * - Response format (no unused eventCount field)
 */

const mockDynamoDB = {
  query: jest.fn(),
  put: jest.fn(),
  scan: jest.fn(),
  get: jest.fn()
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      scan: (params) => ({ promise: () => mockDynamoDB.scan(params) }),
      get: (params) => ({ promise: () => mockDynamoDB.get(params) })
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

describe('GET /api/artists - Performance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createGetArtistsEvent = () => ({
    requestContext: {
      http: {
        method: 'GET',
        path: '/api/artists'
      }
    },
    headers: {
      origin: 'https://live.bndy.co.uk'
    }
  });

  const mockArtists = [
    {
      id: 'artist-1',
      name: 'Test Artist 1',
      location: 'Bristol',
      genres: ['rock'],
      profileImageUrl: 'https://example.com/img1.jpg'
    },
    {
      id: 'artist-2',
      name: 'Test Artist 2',
      location: 'Manchester',
      genres: ['jazz'],
      profileImageUrl: 'https://example.com/img2.jpg'
    }
  ];

  describe('No N+1 Queries', () => {
    it('should only call scan once, not query events table for each artist', async () => {
      mockDynamoDB.scan.mockResolvedValue({ Items: mockArtists });

      const event = createGetArtistsEvent();
      await handler(event, {});

      // Should call scan exactly once
      expect(mockDynamoDB.scan).toHaveBeenCalledTimes(1);
      expect(mockDynamoDB.scan).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'bndy-artists'
        })
      );

      // Should NOT call query at all (no event count lookups)
      expect(mockDynamoDB.query).not.toHaveBeenCalled();
    });
  });

  describe('Cache Headers', () => {
    it('should include Cache-Control header for CDN caching', async () => {
      mockDynamoDB.scan.mockResolvedValue({ Items: mockArtists });

      const event = createGetArtistsEvent();
      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      expect(result.headers).toHaveProperty('Cache-Control');
      expect(result.headers['Cache-Control']).toMatch(/max-age=\d+/);
    });
  });

  describe('Response Format', () => {
    it('should return artists without eventCount field', async () => {
      mockDynamoDB.scan.mockResolvedValue({ Items: mockArtists });

      const event = createGetArtistsEvent();
      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      const artists = JSON.parse(result.body);

      expect(artists).toHaveLength(2);
      artists.forEach(artist => {
        expect(artist).not.toHaveProperty('eventCount');
        expect(artist).toHaveProperty('id');
        expect(artist).toHaveProperty('name');
      });
    });

    it('should return 200 with empty array when no artists exist', async () => {
      mockDynamoDB.scan.mockResolvedValue({ Items: [] });

      const event = createGetArtistsEvent();
      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      const artists = JSON.parse(result.body);
      expect(artists).toEqual([]);
    });
  });
});
