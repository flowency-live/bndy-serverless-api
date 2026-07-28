/**
 * Calendar Cancellation Tracking Tests
 *
 * Tests for tracking deleted events for RFC 5545 METHOD:CANCEL support.
 * Cancellation records auto-expire after 7 days via DynamoDB TTL.
 */

const {
  createCancellationRecord,
  getCancellationsForArtist,
  generateEventUid
} = require('./calendar-cancellations');

// Mock DynamoDB
const mockDynamoDB = {
  put: jest.fn(),
  query: jest.fn()
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      query: (params) => ({ promise: () => mockDynamoDB.query(params) })
    }))
  }
}));

describe('calendar-cancellations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Mock Date.now for consistent TTL testing
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse('2025-06-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('generateEventUid', () => {
    it('should generate UID from event ID', () => {
      const uid = generateEventUid('event-123');
      expect(uid).toBe('event-123@bndy.co.uk');
    });
  });

  describe('createCancellationRecord', () => {
    it('should create a cancellation record with correct attributes', async () => {
      mockDynamoDB.put.mockResolvedValue({});

      const event = {
        id: 'gig-001',
        artistId: 'artist-123',
        title: 'Live at The Blue Note',
        date: '2025-06-20',
        type: 'gig'
      };
      const userId = 'user-456';

      await createCancellationRecord(event, userId);

      expect(mockDynamoDB.put).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'bndy-calendar-cancellations',
          Item: expect.objectContaining({
            eventUid: 'gig-001@bndy.co.uk',
            artistId: 'artist-123',
            eventId: 'gig-001',
            eventTitle: 'Live at The Blue Note',
            eventDate: '2025-06-20',
            canceledBy: 'user-456',
            canceledAt: expect.any(String)
          })
        })
      );
    });

    it('should set TTL to 7 days from now', async () => {
      mockDynamoDB.put.mockResolvedValue({});

      const event = {
        id: 'gig-002',
        artistId: 'artist-123',
        title: 'Test Gig',
        date: '2025-06-25',
        type: 'gig'
      };

      await createCancellationRecord(event, 'user-123');

      const putCall = mockDynamoDB.put.mock.calls[0][0];
      const ttl = putCall.Item.ttl;

      // TTL should be ~7 days from now (in epoch seconds)
      const now = Math.floor(Date.now() / 1000);
      const sevenDaysInSeconds = 7 * 24 * 60 * 60;
      const expectedTtl = now + sevenDaysInSeconds;

      expect(ttl).toBe(expectedTtl);
    });

    it('should handle events without title', async () => {
      mockDynamoDB.put.mockResolvedValue({});

      const event = {
        id: 'rehearsal-001',
        artistId: 'artist-123',
        date: '2025-06-20',
        type: 'practice'
      };

      await createCancellationRecord(event, 'user-123');

      const putCall = mockDynamoDB.put.mock.calls[0][0];
      expect(putCall.Item.eventTitle).toBe('Event');
    });

    it('should handle user unavailability events (ownerUserId instead of artistId)', async () => {
      mockDynamoDB.put.mockResolvedValue({});

      const event = {
        id: 'unavail-001',
        ownerUserId: 'user-789',
        title: 'Holiday',
        date: '2025-07-01',
        type: 'unavailable'
      };

      await createCancellationRecord(event, 'user-789');

      const putCall = mockDynamoDB.put.mock.calls[0][0];
      expect(putCall.Item.artistId).toBe('user-789'); // Falls back to ownerUserId
    });
  });

  describe('getCancellationsForArtist', () => {
    it('should return cancellation records for an artist', async () => {
      const cancellations = [
        {
          eventUid: 'gig-001@bndy.co.uk',
          artistId: 'artist-123',
          eventId: 'gig-001',
          eventTitle: 'Cancelled Gig 1',
          eventDate: '2025-06-20',
          canceledAt: '2025-06-15T10:00:00Z'
        },
        {
          eventUid: 'gig-002@bndy.co.uk',
          artistId: 'artist-123',
          eventId: 'gig-002',
          eventTitle: 'Cancelled Gig 2',
          eventDate: '2025-06-25',
          canceledAt: '2025-06-14T10:00:00Z'
        }
      ];

      mockDynamoDB.query.mockResolvedValue({ Items: cancellations });

      const result = await getCancellationsForArtist('artist-123');

      expect(result).toEqual(cancellations);
      expect(mockDynamoDB.query).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'bndy-calendar-cancellations',
          IndexName: 'artistId-index',
          KeyConditionExpression: 'artistId = :artistId',
          ExpressionAttributeValues: {
            ':artistId': 'artist-123'
          }
        })
      );
    });

    it('should return empty array when no cancellations exist', async () => {
      mockDynamoDB.query.mockResolvedValue({ Items: [] });

      const result = await getCancellationsForArtist('artist-456');

      expect(result).toEqual([]);
    });
  });

  describe('integration with event deletion', () => {
    it('should be callable with full event object from deletion handler', async () => {
      mockDynamoDB.put.mockResolvedValue({});

      // Simulate event structure from actual handler
      const deletedEvent = {
        id: 'abc123-def456',
        artistId: 'band-001',
        type: 'gig',
        title: 'Live Show',
        date: '2025-07-15',
        startTime: '20:00',
        endTime: '23:00',
        venueId: 'venue-001',
        location: 'The Jazz Club',
        isPublic: true,
        membershipId: 'membership-001',
        createdAt: '2025-01-01T10:00:00Z',
        updatedAt: '2025-06-10T15:00:00Z'
      };

      await createCancellationRecord(deletedEvent, 'user-who-deleted');

      expect(mockDynamoDB.put).toHaveBeenCalledTimes(1);
      const putCall = mockDynamoDB.put.mock.calls[0][0];

      // Should extract only the needed fields
      expect(putCall.Item.eventUid).toBe('abc123-def456@bndy.co.uk');
      expect(putCall.Item.artistId).toBe('band-001');
      expect(putCall.Item.eventTitle).toBe('Live Show');
      expect(putCall.Item.eventDate).toBe('2025-07-15');

      // Should NOT store unnecessary fields
      expect(putCall.Item.venueId).toBeUndefined();
      expect(putCall.Item.startTime).toBeUndefined();
      expect(putCall.Item.membershipId).toBeUndefined();
    });
  });
});
