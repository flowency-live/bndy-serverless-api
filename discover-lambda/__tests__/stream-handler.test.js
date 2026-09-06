/**
 * Tests for the DynamoDB stream handler
 *
 * The stream handler processes events from bndy-events stream and updates
 * gigging projection fields on bndy-artists.
 */

const { processStreamBatch, dedupeArtistIds } = require('../lib/stream-handler');

describe('dedupeArtistIds', () => {
  test('deduplicates artist IDs across multiple stream records', () => {
    const records = [
      {
        eventName: 'INSERT',
        dynamodb: {
          NewImage: {
            artistId: { S: 'artist-1' },
            collaboratingArtistIds: { L: [{ S: 'artist-2' }] },
          },
        },
      },
      {
        eventName: 'MODIFY',
        dynamodb: {
          NewImage: {
            artistId: { S: 'artist-1' },
            collaboratingArtistIds: { L: [{ S: 'artist-3' }] },
          },
        },
      },
      {
        eventName: 'INSERT',
        dynamodb: {
          NewImage: {
            artistId: { S: 'artist-2' },
          },
        },
      },
    ];

    const artistIds = dedupeArtistIds(records);

    expect(artistIds.sort()).toEqual(['artist-1', 'artist-2', 'artist-3']);
  });

  test('handles REMOVE events using OldImage', () => {
    const records = [
      {
        eventName: 'REMOVE',
        dynamodb: {
          OldImage: {
            artistId: { S: 'artist-1' },
          },
        },
      },
    ];

    const artistIds = dedupeArtistIds(records);

    expect(artistIds).toEqual(['artist-1']);
  });

  test('handles legacy artistIds field', () => {
    const records = [
      {
        eventName: 'INSERT',
        dynamodb: {
          NewImage: {
            artistIds: { L: [{ S: 'artist-1' }, { S: 'artist-2' }] },
          },
        },
      },
    ];

    const artistIds = dedupeArtistIds(records);

    expect(artistIds.sort()).toEqual(['artist-1', 'artist-2']);
  });

  test('returns empty array when no artist IDs present', () => {
    const records = [
      {
        eventName: 'INSERT',
        dynamodb: {
          NewImage: {
            venueId: { S: 'venue-1' },
          },
        },
      },
    ];

    const artistIds = dedupeArtistIds(records);

    expect(artistIds).toEqual([]);
  });

  test('skips records with no image data', () => {
    const records = [
      {
        eventName: 'INSERT',
        dynamodb: {},
      },
      {
        eventName: 'INSERT',
        dynamodb: {
          NewImage: {
            artistId: { S: 'artist-1' },
          },
        },
      },
    ];

    const artistIds = dedupeArtistIds(records);

    expect(artistIds).toEqual(['artist-1']);
  });
});

