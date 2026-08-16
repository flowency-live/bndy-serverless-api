/**
 * Geocode-based Venue Deduplication Tests (ADR-018)
 *
 * Ensures venues cannot be created without a Google place_id.
 * When caller sends only name+city, API must geocode → dedup on place_id.
 *
 * Root cause: handleFindOrCreateVenue L1/L2/L3 are gated on placeId/coords/address,
 * so a name+city-only caller skips all matching and L4 creates with google_place_id='', lat/lng=0.
 * Fix: Insert L3.5 to auto-geocode, then dedup on place_id or refuse placeless creation.
 */

const mockDynamoDB = {
  scan: jest.fn(),
  put: jest.fn(),
  update: jest.fn(),
  get: jest.fn(),
  transactWrite: jest.fn().mockResolvedValue({}),
  delete: jest.fn().mockResolvedValue({})
};

const mockPlacesClient = {
  findPlaceFromText: jest.fn(),
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      scan: (params) => ({ promise: () => mockDynamoDB.scan(params) }),
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      update: (params) => ({ promise: () => mockDynamoDB.update(params) }),
      get: (params) => ({ promise: () => mockDynamoDB.get(params) }),
      transactWrite: (params) => ({ promise: () => mockDynamoDB.transactWrite(params) }),
      delete: (params) => ({ promise: () => mockDynamoDB.delete(params) })
    })),
  },
  Lambda: jest.fn(() => ({
    invoke: () => ({ promise: () => Promise.resolve({ Payload: '{}' }) }),
  })),
  SSM: jest.fn(() => ({
    getParameter: () => ({
      promise: () => Promise.resolve({ Parameter: { Value: 'test-jwt-secret' } })
    })
  })),
}));

jest.mock('@googlemaps/google-maps-services-js', () => ({
  Client: jest.fn(() => mockPlacesClient),
  PlaceInputType: { textQuery: 'textquery' },
}));

process.env.MCP_SERVICE_TOKEN = 'test-service-token';
const { handler } = require('./handler');

describe('Geocode-based Venue Deduplication (ADR-018)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  });

  const createFindOrCreateRequest = (body) => ({
    requestContext: {
      http: { method: 'POST', path: '/api/venues/find-or-create' },
    },
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-service-token',
    },
    body: JSON.stringify(body),
  });

  describe('when caller sends only name+city (no googlePlaceId)', () => {
    it('should geocode via Google and match existing venue by place_id', async () => {
      const existingVenue = {
        id: 'venue-123',
        name: 'The Fountain Inn',
        google_place_id: 'ChIJ_fountain_inn',
        latitude: 53.1,
        longitude: -2.0,
        address: '14 Fountain St, Leek',
        external_ids: [],
      };
      mockDynamoDB.scan.mockResolvedValue({ Items: [existingVenue] });
      mockDynamoDB.update.mockResolvedValue({});

      mockPlacesClient.findPlaceFromText.mockResolvedValue({
        data: {
          status: 'OK',
          candidates: [
            {
              place_id: 'ChIJ_fountain_inn',
              name: 'The Fountain Inn',
              formatted_address: '14 Fountain St, Leek',
              geometry: { location: { lat: 53.1, lng: -2.0 } },
            },
          ],
        },
      });

      const event = createFindOrCreateRequest({
        name: 'Fountain Inn, Leek',
        city: 'Leek',
      });

      const result = await handler(event, {});
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(200);
      expect(body.id).toBe('venue-123');
      expect(body.matchMethod).toBe('google_place_id');
      expect(mockDynamoDB.put).not.toHaveBeenCalled();
    });

    it('should create venue with geocoded place_id when no match exists', async () => {
      mockDynamoDB.scan.mockResolvedValue({ Items: [] });
      mockDynamoDB.put.mockResolvedValue({});

      mockPlacesClient.findPlaceFromText.mockResolvedValue({
        data: {
          status: 'OK',
          candidates: [
            {
              place_id: 'ChIJ_new_venue',
              name: 'New Pub',
              formatted_address: '123 High St, Stoke',
              geometry: { location: { lat: 53.0, lng: -2.1 } },
            },
          ],
        },
      });

      const event = createFindOrCreateRequest({
        name: 'New Pub',
        city: 'Stoke',
      });

      const result = await handler(event, {});
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(201);
      expect(body.googlePlaceId).toBe('ChIJ_new_venue');
      expect(body.latitude).toBe(53.0);
      expect(body.longitude).toBe(-2.1);

      expect(mockDynamoDB.transactWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          TransactItems: expect.arrayContaining([
            expect.objectContaining({
              Put: expect.objectContaining({
                Item: expect.objectContaining({
                  google_place_id: 'ChIJ_new_venue',
                  latitude: 53.0,
                  longitude: -2.1,
                })
              })
            })
          ])
        })
      );
    });

    it('should return 422 needsReview when Google finds no match', async () => {
      mockDynamoDB.scan.mockResolvedValue({ Items: [] });

      mockPlacesClient.findPlaceFromText.mockResolvedValue({
        data: { status: 'ZERO_RESULTS', candidates: [] },
      });

      const event = createFindOrCreateRequest({
        name: 'Unknown Venue',
        city: 'Nowhere',
      });

      const result = await handler(event, {});
      const body = JSON.parse(result.body);

      expect(result.statusCode).toBe(422);
      expect(body.needsReview).toBe(true);
      expect(body.error).toContain('geocode');
      expect(mockDynamoDB.put).not.toHaveBeenCalled();
    });

    it('should NOT create venue with lat/lng=0 (the bug we are fixing)', async () => {
      mockDynamoDB.scan.mockResolvedValue({ Items: [] });

      mockPlacesClient.findPlaceFromText.mockResolvedValue({
        data: { status: 'ZERO_RESULTS', candidates: [] },
      });

      const event = createFindOrCreateRequest({
        name: 'Some Venue',
        city: 'Stoke',
      });

      await handler(event, {});

      const putCalls = mockDynamoDB.put.mock.calls;
      const venueCreatedWithZeroCoords = putCalls.some(
        (call) => call[0].Item && call[0].Item.latitude === 0 && call[0].Item.longitude === 0
      );
      expect(venueCreatedWithZeroCoords).toBe(false);
    });
  });

  describe('when caller provides googlePlaceId directly', () => {
    it('should match by place_id without calling Google (existing behavior)', async () => {
      const existingVenue = {
        id: 'venue-456',
        name: 'The Bankers Draught',
        google_place_id: 'ChIJ_bankers',
        latitude: 53.2,
        longitude: -2.2,
        external_ids: [],
      };
      mockDynamoDB.scan.mockResolvedValue({ Items: [existingVenue] });

      const event = createFindOrCreateRequest({
        name: "The Banker's Draught",
        googlePlaceId: 'ChIJ_bankers',
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      expect(mockPlacesClient.findPlaceFromText).not.toHaveBeenCalled();
    });
  });

  describe('when caller provides latitude/longitude', () => {
    it('should use L2 location+name match without calling Google', async () => {
      const existingVenue = {
        id: 'venue-789',
        name: 'Market Quarter',
        google_place_id: 'ChIJ_market',
        latitude: 53.15,
        longitude: -2.15,
        external_ids: [],
      };
      mockDynamoDB.scan.mockResolvedValue({ Items: [existingVenue] });

      const event = createFindOrCreateRequest({
        name: 'Market Quarter',
        latitude: 53.1500001,
        longitude: -2.1500001,
      });

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      expect(mockPlacesClient.findPlaceFromText).not.toHaveBeenCalled();
    });
  });
});
