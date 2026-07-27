/**
 * Venues Integration API Tests
 *
 * Tests for the /api/integration/venues endpoint:
 * - API key authentication
 * - BNDY-first lookup (avoids Google Places API costs)
 * - Google Places fallback only when no BNDY match
 * - Find-or-create semantics
 */

const mockDynamoDB = {
  query: jest.fn(),
  put: jest.fn(),
  scan: jest.fn(),
  get: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  transactWrite: jest.fn().mockResolvedValue({})
};

const mockPlacesClient = {
  findPlaceFromText: jest.fn()
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      scan: (params) => ({ promise: () => mockDynamoDB.scan(params) }),
      get: (params) => ({ promise: () => mockDynamoDB.get(params) }),
      update: (params) => ({ promise: () => mockDynamoDB.update(params) }),
      delete: (params) => ({ promise: () => mockDynamoDB.delete(params) }),
      transactWrite: (params) => ({ promise: () => mockDynamoDB.transactWrite(params) })
    }))
  },
  Lambda: jest.fn(() => ({
    invoke: () => ({
      promise: () => Promise.resolve({ Payload: '{}' })
    })
  }))
}));

jest.mock('@googlemaps/google-maps-services-js', () => ({
  Client: jest.fn(() => mockPlacesClient),
  PlaceInputType: { textQuery: 'textQuery' }
}));

// Set environment variables before requiring handler
process.env.INTEGRATION_API_KEYS = 'test-api-key-123,another-valid-key';
process.env.GOOGLE_PLACES_API_KEY = 'test-google-key';

const { handler } = require('./handler');