describe('processStreamBatch', () => {
  // AWS SDK v2 pattern: methods return { promise: () => Promise }
  const mockPromise = (value) => ({ promise: () => Promise.resolve(value) });

  const mockDynamoDB = {
    query: jest.fn(),
    update: jest.fn(),
    get: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB.query.mockReturnValue(mockPromise({ Items: [] }));
    mockDynamoDB.update.mockReturnValue(mockPromise({}));
    mockDynamoDB.get.mockReturnValue(mockPromise({ Item: {} }));
  });

  test('queries events for each unique artist', async () => {
    const records = [
      {
        eventName: 'INSERT',
        dynamodb: {
          NewImage: {
            artistId: { S: 'artist-1' },
          },
        },
      },
      {
        eventName: 'INSERT',
        dynamodb: {
          NewImage: {
            artistId: { S: 'artist-2' },
          },
        },
      },
    ];

    await processStreamBatch(records, mockDynamoDB, '2026-08-31');

    expect(mockDynamoDB.query).toHaveBeenCalledTimes(2);
  });

  test('skips write when projection unchanged', async () => {
    mockDynamoDB.get.mockReturnValue(mockPromise({
      Item: { giggingStatus: null, giggingUntil: null },
    }));
    mockDynamoDB.query.mockReturnValue(mockPromise({ Items: [] }));

    const records = [
      {
        eventName: 'REMOVE',
        dynamodb: {
          OldImage: {
            artistId: { S: 'artist-1' },
          },
        },
      },
    ];

    await processStreamBatch(records, mockDynamoDB, '2026-08-31');

    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });

  test('updates artist when projection changes', async () => {
    mockDynamoDB.get.mockReturnValue(mockPromise({
      Item: { giggingStatus: null, giggingUntil: null },
    }));
    mockDynamoDB.query.mockReturnValue(mockPromise({
      Items: [{ id: 'event-1', date: '2026-12-25', hidden: false, visibility: 'public' }],
    }));

    const records = [
      {
        eventName: 'INSERT',
        dynamodb: {
          NewImage: {
            artistId: { S: 'artist-1' },
          },
        },
      },
    ];

    await processStreamBatch(records, mockDynamoDB, '2026-08-31');

    expect(mockDynamoDB.update).toHaveBeenCalledTimes(1);
    expect(mockDynamoDB.update).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'bndy-artists',
        Key: { id: 'artist-1' },
      })
    );
  });

  test('removes giggingStatus and giggingUntil when no future events', async () => {
    mockDynamoDB.get.mockReturnValue(mockPromise({
      Item: { giggingStatus: 'Y', giggingUntil: '2026-08-30' },
    }));
    mockDynamoDB.query.mockReturnValue(mockPromise({ Items: [] }));

    const records = [
      {
        eventName: 'REMOVE',
        dynamodb: {
          OldImage: {
            artistId: { S: 'artist-1' },
          },
        },
      },
    ];

    await processStreamBatch(records, mockDynamoDB, '2026-08-31');

    expect(mockDynamoDB.update).toHaveBeenCalledWith(
      expect.objectContaining({
        UpdateExpression: expect.stringContaining('REMOVE'),
      })
    );
  });

  test('handles empty batch gracefully', async () => {
    const records = [];

    await processStreamBatch(records, mockDynamoDB, '2026-08-31');

    expect(mockDynamoDB.query).not.toHaveBeenCalled();
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });

  test('uses stream record event data when GSI returns empty due to eventual consistency', async () => {
    // Simulate GSI eventual consistency lag: query returns empty even though event was just written
    mockDynamoDB.query.mockReturnValue(mockPromise({ Items: [] }));
    mockDynamoDB.get.mockReturnValue(mockPromise({ Item: {} }));

    const records = [
      {
        eventName: 'INSERT',
        dynamodb: {
          NewImage: {
            id: { S: 'event-123' },
            artistId: { S: 'artist-1' },
            date: { S: '2026-12-25' },
            isPublic: { BOOL: true },
            // hidden and visibility not present - defaults apply
          },
        },
      },
    ];

    await processStreamBatch(records, mockDynamoDB, '2026-08-31');

    // Should still update artist because stream record event is merged
    expect(mockDynamoDB.update).toHaveBeenCalledTimes(1);
    expect(mockDynamoDB.update).toHaveBeenCalledWith(
      expect.objectContaining({
        TableName: 'bndy-artists',
        Key: { id: 'artist-1' },
        UpdateExpression: expect.stringContaining('SET'),
      })
    );
  });

  test('deduplicates stream record event with GSI results', async () => {
    // GSI returns the same event that's in the stream record (normal case when GSI is consistent)
    mockDynamoDB.query.mockReturnValue(mockPromise({
      Items: [{ id: 'event-123', date: '2026-12-25', hidden: false, visibility: 'public' }],
    }));
    mockDynamoDB.get.mockReturnValue(mockPromise({ Item: {} }));

    const records = [
      {
        eventName: 'INSERT',
        dynamodb: {
          NewImage: {
            id: { S: 'event-123' },
            artistId: { S: 'artist-1' },
            date: { S: '2026-12-25' },
            isPublic: { BOOL: true },
          },
        },
      },
    ];

    await processStreamBatch(records, mockDynamoDB, '2026-08-31');

    // Should update with giggingUntil = '2026-12-25' (not duplicated)
    expect(mockDynamoDB.update).toHaveBeenCalledTimes(1);
  });

  test('excludes REMOVE event from merged results', async () => {
    // GSI still returns the deleted event (eventual consistency lag)
    // Note: GSI now includes id in projection for proper merge handling
    mockDynamoDB.query.mockReturnValue(mockPromise({
      Items: [{ id: 'event-123', date: '2026-12-25', hidden: false, visibility: 'public' }],
    }));
    mockDynamoDB.get.mockReturnValue(mockPromise({
      Item: { giggingStatus: 'Y', giggingUntil: '2026-12-25' },
    }));

    const records = [
      {
        eventName: 'REMOVE',
        dynamodb: {
          OldImage: {
            id: { S: 'event-123' },
            artistId: { S: 'artist-1' },
            date: { S: '2026-12-25' },
          },
        },
      },
    ];

    await processStreamBatch(records, mockDynamoDB, '2026-08-31');

    // Should clear gigging status because the event was removed
    expect(mockDynamoDB.update).toHaveBeenCalledWith(
      expect.objectContaining({
        UpdateExpression: expect.stringContaining('REMOVE'),
      })
    );
  });
});
