/**
 * Event Deduplication Tests
 *
 * Tests for duplicate event detection via checkForDuplicateEvent:
 * - Same venueId + artistId + date → 409 Conflict
 * - Uses venueId-date-index GSI (not scan) for complete results
 */

const mockDynamoDB = {
  query: jest.fn(),
  put: jest.fn(),
  get: jest.fn(),
  scan: jest.fn(),
  // Hard uniqueness gate (2026-07-27): community creates now write via
  // TransactWriteItems (event + sentinel items). Default: success.
  // Simulate a gate bounce with:
  //   mockDynamoDB.transactWrite.mockRejectedValueOnce(
  //     Object.assign(new Error('cancelled'), { code: 'TransactionCanceledException' }))
  transactWrite: jest.fn().mockResolvedValue({}),
  delete: jest.fn().mockResolvedValue({}),
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      get: (params) => ({ promise: () => mockDynamoDB.get(params) }),
      scan: (params) => ({ promise: () => mockDynamoDB.scan(params) }),
      transactWrite: (params) => ({ promise: () => mockDynamoDB.transactWrite(params) }),
      delete: (params) => ({ promise: () => mockDynamoDB.delete(params) }),
    })),
  },
  SSM: jest.fn(() => ({
    getParameter: () => ({
      promise: () => Promise.resolve({ Parameter: { Value: 'test-secret' } }),
    }),
  })),
  Lambda: jest.fn(() => ({
    invoke: () => ({ promise: () => Promise.resolve({ Payload: '{}' }) }),
  })),
}));

const { handler } = require('./handler');

describe('Event Deduplication (checkForDuplicateEvent)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createCommunityEvent = (body) => ({
    requestContext: {
      http: {
        method: 'POST',
        path: '/api/events/community',
      },
    },
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const mockVenue = {
    id: 'venue-123',
    name: 'Test Venue',
    city: 'Stoke',
    latitude: 53.0,
    longitude: -2.1,
  };

  const mockArtist = {
    id: 'artist-1',
    name: 'Test Artist',
  };

  describe('when an event already exists at venue+date+artist', () => {
    it('should return 409 Conflict on second create', async () => {
      // Mock venue and artist lookups
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-venues') {
          return Promise.resolve({ Item: mockVenue });
        }
        if (params.TableName === 'bndy-artists') {
          return Promise.resolve({ Item: mockArtist });
        }
        return Promise.resolve({});
      });

      // Mock externalId check - returns no matching external IDs
      mockDynamoDB.scan.mockResolvedValue({ Items: [] });

      // Mock venue+date lookup (query on GSI)
      mockDynamoDB.query.mockImplementation((params) => {
        if (params.IndexName === 'venueId-date-index') {
          // Existing event at this venue+date with same artist
          return Promise.resolve({
            Items: [
              {
                id: 'existing-event-123',
                title: 'Existing Event',
                artistId: 'artist-1',
                collaboratingArtistIds: [],
                startTime: '21:00',
              },
            ],
          });
        }
        return Promise.resolve({ Items: [] });
      });

      const event = createCommunityEvent({
        artistId: 'artist-1',
        venueId: 'venue-123',
        date: '2026-06-20',
        startTime: '21:00',
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Duplicate');
      expect(body.existingEventId).toBe('existing-event-123');
    });

    it('should use venueId-date-index GSI for lookup (not scan)', async () => {
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-venues') {
          return Promise.resolve({ Item: mockVenue });
        }
        if (params.TableName === 'bndy-artists') {
          return Promise.resolve({ Item: mockArtist });
        }
        return Promise.resolve({});
      });

      mockDynamoDB.scan.mockResolvedValue({ Items: [] });

      // Existing event - should trigger duplicate detection
      mockDynamoDB.query.mockImplementation((params) => {
        if (params.IndexName === 'venueId-date-index') {
          return Promise.resolve({
            Items: [
              {
                id: 'existing-event-456',
                title: 'Another Event',
                artistId: 'artist-1',
                collaboratingArtistIds: [],
                startTime: '20:00',
              },
            ],
          });
        }
        return Promise.resolve({ Items: [] });
      });

      const event = createCommunityEvent({
        artistId: 'artist-1',
        venueId: 'venue-123',
        date: '2026-06-20',
        startTime: '21:00',
      });

      await handler(event, {});

      // Verify that query was called with the GSI
      const gsiQuery = mockDynamoDB.query.mock.calls.find(
        (call) => call[0].IndexName === 'venueId-date-index'
      );
      expect(gsiQuery).toBeDefined();
      expect(gsiQuery[0].KeyConditionExpression).toContain('venueId = :venueId');
      expect(gsiQuery[0].KeyConditionExpression).toContain('#date = :date');
    });

    it('should allow event when artist is different', async () => {
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-venues') {
          return Promise.resolve({ Item: mockVenue });
        }
        if (params.TableName === 'bndy-artists') {
          return Promise.resolve({ Item: { id: 'artist-2', name: 'Different Artist' } });
        }
        if (params.TableName === 'bndy-events') {
          // Verification read - return the created event
          return Promise.resolve({ Item: { id: params.Key.id } });
        }
        return Promise.resolve({});
      });

      mockDynamoDB.scan.mockResolvedValue({ Items: [] });

      // Existing event with DIFFERENT artist
      mockDynamoDB.query.mockImplementation((params) => {
        if (params.IndexName === 'venueId-date-index') {
          return Promise.resolve({
            Items: [
              {
                id: 'existing-event-789',
                title: 'Event with Different Artist',
                artistId: 'artist-1', // Different from artist-2
                collaboratingArtistIds: [],
                startTime: '20:00',
              },
            ],
          });
        }
        return Promise.resolve({ Items: [] });
      });

      mockDynamoDB.put.mockResolvedValue({});

      const event = createCommunityEvent({
        artistId: 'artist-2', // Different artist
        venueId: 'venue-123',
        date: '2026-06-20',
        startTime: '21:00',
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(201); // Created successfully
    });

    it('should detect duplicate when artist is in collaboratingArtistIds', async () => {
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-venues') {
          return Promise.resolve({ Item: mockVenue });
        }
        if (params.TableName === 'bndy-artists') {
          return Promise.resolve({ Item: { id: 'artist-2', name: 'Artist Two' } });
        }
        return Promise.resolve({});
      });

      mockDynamoDB.scan.mockResolvedValue({ Items: [] });

      // Existing event where artist-2 is a collaborator
      mockDynamoDB.query.mockImplementation((params) => {
        if (params.IndexName === 'venueId-date-index') {
          return Promise.resolve({
            Items: [
              {
                id: 'existing-event-collab',
                title: 'Multi-Artist Event',
                artistId: 'artist-1',
                collaboratingArtistIds: ['artist-2', 'artist-3'], // artist-2 is collaborating
                startTime: '20:00',
              },
            ],
          });
        }
        return Promise.resolve({ Items: [] });
      });

      const event = createCommunityEvent({
        artistId: 'artist-2', // Same as collaborating artist
        venueId: 'venue-123',
        date: '2026-06-20',
        startTime: '21:00',
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Duplicate');
    });
  });
});
