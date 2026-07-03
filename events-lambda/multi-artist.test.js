/**
 * Multi-Artist Events Tests
 *
 * Tests for multi-artist event functionality:
 * - Create community event with multiple artists
 * - Store collaboratingArtistIds array
 * - Return artistIds and artistNames arrays
 * - Query events where artist is primary OR collaborating
 */

const mockDynamoDB = {
  query: jest.fn(),
  put: jest.fn(),
  scan: jest.fn(),
  get: jest.fn(),
  update: jest.fn(),
  delete: jest.fn()
};

// Mock jsonwebtoken for authenticated routes
jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(() => ({ userId: 'test-user-123' })),
  sign: jest.fn(() => 'mock-jwt-token')
}));

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      scan: (params) => ({ promise: () => mockDynamoDB.scan(params) }),
      get: (params) => ({ promise: () => mockDynamoDB.get(params) }),
      batchGet: (params) => ({
        promise: async () => {
          const Responses = {};
          for (const [table, spec] of Object.entries(params.RequestItems)) {
            Responses[table] = [];
            for (const key of spec.Keys) {
              const r = await mockDynamoDB.get({ TableName: table, Key: key });
              if (r && r.Item) Responses[table].push(r.Item);
            }
          }
          return { Responses };
        }
      }),
      update: (params) => ({ promise: () => mockDynamoDB.update(params) }),
      delete: (params) => ({ promise: () => mockDynamoDB.delete(params) })
    }))
  },
  SSM: jest.fn(() => ({
    getParameter: () => ({
      promise: () => Promise.resolve({ Parameter: { Value: 'test-secret' } })
    })
  })),
  Lambda: jest.fn(() => ({
    invoke: () => ({
      promise: () => Promise.resolve({ Payload: '{}' })
    })
  }))
}));

const { handler } = require('./handler');

