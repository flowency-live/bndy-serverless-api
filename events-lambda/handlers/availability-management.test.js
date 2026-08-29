const mockDynamoDB = {
  query: jest.fn(),
  get: jest.fn(),
  put: jest.fn(),
  delete: jest.fn()
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      get: (params) => ({ promise: () => mockDynamoDB.get(params) }),
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      delete: (params) => ({ promise: () => mockDynamoDB.delete(params) })
    }))
  }
}));

const {
  handleGetManagedArtistAvailability,
  handleToggleAvailability,
  normaliseRange
} = require('./availability');

const deps = {
  dynamodb: new (require('aws-sdk')).DynamoDB.DocumentClient(),
  getCorsHeaders: () => ({})
};

describe('managed artist availability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB.query.mockResolvedValue({ Items: [] });
  });

  test('returns saved and busy dates while public publishing is irrelevant', async () => {
    mockDynamoDB.query.mockImplementation(async (params) => {
      if (params.IndexName === 'artist_id-index' || params.IndexName === 'user_id-index') {
        return { Items: [{ artist_id: 'artist-1', user_id: 'user-1', role: 'owner', status: 'active' }] };
      }
      if (params.IndexName === 'artistId-date-index' && params.KeyConditionExpression.includes('BETWEEN')) {
        return { Items: [
          { id: 'available-1', artistId: 'artist-1', date: '2026-09-05', type: 'available' },
          { id: 'gig-1', artistId: 'artist-1', date: '2026-09-06', type: 'public_gig', isPublic: true },
          { id: 'gig-2', artistId: 'artist-1', date: '2026-09-07', type: 'public_gig', cancelled: true }
        ] };
      }
      return { Items: [] };
    });

    const result = await handleGetManagedArtistAvailability(deps, {
      pathParameters: { artistId: 'artist-1' },
      queryStringParameters: { startDate: '2026-09-01', endDate: '2026-09-30' }
    }, { userId: 'user-1', platformAdmin: false });

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      availability: [expect.objectContaining({ id: 'available-1', date: '2026-09-05' })],
      busyDates: ['2026-09-06'],
      dateStatuses: [{ date: '2026-09-06', state: 'public_gig', eventId: 'gig-1' }]
    });
  });

  test('rejects an inactive membership', async () => {
    mockDynamoDB.query.mockResolvedValueOnce({
      Items: [{ artist_id: 'artist-1', user_id: 'user-1', role: 'owner', status: 'revoked' }]
    });

    const result = await handleGetManagedArtistAvailability(deps, {
      pathParameters: { artistId: 'artist-1' },
      queryStringParameters: { startDate: '2026-09-01', endDate: '2026-09-30' }
    }, { userId: 'user-1', platformAdmin: false });

    expect(result.statusCode).toBe(403);
  });

  test.each(['staff', 'curator'])('allows an unrestricted %s without artist membership', async (role) => {
    mockDynamoDB.query.mockResolvedValueOnce({ Items: [
      { id: 'available-1', artistId: 'artist-1', date: '2026-09-05', type: 'available' }
    ] });

    const result = await handleGetManagedArtistAvailability(deps, {
      pathParameters: { artistId: 'artist-1' },
      queryStringParameters: { startDate: '2026-09-01', endDate: '2026-09-30' }
    }, { userId: 'user-1', platformAdmin: false, role, curatorAccess: null });

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).availability).toHaveLength(1);
    expect(mockDynamoDB.query).toHaveBeenCalledTimes(3);
  });

  test('keeps a restricted curator inside the existing artist policy', async () => {
    mockDynamoDB.get.mockResolvedValueOnce({ Item: { id: 'artist-1', createdBy: 'someone-else' } });
    mockDynamoDB.query.mockResolvedValueOnce({ Items: [] });

    const result = await handleGetManagedArtistAvailability(deps, {
      pathParameters: { artistId: 'artist-1' },
      queryStringParameters: { startDate: '2026-09-01', endDate: '2026-09-30' }
    }, {
      userId: 'user-1',
      platformAdmin: false,
      role: 'curator',
      curatorAccess: { scope: 'postcode', postcode_prefixes: ['ST'] }
    });

    expect(result.statusCode).toBe(403);
  });

  test('does not create availability over an existing gig', async () => {
    mockDynamoDB.query
      .mockResolvedValueOnce({ Items: [{ artist_id: 'artist-1', user_id: 'user-1', role: 'admin', status: 'active' }] })
      .mockResolvedValueOnce({ Items: [{ id: 'gig-1', date: '2026-09-05', type: 'public_gig' }] });

    const result = await handleToggleAvailability(deps, {
      pathParameters: { artistId: 'artist-1' },
      body: JSON.stringify({ date: '2026-09-05' })
    }, { userId: 'user-1', platformAdmin: false });

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).code).toBe('DATE_BUSY');
    expect(mockDynamoDB.put).not.toHaveBeenCalled();
  });

  test('does not create availability when an active artist member is unavailable', async () => {
    mockDynamoDB.query.mockImplementation(async (params) => {
      if (params.IndexName === 'user_id-index' || params.IndexName === 'artist_id-index') {
        return { Items: [{ artist_id: 'artist-1', user_id: 'user-1', role: 'admin', status: 'active' }] };
      }
      if (params.IndexName === 'ownerUserId-date-index' && params.KeyConditionExpression.includes('BETWEEN')) {
        return { Items: [{ id: 'unavailable-1', ownerUserId: 'user-1', date: '2026-09-05', type: 'unavailable' }] };
      }
      return { Items: [] };
    });

    const result = await handleToggleAvailability(deps, {
      pathParameters: { artistId: 'artist-1' },
      body: JSON.stringify({ date: '2026-09-05' })
    }, { userId: 'user-1', platformAdmin: false });

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body)).toMatchObject({ code: 'DATE_BUSY' });
    expect(mockDynamoDB.put).not.toHaveBeenCalled();
  });

  test('rejects impossible dates and overlong ranges', () => {
    expect(normaliseRange('2026-02-30', '2026-03-02')).toEqual(expect.objectContaining({ error: expect.any(String) }));
    expect(normaliseRange('2026-01-01', '2027-02-01')).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });
});
