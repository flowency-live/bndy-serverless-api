/**
 * Events Integration API Tests
 *
 * Tests for the /api/integration/events endpoint:
 * - API key authentication
 * - Find-or-create semantics (wraps existing duplicate check)
 * - Duplicate prevention via artistId + date + venueId
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
  Lambda: jest.fn(() => ({
    invoke: () => ({
      promise: () => Promise.resolve({ Payload: '{}' })
    })
  }))
}));

// Set environment variables before requiring handler
process.env.INTEGRATION_API_KEYS = 'test-api-key-123,another-valid-key';

const { handler } = require('./handler');

describe('Events Integration API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createIntegrationEvent = (body, apiKey = 'test-api-key-123') => ({
    requestContext: {
      http: {
        method: 'POST',
        path: '/api/integration/events'
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
      const event = createIntegrationEvent({
        artistId: 'artist-123',
        venueId: 'venue-456',
        date: '2025-06-15'
      }, null);
      delete event.headers['x-api-key'];

      const result = await handler(event, {});

      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body)).toEqual({
        error: 'Invalid or missing API key'
      });
    });

    it('should reject requests with invalid API key', async () => {
      const event = createIntegrationEvent({
        artistId: 'artist-123',
        venueId: 'venue-456',
        date: '2025-06-15'
      }, 'invalid-key');

      const result = await handler(event, {});

      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body)).toEqual({
        error: 'Invalid or missing API key'
      });
    });

    it('should accept requests with valid API key', async () => {
      // Mock no existing events found
      mockDynamoDB.query.mockResolvedValue({ Items: [] });
      mockDynamoDB.put.mockResolvedValue({});

      const event = createIntegrationEvent({
        artistId: 'artist-123',
        venueId: 'venue-456',
        date: '2025-06-15'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(201);
    });
  });

  describe('Input Validation', () => {
    it('should reject requests without artistId', async () => {
      const event = createIntegrationEvent({
        venueId: 'venue-456',
        date: '2025-06-15'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('artistId');
    });

    it('should reject requests without venueId', async () => {
      const event = createIntegrationEvent({
        artistId: 'artist-123',
        date: '2025-06-15'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('venueId');
    });

    it('should reject requests without date', async () => {
      const event = createIntegrationEvent({
        artistId: 'artist-123',
        venueId: 'venue-456'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('date');
    });
  });

  describe('Find-or-Create Logic', () => {
    it('should return existing event when duplicate found', async () => {
      const existingEvent = {
        id: 'existing-event-123',
        artistId: 'artist-123',
        venueId: 'venue-456',
        date: '2025-06-15',
        title: 'Existing Gig',
        type: 'public_gig'
      };

      // Mock GSI query returns existing event
      mockDynamoDB.query.mockResolvedValue({
        Items: [existingEvent]
      });

      const event = createIntegrationEvent({
        artistId: 'artist-123',
        venueId: 'venue-456',
        date: '2025-06-15'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.isNew).toBe(false);
      expect(body.event.id).toBe('existing-event-123');
      expect(body.matchMethod).toBe('artist_venue_date');
    });

    it('should create new event when no duplicate found', async () => {
      // Mock no existing events found
      mockDynamoDB.query.mockResolvedValue({ Items: [] });
      mockDynamoDB.put.mockResolvedValue({});

      const event = createIntegrationEvent({
        artistId: 'artist-123',
        venueId: 'venue-456',
        date: '2025-06-15',
        title: 'New Summer Gig',
        startTime: '20:00',
        endTime: '23:00'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.isNew).toBe(true);
      expect(body.event.artistId).toBe('artist-123');
      expect(body.event.venueId).toBe('venue-456');
      expect(body.event.date).toBe('2025-06-15');
      expect(body.matchMethod).toBe('new_event_created');

      // Verify event was created in DynamoDB
      expect(mockDynamoDB.put).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'bndy-events',
          Item: expect.objectContaining({
            artistId: 'artist-123',
            venueId: 'venue-456',
            date: '2025-06-15',
            ai_created: true,
            needs_review: true,
            source: 'integration_api'
          })
        })
      );
    });
  });

  describe('Optional Fields', () => {
    it('should store optional fields when provided', async () => {
      mockDynamoDB.query.mockResolvedValue({ Items: [] });
      mockDynamoDB.put.mockResolvedValue({});

      const event = createIntegrationEvent({
        artistId: 'artist-123',
        venueId: 'venue-456',
        date: '2025-06-15',
        title: 'Summer Festival Set',
        startTime: '19:00',
        endTime: '21:30',
        ticketUrl: 'https://tickets.example.com/event123',
        ticketPrice: '15.00',
        description: 'An amazing live performance'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(201);
      expect(mockDynamoDB.put).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({
            title: 'Summer Festival Set',
            startTime: '19:00',
            endTime: '21:30',
            ticketUrl: 'https://tickets.example.com/event123',
            ticketPrice: '15.00',
            description: 'An amazing live performance'
          })
        })
      );
    });
  });

  describe('Response Format', () => {
    it('should return consistent response structure for existing event', async () => {
      const existingEvent = {
        id: 'existing-123',
        artistId: 'artist-123',
        venueId: 'venue-456',
        date: '2025-06-15',
        title: 'Existing Event',
        type: 'public_gig'
      };

      mockDynamoDB.query.mockResolvedValue({ Items: [existingEvent] });

      const event = createIntegrationEvent({
        artistId: 'artist-123',
        venueId: 'venue-456',
        date: '2025-06-15'
      });

      const result = await handler(event, {});
      const body = JSON.parse(result.body);

      expect(body).toHaveProperty('success', true);
      expect(body).toHaveProperty('event');
      expect(body).toHaveProperty('isNew', false);
      expect(body).toHaveProperty('matchMethod');
      expect(body.event).toHaveProperty('id');
      expect(body.event).toHaveProperty('artistId');
      expect(body.event).toHaveProperty('venueId');
      expect(body.event).toHaveProperty('date');
    });

    it('should return consistent response structure for new event', async () => {
      mockDynamoDB.query.mockResolvedValue({ Items: [] });
      mockDynamoDB.put.mockResolvedValue({});

      const event = createIntegrationEvent({
        artistId: 'artist-123',
        venueId: 'venue-456',
        date: '2025-06-15'
      });

      const result = await handler(event, {});
      const body = JSON.parse(result.body);

      expect(body).toHaveProperty('success', true);
      expect(body).toHaveProperty('event');
      expect(body).toHaveProperty('isNew', true);
      expect(body).toHaveProperty('matchMethod', 'new_event_created');
      expect(body.event).toHaveProperty('id');
      expect(body.event).toHaveProperty('artistId', 'artist-123');
      expect(body.event).toHaveProperty('venueId', 'venue-456');
      expect(body.event).toHaveProperty('date', '2025-06-15');
    });
  });
});
