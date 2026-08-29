/**
 * Availability Handler Tests - Free Fri/Sat/Sun Mode
 *
 * Tests for GET /api/artists/:artistId/public-availability with free_weekends mode:
 * - Generate all Fri/Sat/Sun dates in range
 * - Filter out dates with existing bookings (each day evaluated independently)
 * - Return free weekend days only
 */

const mockDynamoDB = {
  query: jest.fn(),
  get: jest.fn()
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      get: (params) => ({ promise: () => mockDynamoDB.get(params) })
    }))
  }
}));

const { handleGetArtistAvailability } = require('./availability');

const mockGetCorsHeaders = () => ({ 'Access-Control-Allow-Origin': '*' });

describe('GET /api/artists/:artistId/public-availability - Free Weekends Mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createEvent = (artistId, queryStringParameters = {}) => ({
    pathParameters: { artistId },
    queryStringParameters,
    headers: { origin: 'https://gigmap.bndy.co.uk' }
  });

  const deps = {
    dynamodb: new (require('aws-sdk')).DynamoDB.DocumentClient(),
    getCorsHeaders: mockGetCorsHeaders
  };

  describe('When artist has availabilityMode = "free_weekends"', () => {
    beforeEach(() => {
      // Mock artist with free_weekends mode enabled
      mockDynamoDB.get.mockResolvedValue({
        Item: {
          id: 'artist-1',
          name: 'Test Artist',
          publishAvailability: true,
          availabilityMode: 'free_weekends'
        }
      });
    });

    it('should return all Fri/Sat/Sun dates when no bookings exist', async () => {
      // Mock: no events found for any weekend day
      mockDynamoDB.query.mockResolvedValue({ Items: [] });

      const event = createEvent('artist-1', {
        startDate: '2026-08-01', // Saturday
        endDate: '2026-08-09'    // Sunday (includes Sat Aug 1, Sun Aug 2, Fri Aug 7, Sat Aug 8, Sun Aug 9)
      });

      const result = await handleGetArtistAvailability(deps, event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);

      // Should return 5 weekend days: Sat Aug 1, Sun Aug 2, Fri Aug 7, Sat Aug 8, Sun Aug 9
      expect(body.availability).toHaveLength(5);
      expect(body.availability).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ date: '2026-08-01' }), // Saturday
          expect.objectContaining({ date: '2026-08-02' }), // Sunday
          expect.objectContaining({ date: '2026-08-07' }), // Friday
          expect.objectContaining({ date: '2026-08-08' }), // Saturday
          expect.objectContaining({ date: '2026-08-09' })  // Sunday
        ])
      );
    });

    it('should exclude Saturday when booked, but include Friday and Sunday', async () => {
      mockDynamoDB.query.mockResolvedValue({
        Items: [{
          id: 'event-1',
          artistId: 'artist-1',
          date: '2026-08-08',
          type: 'public_gig',
          title: 'Booked Gig'
        }]
      });

      const event = createEvent('artist-1', {
        startDate: '2026-08-07', // Friday
        endDate: '2026-08-09'    // Sunday
      });

      const result = await handleGetArtistAvailability(deps, event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);

      // Should return only Fri and Sun (Sat excluded due to booking)
      expect(body.availability).toHaveLength(2);
      expect(body.availability).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ date: '2026-08-07' }), // Friday
          expect.objectContaining({ date: '2026-08-09' })  // Sunday
        ])
      );

      // Should NOT include Saturday
      expect(body.availability.some(a => a.date === '2026-08-08')).toBe(false);
      expect(mockDynamoDB.query).toHaveBeenCalledTimes(1);
    });

    it('should filter each day independently - multiple bookings scenario', async () => {
      mockDynamoDB.query.mockResolvedValue({
        Items: [
          { id: 'event-fri', artistId: 'artist-1', date: '2026-08-07', type: 'public_gig' },
          { id: 'event-sun', artistId: 'artist-1', date: '2026-08-09', type: 'public_gig' }
        ]
      });

      const event = createEvent('artist-1', {
        startDate: '2026-08-07',
        endDate: '2026-08-09'
      });

      const result = await handleGetArtistAvailability(deps, event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);

      // Should return only Saturday
      expect(body.availability).toHaveLength(1);
      expect(body.availability[0]).toMatchObject({ date: '2026-08-08' });
    });

    it('ignores saved availability and cancelled events when calculating busy dates', async () => {
      mockDynamoDB.query.mockResolvedValue({
        Items: [
          { id: 'saved', artistId: 'artist-1', date: '2026-08-07', type: 'available' },
          { id: 'cancelled', artistId: 'artist-1', date: '2026-08-08', type: 'public_gig', cancelled: true }
        ]
      });

      const result = await handleGetArtistAvailability(deps, createEvent('artist-1', {
        startDate: '2026-08-07',
        endDate: '2026-08-09'
      }));

      expect(JSON.parse(result.body).availability.map((item) => item.date)).toEqual([
        '2026-08-07', '2026-08-08', '2026-08-09'
      ]);
    });

    it('should not query for weekday dates (Mon-Thu)', async () => {
      mockDynamoDB.query.mockResolvedValue({ Items: [] });

      const event = createEvent('artist-1', {
        startDate: '2026-08-03', // Monday
        endDate: '2026-08-06'    // Thursday
      });

      const result = await handleGetArtistAvailability(deps, event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);

      // Should return empty array (no Fri/Sat/Sun in range)
      expect(body.availability).toEqual([]);

      // Should not make any event queries (no weekend days in range)
      expect(mockDynamoDB.query).toHaveBeenCalledTimes(0);

      // Should have called get once for artist lookup
      expect(mockDynamoDB.get).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'bndy-artists',
          Key: { id: 'artist-1' }
        })
      );
    });

    it('should respect publishAvailability flag', async () => {
      // Artist has publishAvailability = false
      mockDynamoDB.get.mockResolvedValue({
        Item: {
          id: 'artist-1',
          publishAvailability: false,
          availabilityMode: 'free_weekends'
        }
      });

      const event = createEvent('artist-1', {
        startDate: '2026-08-07',
        endDate: '2026-08-09'
      });

      const result = await handleGetArtistAvailability(deps, event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);

      // Should return empty array when publishAvailability is false
      expect(body.availability).toEqual([]);
    });
  });

  describe('When artist has availabilityMode = "selected_dates_only"', () => {
    it('should query only for type="available" events (existing behavior)', async () => {
      // Mock artist with selected_dates_only mode
      mockDynamoDB.get.mockResolvedValue({
        Item: {
          id: 'artist-1',
          publishAvailability: true,
          availabilityMode: 'selected_dates_only'
        }
      });

      // Mock availability events
      mockDynamoDB.query.mockResolvedValue({
        Items: [
          {
            id: 'avail-1',
            artistId: 'artist-1',
            date: '2026-08-10',
            type: 'available',
            notes: 'Available for booking'
          }
        ]
      });

      const event = createEvent('artist-1', {
        startDate: '2026-08-01',
        endDate: '2026-08-31'
      });

      const result = await handleGetArtistAvailability(deps, event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);

      // Should return the manually marked available dates
      expect(body.availability).toHaveLength(1);
      expect(body.availability[0]).toMatchObject({
        id: 'avail-1',
        date: '2026-08-10',
        type: 'available'
      });

      // Should have queried with FilterExpression for type="available"
      expect(mockDynamoDB.query).toHaveBeenCalledWith(
        expect.objectContaining({
          FilterExpression: expect.stringContaining('available')
        })
      );
    });
  });
});
