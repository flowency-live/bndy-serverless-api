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

  // ---------------------------------------------------------------------------
  // Feature 12 (2026-08-13). The backlog claimed a second act at one venue on one
  // night was blocked. It never was: the sentinel key is (venue|artist|date) and
  // the gate writes ONE PER ACT. These tests pin that rule down so nobody
  // "fixes" it back into a venue+date block later.
  // ---------------------------------------------------------------------------
  describe('the bill and the uniqueness gate', () => {
    const venue = { id: 'venue-123', name: 'The Music Hall', city: 'Stoke', latitude: 53.0, longitude: -2.1 };
    const NAMES = { 'artist-1': 'Not Guilty', 'artist-2': 'The Remedy', 'artist-3': 'Jazz Trio', 'artist-4': 'Small Hours' };

    /** No existing gigs at the venue, all artists resolve. */
    const emptyVenue = () => {
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-venues') return Promise.resolve({ Item: venue });
        if (params.TableName === 'bndy-artists') {
          const name = NAMES[params.Key.id];
          return Promise.resolve(name ? { Item: { id: params.Key.id, name } } : {});
        }
        // The create path reads the event back to prove the write persisted.
        if (params.TableName === 'bndy-events') return Promise.resolve({ Item: { id: params.Key.id } });
        return Promise.resolve({});
      });
      mockDynamoDB.scan.mockResolvedValue({ Items: [] });
      mockDynamoDB.query.mockResolvedValue({ Items: [] });
    };

    const sentinelKeys = () => {
      const call = mockDynamoDB.transactWrite.mock.calls.at(-1)[0];
      return call.TransactItems.filter(i => i.Put.TableName === 'bndy-unique-keys').map(i => i.Put.Item.key);
    };

    it('claims one sentinel per act on a three-act bill', async () => {
      emptyVenue();
      const result = await handler(createCommunityEvent({
        artistIds: ['artist-1', 'artist-2', 'artist-3'],
        venueId: 'venue-123', date: '2026-06-20', startTime: '20:00'
      }), {});

      expect(result.statusCode).toBe(201);
      const keys = sentinelKeys();
      expect(keys).toHaveLength(3);
      expect(new Set(keys).size).toBe(3); // one distinct key per act, never a shared venue+date key
    });

    it('ALLOWS a different act at the same venue on the same night', async () => {
      // This is the case the backlog wrongly recorded as blocked. An existing gig
      // is at this venue on this date, but with acts 1 and 2. Act 4 is free.
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-venues') return Promise.resolve({ Item: venue });
        if (params.TableName === 'bndy-artists') return Promise.resolve({ Item: { id: params.Key.id, name: NAMES[params.Key.id] } });
        if (params.TableName === 'bndy-events') return Promise.resolve({ Item: { id: params.Key.id } });
        return Promise.resolve({});
      });
      mockDynamoDB.scan.mockResolvedValue({ Items: [] });
      mockDynamoDB.query.mockImplementation((params) => {
        if (params.IndexName === 'venueId-date-index') {
          return Promise.resolve({ Items: [{ id: 'other', title: 'Earlier set', artistId: 'artist-1', collaboratingArtistIds: ['artist-2'], startTime: '18:00' }] });
        }
        return Promise.resolve({ Items: [] });
      });

      const result = await handler(createCommunityEvent({
        artistId: 'artist-4', venueId: 'venue-123', date: '2026-06-20', startTime: '21:00'
      }), {});

      expect(result.statusCode).toBe(201);
    });

    it('BLOCKS an act already playing that venue that night as a support act', async () => {
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-venues') return Promise.resolve({ Item: venue });
        if (params.TableName === 'bndy-artists') return Promise.resolve({ Item: { id: params.Key.id, name: NAMES[params.Key.id] } });
        if (params.TableName === 'bndy-events') return Promise.resolve({ Item: { id: params.Key.id } });
        return Promise.resolve({});
      });
      mockDynamoDB.scan.mockResolvedValue({ Items: [] });
      mockDynamoDB.query.mockImplementation((params) => {
        if (params.IndexName === 'venueId-date-index') {
          return Promise.resolve({ Items: [{ id: 'other', title: 'Earlier set', artistId: 'artist-1', collaboratingArtistIds: ['artist-2'], startTime: '18:00' }] });
        }
        return Promise.resolve({ Items: [] });
      });

      const result = await handler(createCommunityEvent({
        artistIds: ['artist-4', 'artist-2'], // artist-2 supports the earlier gig too
        venueId: 'venue-123', date: '2026-06-20', startTime: '21:00'
      }), {});

      expect(result.statusCode).toBe(409);
    });

    it('gives a co-headline bill the same keys as a supported bill', async () => {
      // Billing is presentation. It must never change the identity of the gig.
      emptyVenue();
      await handler(createCommunityEvent({
        artistIds: ['artist-1', 'artist-2'],
        venueId: 'venue-123', date: '2026-06-20', startTime: '20:00'
      }), {});
      const supported = sentinelKeys().sort();

      emptyVenue();
      await handler(createCommunityEvent({
        artistIds: ['artist-1', 'artist-2'],
        headlineArtistIds: ['artist-1', 'artist-2'],
        venueId: 'venue-123', date: '2026-06-20', startTime: '20:00'
      }), {});
      expect(sentinelKeys().sort()).toEqual(supported);
    });
  });
});