describe('Multi-Artist Events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createCommunityEvent = (body) => ({
    requestContext: {
      http: {
        method: 'POST',
        path: '/api/events/community'
      }
    },
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const createGetPublicEventsEvent = (queryParams = {}) => ({
    requestContext: {
      http: {
        method: 'GET',
        path: '/api/events/public'
      }
    },
    queryStringParameters: queryParams
  });

  const createGetArtistPublicEventsEvent = (artistId, queryParams = {}) => ({
    requestContext: {
      http: {
        method: 'GET',
        path: `/api/artists/${artistId}/public-events`
      }
    },
    pathParameters: { artistId },
    queryStringParameters: queryParams
  });

  describe('Create Community Event with Multiple Artists', () => {
    const mockVenue = {
      id: 'venue-123',
      name: 'The Music Hall',
      city: 'Manchester',
      latitude: 53.4808,
      longitude: -2.2426
    };

    const mockArtist1 = { id: 'artist-1', name: 'Not Guilty' };
    const mockArtist2 = { id: 'artist-2', name: 'The Remedy' };
    const mockArtist3 = { id: 'artist-3', name: 'Jazz Trio' };
    const mockArtist4 = { id: 'artist-4', name: 'Rock Band' };

    beforeEach(() => {
      // Mock venue lookup
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-venues') {
          return Promise.resolve({ Item: mockVenue });
        }
        if (params.TableName === 'bndy-artists') {
          const artists = {
            'artist-1': mockArtist1,
            'artist-2': mockArtist2,
            'artist-3': mockArtist3,
            'artist-4': mockArtist4
          };
          return Promise.resolve({ Item: artists[params.Key.id] });
        }
        return Promise.resolve({});
      });
      mockDynamoDB.put.mockResolvedValue({});
    });

    it('should store collaboratingArtistIds when multiple artists provided', async () => {
      const event = createCommunityEvent({
        artistIds: ['artist-1', 'artist-2', 'artist-3', 'artist-4'],
        venueId: 'venue-123',
        date: '2025-06-15',
        startTime: '21:00',
        source: 'frontstage'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(201);

      // Verify DynamoDB put was called with collaboratingArtistIds
      expect(mockDynamoDB.put).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({
            artistId: 'artist-1', // Primary artist
            collaboratingArtistIds: ['artist-2', 'artist-3', 'artist-4'], // Collaborators
            source: 'frontstage'
          })
        })
      );
    });

    it('should return artistIds array in response', async () => {
      const event = createCommunityEvent({
        artistIds: ['artist-1', 'artist-2', 'artist-3'],
        venueId: 'venue-123',
        date: '2025-06-15',
        startTime: '21:00'
      });

      const result = await handler(event, {});
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(201);
      expect(body.event.artistIds).toEqual(['artist-1', 'artist-2', 'artist-3']);
    });

    it('should return artistNames array in response', async () => {
      const event = createCommunityEvent({
        artistIds: ['artist-1', 'artist-2', 'artist-3'],
        venueId: 'venue-123',
        date: '2025-06-15',
        startTime: '21:00'
      });

      const result = await handler(event, {});
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(201);
      expect(body.event.artistNames).toEqual(['Not Guilty', 'The Remedy', 'Jazz Trio']);
    });

    it('should generate title with "+ N more" format for 3+ artists', async () => {
      const event = createCommunityEvent({
        artistIds: ['artist-1', 'artist-2', 'artist-3', 'artist-4'],
        venueId: 'venue-123',
        date: '2025-06-15',
        startTime: '21:00'
      });

      const result = await handler(event, {});

      expect(mockDynamoDB.put).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({
            title: 'Not Guilty + 3 more @ The Music Hall'
          })
        })
      );
    });

    it('should work with single artist (backward compatible)', async () => {
      const event = createCommunityEvent({
        artistId: 'artist-1', // Single artistId (legacy)
        venueId: 'venue-123',
        date: '2025-06-15',
        startTime: '21:00'
      });

      const result = await handler(event, {});
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(201);
      expect(mockDynamoDB.put).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({
            artistId: 'artist-1',
            collaboratingArtistIds: [] // Empty array for single artist
          })
        })
      );
      expect(body.event.artistIds).toEqual(['artist-1']);
    });
  });

  describe('Get Public Events with Multiple Artists', () => {
    it('should return artistIds and artistNames arrays', async () => {
      const multiArtistEvent = {
        id: 'event-123',
        artistId: 'artist-1',
        collaboratingArtistIds: ['artist-2', 'artist-3'],
        venueId: 'venue-123',
        date: '2025-06-15',
        isPublic: true
      };

      mockDynamoDB.scan.mockResolvedValue({ Items: [multiArtistEvent] });
      mockDynamoDB.get.mockImplementation((params) => {
        const data = {
          'artist-1': { id: 'artist-1', name: 'Not Guilty' },
          'artist-2': { id: 'artist-2', name: 'The Remedy' },
          'artist-3': { id: 'artist-3', name: 'Jazz Trio' },
          'venue-123': { id: 'venue-123', name: 'The Hall', city: 'Manchester' }
        };
        return Promise.resolve({ Item: data[params.Key.id] });
      });

      const event = createGetPublicEventsEvent({ startDate: '2025-06-01' });
      const result = await handler(event, {});
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(200);
      expect(body.events[0].artistIds).toEqual(['artist-1', 'artist-2', 'artist-3']);
      expect(body.events[0].artistNames).toEqual(['Not Guilty', 'The Remedy', 'Jazz Trio']);
    });
  });

  describe('Get Artist Public Events (includes collaborating)', () => {
    const primaryEvent = {
      id: 'event-1',
      artistId: 'artist-1',
      collaboratingArtistIds: [],
      venueId: 'venue-123',
      date: '2025-06-15',
      isPublic: true
    };

    const collaboratingEvent = {
      id: 'event-2',
      artistId: 'artist-2', // Different primary
      collaboratingArtistIds: ['artist-1', 'artist-3'], // artist-1 is collaborating
      venueId: 'venue-456',
      date: '2025-06-20',
      isPublic: true
    };

    it('should return events where artist is primary', async () => {
      // Mock GSI query for primary artist
      mockDynamoDB.query.mockResolvedValue({ Items: [primaryEvent] });
      // Mock scan for collaborating (returns nothing for this test)
      mockDynamoDB.scan.mockResolvedValue({ Items: [] });
      mockDynamoDB.get.mockResolvedValue({ Item: { id: 'venue-123', name: 'Venue 1', city: 'Manchester' } });

      const event = createGetArtistPublicEventsEvent('artist-1', { startDate: '2025-06-01' });
      const result = await handler(event, {});
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(200);
      expect(body.events.length).toBeGreaterThanOrEqual(1);
      expect(body.events.some(e => e.id === 'event-1')).toBe(true);
    });

    it('should return events where artist is collaborating', async () => {
      // Mock GSI query for primary artist (returns nothing)
      mockDynamoDB.query.mockResolvedValue({ Items: [] });
      // Mock scan for collaborating
      mockDynamoDB.scan.mockResolvedValue({ Items: [collaboratingEvent] });
      mockDynamoDB.get.mockResolvedValue({ Item: { id: 'venue-456', name: 'Venue 2', city: 'Liverpool' } });

      const event = createGetArtistPublicEventsEvent('artist-1', { startDate: '2025-06-01' });
      const result = await handler(event, {});
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(200);
      expect(body.events.some(e => e.id === 'event-2')).toBe(true);
    });

    it('should combine primary and collaborating events without duplicates', async () => {
      mockDynamoDB.query.mockResolvedValue({ Items: [primaryEvent] });
      mockDynamoDB.scan.mockResolvedValue({ Items: [collaboratingEvent] });
      mockDynamoDB.get.mockImplementation((params) => {
        const venues = {
          'venue-123': { id: 'venue-123', name: 'Venue 1', city: 'Manchester' },
          'venue-456': { id: 'venue-456', name: 'Venue 2', city: 'Liverpool' }
        };
        return Promise.resolve({ Item: venues[params.Key.id] });
      });

      const event = createGetArtistPublicEventsEvent('artist-1', { startDate: '2025-06-01' });
      const result = await handler(event, {});
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(200);
      expect(body.events.length).toBe(2);
      expect(body.events.map(e => e.id).sort()).toEqual(['event-1', 'event-2']);
    });
  });

  describe('Leave Event Endpoint', () => {
    // Helper to create authenticated request with session cookie
    const createLeaveEventRequest = (artistId, eventId) => ({
      requestContext: {
        http: {
          method: 'POST',
          path: `/api/artists/${artistId}/events/${eventId}/leave`
        }
      },
      pathParameters: { artistId, id: eventId },
      headers: {
        'Content-Type': 'application/json',
        'cookie': 'bndy_session=mock-jwt-token'
      }
    });

    it('should remove collaborating artist from event', async () => {
      const existingEvent = {
        id: 'event-123',
        artistId: 'artist-1', // Primary
        collaboratingArtistIds: ['artist-2', 'artist-3'], // artist-2 wants to leave
        venueId: 'venue-123',
        date: '2025-06-15'
      };

      // Mock both user lookup (for auth) and event lookup
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-users') {
          return Promise.resolve({ Item: { cognito_id: 'test-user-123', name: 'Test User' } });
        }
        return Promise.resolve({ Item: existingEvent });
      });
      mockDynamoDB.update.mockResolvedValue({
        Attributes: {
          ...existingEvent,
          collaboratingArtistIds: ['artist-3'] // artist-2 removed
        }
      });

      const event = createLeaveEventRequest('artist-2', 'event-123');
      const result = await handler(event, {});
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(200);
      expect(body.message).toContain('left');

      // Verify update was called to remove artist from collaboratingArtistIds
      expect(mockDynamoDB.update).toHaveBeenCalled();
    });

    it('should not allow primary artist to leave (must delete instead)', async () => {
      const existingEvent = {
        id: 'event-123',
        artistId: 'artist-1', // Primary - cannot leave
        collaboratingArtistIds: ['artist-2'],
        venueId: 'venue-123',
        date: '2025-06-15'
      };

      // Mock both user lookup (for auth) and event lookup
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-users') {
          return Promise.resolve({ Item: { cognito_id: 'test-user-123', name: 'Test User' } });
        }
        return Promise.resolve({ Item: existingEvent });
      });

      const event = createLeaveEventRequest('artist-1', 'event-123');
      const result = await handler(event, {});

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('Primary');
    });

    it('should return 404 if artist is not part of event', async () => {
      const existingEvent = {
        id: 'event-123',
        artistId: 'artist-1',
        collaboratingArtistIds: ['artist-2'],
        venueId: 'venue-123',
        date: '2025-06-15'
      };

      // Mock both user lookup (for auth) and event lookup
      mockDynamoDB.get.mockImplementation((params) => {
        if (params.TableName === 'bndy-users') {
          return Promise.resolve({ Item: { cognito_id: 'test-user-123', name: 'Test User' } });
        }
        return Promise.resolve({ Item: existingEvent });
      });

      const event = createLeaveEventRequest('artist-99', 'event-123'); // Not in event
      const result = await handler(event, {});

      expect(result.statusCode).toBe(404);
    });
  });
});