describe('Venues Integration API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createIntegrationEvent = (body, apiKey = 'test-api-key-123') => ({
    requestContext: {
      http: {
        method: 'POST',
        path: '/api/integration/venues'
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
      const event = createIntegrationEvent({ name: 'The Fleece', city: 'Bristol' }, null);
      delete event.headers['x-api-key'];

      const result = await handler(event, {});

      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body)).toEqual({
        error: 'Invalid or missing API key'
      });
    });

    it('should reject requests with invalid API key', async () => {
      const event = createIntegrationEvent({ name: 'The Fleece', city: 'Bristol' }, 'invalid-key');

      const result = await handler(event, {});

      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body)).toEqual({
        error: 'Invalid or missing API key'
      });
    });
  });

  describe('Input Validation', () => {
    it('should reject requests without name', async () => {
      const event = createIntegrationEvent({ city: 'Bristol' });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('name');
    });

    it('should reject requests without city', async () => {
      const event = createIntegrationEvent({ name: 'The Fleece' });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error).toContain('city');
    });
  });

  describe('BNDY-First Lookup (Cost Optimization)', () => {
    it('should return existing venue WITHOUT calling Google Places when BNDY match found', async () => {
      const existingVenue = {
        id: 'existing-venue-123',
        name: 'The Fleece',
        address: '12 St Thomas St, Bristol BS1 6JJ',
        city: 'Bristol',
        latitude: 51.4545,
        longitude: -2.5879,
        google_place_id: 'ChIJexisting123',
        validated: true
      };

      // Mock BNDY database returns existing venue
      mockDynamoDB.scan.mockResolvedValue({
        Items: [existingVenue]
      });

      const event = createIntegrationEvent({
        name: 'The Fleece',
        city: 'Bristol'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.isNew).toBe(false);
      expect(body.venue.id).toBe('existing-venue-123');
      expect(body.matchMethod).toBe('bndy_name_city_match');

      // CRITICAL: Google Places should NOT have been called
      expect(mockPlacesClient.findPlaceFromText).not.toHaveBeenCalled();
    });

    it('should match venue with fuzzy name similarity >= 80%', async () => {
      const existingVenue = {
        id: 'existing-venue-456',
        name: 'The Fleece', // Exact name in DB
        address: '12 St Thomas St, Bristol BS1 6JJ',
        city: 'Bristol',
        latitude: 51.4545,
        longitude: -2.5879,
        google_place_id: 'ChIJexisting456'
      };

      mockDynamoDB.scan.mockResolvedValue({
        Items: [existingVenue]
      });

      const event = createIntegrationEvent({
        name: 'The Flece', // Typo - one letter missing = ~90% similarity
        city: 'Bristol'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.isNew).toBe(false);
      expect(body.venue.id).toBe('existing-venue-456');

      // Google Places should NOT have been called
      expect(mockPlacesClient.findPlaceFromText).not.toHaveBeenCalled();
    });

    it('should filter BNDY matches by city', async () => {
      const bristolVenue = {
        id: 'bristol-venue',
        name: 'The Fleece',
        city: 'Bristol',
        latitude: 51.4545,
        longitude: -2.5879
      };

      const londonVenue = {
        id: 'london-venue',
        name: 'The Fleece', // Same name, different city
        city: 'London',
        latitude: 51.5074,
        longitude: -0.1278
      };

      mockDynamoDB.scan.mockResolvedValue({
        Items: [bristolVenue, londonVenue]
      });

      const event = createIntegrationEvent({
        name: 'The Fleece',
        city: 'Bristol'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.venue.id).toBe('bristol-venue'); // Should match Bristol, not London

      expect(mockPlacesClient.findPlaceFromText).not.toHaveBeenCalled();
    });
  });

  describe('Google Places Fallback', () => {
    it('should call Google Places only when no BNDY match found', async () => {
      // No existing venues in BNDY
      mockDynamoDB.scan.mockResolvedValue({ Items: [] });
      mockDynamoDB.put.mockResolvedValue({});

      // Mock Google Places response
      mockPlacesClient.findPlaceFromText.mockResolvedValue({
        data: {
          status: 'OK',
          candidates: [{
            place_id: 'ChIJnew123',
            name: 'The New Venue',
            formatted_address: '123 New Street, Bristol BS1 1AA',
            geometry: {
              location: { lat: 51.4500, lng: -2.5900 }
            }
          }]
        }
      });

      const event = createIntegrationEvent({
        name: 'The New Venue',
        city: 'Bristol'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.isNew).toBe(true);
      expect(body.matchMethod).toBe('new_venue_created');

      // Google Places SHOULD have been called since no BNDY match
      expect(mockPlacesClient.findPlaceFromText).toHaveBeenCalledTimes(1);
    });

    it('should return 404 when venue not found in BNDY or Google Places', async () => {
      // No BNDY matches
      mockDynamoDB.scan.mockResolvedValue({ Items: [] });

      // Google Places returns no results
      mockPlacesClient.findPlaceFromText.mockResolvedValue({
        data: {
          status: 'ZERO_RESULTS',
          candidates: []
        }
      });

      const event = createIntegrationEvent({
        name: 'Nonexistent Venue',
        city: 'Nowhere'
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('not found');
    });
  });

  describe('Response Format', () => {
    it('should return consistent response structure for BNDY match', async () => {
      const existingVenue = {
        id: 'existing-123',
        name: 'Test Venue',
        address: '123 Test St',
        city: 'Bristol',
        latitude: 51.45,
        longitude: -2.59,
        google_place_id: 'ChIJtest123'
      };

      mockDynamoDB.scan.mockResolvedValue({ Items: [existingVenue] });

      const event = createIntegrationEvent({
        name: 'Test Venue',
        city: 'Bristol'
      });

      const result = await handler(event, {});
      const body = JSON.parse(result.body);

      expect(body).toHaveProperty('success', true);
      expect(body).toHaveProperty('venue');
      expect(body).toHaveProperty('isNew', false);
      expect(body).toHaveProperty('matchMethod');
      expect(body.venue).toHaveProperty('id');
      expect(body.venue).toHaveProperty('name');
    });
  });
});
