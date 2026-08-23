/**
 * Artists Handler Tests - GET /api/artists Performance
 *
 * Tests for the public artists list endpoint:
 * - No N+1 queries (only scan, no event count queries)
 * - Cache-Control header for CDN/browser caching
 * - Response format (no unused eventCount field)
 */

// Set JWT_SECRET before requiring handler
process.env.JWT_SECRET = 'test-jwt-secret';

const mockDynamoDB = {
  query: jest.fn(),
  put: jest.fn(),
  scan: jest.fn(),
  get: jest.fn(),
  update: jest.fn(),
  transactWrite: jest.fn()
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      scan: (params) => ({ promise: () => mockDynamoDB.scan(params) }),
      get: (params) => ({ promise: () => mockDynamoDB.get(params) }),
      update: (params) => ({ promise: () => mockDynamoDB.update(params) }),
      transactWrite: (params) => ({ promise: () => mockDynamoDB.transactWrite(params) })
    }))
  },
  SSM: jest.fn(() => ({
    getParameter: () => ({
      promise: () => Promise.resolve({ Parameter: { Value: 'test-jwt-secret' } })
    })
  })),
  S3: jest.fn(() => ({
    upload: () => ({ promise: () => Promise.resolve({ Location: 'https://s3.example.com/test.jpg' }) })
  }))
}));

const { handler } = require('./handler');

describe('GET /api/artists - Performance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createGetArtistsEvent = () => ({
    requestContext: {
      http: {
        method: 'GET',
        path: '/api/artists'
      }
    },
    headers: {
      origin: 'https://live.bndy.co.uk'
    }
  });

  const mockArtists = [
    {
      id: 'artist-1',
      name: 'Test Artist 1',
      location: 'Bristol',
      genres: ['rock'],
      profileImageUrl: 'https://example.com/img1.jpg'
    },
    {
      id: 'artist-2',
      name: 'Test Artist 2',
      location: 'Manchester',
      genres: ['jazz'],
      profileImageUrl: 'https://example.com/img2.jpg'
    }
  ];

  describe('No N+1 Queries', () => {
    it('should only call scan once, not query events table for each artist', async () => {
      mockDynamoDB.scan.mockResolvedValue({ Items: mockArtists });

      const event = createGetArtistsEvent();
      await handler(event, {});

      // Should call scan exactly once
      expect(mockDynamoDB.scan).toHaveBeenCalledTimes(1);
      expect(mockDynamoDB.scan).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'bndy-artists'
        })
      );

      // Should NOT call query at all (no event count lookups)
      expect(mockDynamoDB.query).not.toHaveBeenCalled();
    });
  });

  describe('Cache Headers', () => {
    it('should include Cache-Control header for CDN caching', async () => {
      mockDynamoDB.scan.mockResolvedValue({ Items: mockArtists });

      const event = createGetArtistsEvent();
      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      expect(result.headers).toHaveProperty('Cache-Control');
      expect(result.headers['Cache-Control']).toMatch(/max-age=\d+/);
    });
  });

  describe('Response Format', () => {
    it('should return artists without eventCount field', async () => {
      mockDynamoDB.scan.mockResolvedValue({ Items: mockArtists });

      const event = createGetArtistsEvent();
      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      const artists = JSON.parse(result.body);

      expect(artists).toHaveLength(2);
      artists.forEach(artist => {
        expect(artist).not.toHaveProperty('eventCount');
        expect(artist).toHaveProperty('id');
        expect(artist).toHaveProperty('name');
      });
    });

    it('should return 200 with empty array when no artists exist', async () => {
      mockDynamoDB.scan.mockResolvedValue({ Items: [] });

      const event = createGetArtistsEvent();
      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      const artists = JSON.parse(result.body);
      expect(artists).toEqual([]);
    });
  });
});

/**
 * Acts CRUD Tests - #60 Acts Model
 *
 * Tests for artist acts management:
 * - GET /api/artists/:id returns actsEnabled and acts[]
 * - PUT /api/artists/:id can toggle actsEnabled
 * - POST /api/artists/:id/acts creates an act
 * - PUT /api/artists/:id/acts/:actId updates an act
 * - DELETE /api/artists/:id/acts/:actId deletes an act
 * - DELETE blocked if events reference the act
 * - PUT /api/artists/:id/acts/:actId/default sets default act
 */
describe('Acts CRUD - #60 Acts Model', () => {
  // Store mock artist data per test
  let mockArtistData = {};

  const mockArtistWithActs = {
    id: 'artist-1',
    name: 'Vanz Roxx',
    location: 'Bristol',
    genres: ['rock'],
    actsEnabled: true,
    acts: [
      { id: 'act-1', name: 'Acoustic Duo', description: 'Stripped back performance', isDefault: true },
      { id: 'act-2', name: 'Full Band', description: 'The full 5-piece experience', isDefault: false }
    ]
  };

  const mockArtistNoActs = {
    id: 'artist-2',
    name: 'Solo Singer',
    location: 'Manchester',
    genres: ['pop'],
    actsEnabled: false,
    acts: []
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockArtistData = {};

    // Universal mock that handles both users and artists tables
    mockDynamoDB.get.mockImplementation((params) => {
      if (params.TableName === 'bndy-users') {
        return Promise.resolve({
          Item: { cognito_id: 'admin-1', platformAdmin: true }
        });
      }
      if (params.TableName === 'bndy-artists' && mockArtistData[params.Key.id]) {
        return Promise.resolve({ Item: mockArtistData[params.Key.id] });
      }
      return Promise.resolve({ Item: null });
    });
  });

  // Helper: create session cookie for platform admin
  const createAdminSessionCookie = () => {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { userId: 'admin-1' },
      'test-jwt-secret',
      { expiresIn: '1h' }
    );
    return `bndy_session=${token}`;
  };

  // Helper: set mock artist data for a test
  const setMockArtist = (artist) => {
    mockArtistData[artist.id] = artist;
  };

  describe('GET /api/artists/:id - returns actsEnabled and acts[]', () => {
    it('should return artist with actsEnabled and acts array', async () => {
      setMockArtist(mockArtistWithActs);

      const event = {
        requestContext: { http: { method: 'GET', path: '/api/artists/artist-1' } },
        pathParameters: { id: 'artist-1' },
        headers: { origin: 'https://backstage.bndy.co.uk' }
      };

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      const artist = JSON.parse(result.body);
      expect(artist.actsEnabled).toBe(true);
      expect(artist.acts).toHaveLength(2);
      expect(artist.acts[0]).toMatchObject({ id: 'act-1', name: 'Acoustic Duo', isDefault: true });
    });

    it('should return empty acts array for artist without acts', async () => {
      setMockArtist(mockArtistNoActs);

      const event = {
        requestContext: { http: { method: 'GET', path: '/api/artists/artist-2' } },
        pathParameters: { id: 'artist-2' },
        headers: { origin: 'https://backstage.bndy.co.uk' }
      };

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      const artist = JSON.parse(result.body);
      expect(artist.actsEnabled).toBe(false);
      expect(artist.acts).toEqual([]);
    });
  });

  describe('PUT /api/artists/:id - toggle actsEnabled', () => {
    it('should allow platform admin to enable acts', async () => {
      setMockArtist(mockArtistNoActs);
      mockDynamoDB.query.mockResolvedValue({ Items: [] }); // No membership needed - admin
      mockDynamoDB.update.mockResolvedValue({ Attributes: { ...mockArtistNoActs, actsEnabled: true } });

      const event = {
        requestContext: { http: { method: 'PUT', path: '/api/artists/artist-2' } },
        pathParameters: { id: 'artist-2' },
        headers: {
          origin: 'https://backstage.bndy.co.uk',
          Cookie: createAdminSessionCookie()
        },
        body: JSON.stringify({ actsEnabled: true })
      };

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      expect(mockDynamoDB.update).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: 'bndy-artists',
          Key: { id: 'artist-2' },
          UpdateExpression: expect.stringContaining('actsEnabled')
        })
      );
    });
  });

  describe('POST /api/artists/:id/acts - create act', () => {
    it('should create a new act for an artist', async () => {
      setMockArtist({ ...mockArtistNoActs, actsEnabled: true, acts: [] });
      mockDynamoDB.update.mockResolvedValue({
        Attributes: {
          ...mockArtistNoActs,
          actsEnabled: true,
          acts: [{ id: 'new-act-id', name: 'DJ Set', description: null, isDefault: true }]
        }
      });

      const event = {
        requestContext: { http: { method: 'POST', path: '/api/artists/artist-2/acts' } },
        pathParameters: { id: 'artist-2' },
        headers: {
          origin: 'https://backstage.bndy.co.uk',
          Cookie: createAdminSessionCookie()
        },
        body: JSON.stringify({ name: 'DJ Set' })
      };

      const result = await handler(event, {});

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.act).toMatchObject({ name: 'DJ Set' });
      expect(body.act.id).toBeDefined();
    });

    it('should return 400 if act name is missing', async () => {
      const event = {
        requestContext: { http: { method: 'POST', path: '/api/artists/artist-2/acts' } },
        pathParameters: { id: 'artist-2' },
        headers: {
          origin: 'https://backstage.bndy.co.uk',
          Cookie: createAdminSessionCookie()
        },
        body: JSON.stringify({})
      };

      const result = await handler(event, {});

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('name');
    });

    it('should return 401 without auth', async () => {
      const event = {
        requestContext: { http: { method: 'POST', path: '/api/artists/artist-2/acts' } },
        pathParameters: { id: 'artist-2' },
        headers: { origin: 'https://backstage.bndy.co.uk' },
        body: JSON.stringify({ name: 'DJ Set' })
      };

      const result = await handler(event, {});

      expect(result.statusCode).toBe(401);
    });
  });

  describe('PUT /api/artists/:id/acts/:actId - update act', () => {
    it('should update an existing act', async () => {
      setMockArtist(mockArtistWithActs);
      mockDynamoDB.update.mockResolvedValue({
        Attributes: {
          ...mockArtistWithActs,
          acts: [
            { id: 'act-1', name: 'Acoustic Duo Updated', description: 'New description', isDefault: true },
            mockArtistWithActs.acts[1]
          ]
        }
      });

      const event = {
        requestContext: { http: { method: 'PUT', path: '/api/artists/artist-1/acts/act-1' } },
        pathParameters: { id: 'artist-1', actId: 'act-1' },
        headers: {
          origin: 'https://backstage.bndy.co.uk',
          Cookie: createAdminSessionCookie()
        },
        body: JSON.stringify({ name: 'Acoustic Duo Updated', description: 'New description' })
      };

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.act.name).toBe('Acoustic Duo Updated');
    });

    it('should return 404 if act not found', async () => {
      setMockArtist(mockArtistWithActs);

      const event = {
        requestContext: { http: { method: 'PUT', path: '/api/artists/artist-1/acts/nonexistent' } },
        pathParameters: { id: 'artist-1', actId: 'nonexistent' },
        headers: {
          origin: 'https://backstage.bndy.co.uk',
          Cookie: createAdminSessionCookie()
        },
        body: JSON.stringify({ name: 'Updated Name' })
      };

      const result = await handler(event, {});

      expect(result.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/artists/:id/acts/:actId - delete act', () => {
    it('should delete an act when no events reference it', async () => {
      setMockArtist(mockArtistWithActs);
      // No events reference this act
      mockDynamoDB.query.mockResolvedValue({ Items: [], Count: 0 });
      mockDynamoDB.update.mockResolvedValue({
        Attributes: {
          ...mockArtistWithActs,
          acts: [mockArtistWithActs.acts[1]] // Only act-2 remains
        }
      });

      const event = {
        requestContext: { http: { method: 'DELETE', path: '/api/artists/artist-1/acts/act-1' } },
        pathParameters: { id: 'artist-1', actId: 'act-1' },
        headers: {
          origin: 'https://backstage.bndy.co.uk',
          Cookie: createAdminSessionCookie()
        }
      };

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
    });

    it('should return 409 if events reference the act', async () => {
      setMockArtist(mockArtistWithActs);
      // Events reference this act
      mockDynamoDB.query.mockResolvedValue({
        Items: [{ id: 'event-1', actId: 'act-1' }],
        Count: 1
      });

      const event = {
        requestContext: { http: { method: 'DELETE', path: '/api/artists/artist-1/acts/act-1' } },
        pathParameters: { id: 'artist-1', actId: 'act-1' },
        headers: {
          origin: 'https://backstage.bndy.co.uk',
          Cookie: createAdminSessionCookie()
        }
      };

      const result = await handler(event, {});

      expect(result.statusCode).toBe(409);
      const body = JSON.parse(result.body);
      expect(body.error).toContain('event');
    });
  });

  describe('PUT /api/artists/:id/acts/:actId/default - set default act', () => {
    it('should set an act as default and unset others', async () => {
      setMockArtist(mockArtistWithActs);
      mockDynamoDB.update.mockResolvedValue({
        Attributes: {
          ...mockArtistWithActs,
          acts: [
            { id: 'act-1', name: 'Acoustic Duo', description: 'Stripped back performance', isDefault: false },
            { id: 'act-2', name: 'Full Band', description: 'The full 5-piece experience', isDefault: true }
          ]
        }
      });

      const event = {
        requestContext: { http: { method: 'PUT', path: '/api/artists/artist-1/acts/act-2/default' } },
        pathParameters: { id: 'artist-1', actId: 'act-2' },
        headers: {
          origin: 'https://backstage.bndy.co.uk',
          Cookie: createAdminSessionCookie()
        }
      };

      const result = await handler(event, {});

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.acts.find(a => a.id === 'act-2').isDefault).toBe(true);
      expect(body.acts.find(a => a.id === 'act-1').isDefault).toBe(false);
    });
  });
});
describe('Artist baseline createdAt and MCP list filters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB.get.mockImplementation((params) => {
      if (params.TableName === 'bndy-users') {
        return Promise.resolve({ Item: { cognito_id: 'user-1', platformAdmin: false } });
      }
      return Promise.resolve({ Item: null });
    });
    mockDynamoDB.scan.mockResolvedValue({ Items: [] });
    mockDynamoDB.transactWrite.mockResolvedValue({});
    mockDynamoDB.put.mockResolvedValue({});
  });

  const createSessionCookie = () => {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ userId: 'user-1' }, 'test-jwt-secret', { expiresIn: '1h' });
    return 'bndy_session=' + token;
  };

  it('rejects unknown MCP list query parameters before scanning', async () => {
    const result = await handler({
      requestContext: { http: { method: 'GET', path: '/api/artists/list' } },
      queryStringParameters: { missingGenre: 'true' },
      headers: { origin: 'https://backstage.bndy.co.uk' }
    }, {});

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('missingGenre');
    expect(mockDynamoDB.scan).not.toHaveBeenCalled();
  });

  it('writes createdAt and not created_at on new artist records', async () => {
    const result = await handler({
      requestContext: { http: { method: 'POST', path: '/api/artists' } },
      headers: {
        origin: 'https://backstage.bndy.co.uk',
        Cookie: createSessionCookie()
      },
      body: JSON.stringify({
        name: 'CreatedAt Artist',
        location: 'Bristol',
        genres: ['rock']
      })
    }, {});

    expect(result.statusCode).toBe(201);
    const artistPut = mockDynamoDB.transactWrite.mock.calls[0][0].TransactItems.find(item => item.Put.TableName === 'bndy-artists');
    expect(artistPut.Put.Item.createdAt).toEqual(expect.any(String));
    expect(artistPut.Put.Item.created_at).toBeUndefined();
  });
});

describe('edition-scoped artist find-or-create', () => {
  const token = 'scoped-test-token';
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MCP_SERVICE_TOKEN = token;
    mockDynamoDB.transactWrite.mockResolvedValue({});
    mockDynamoDB.get.mockResolvedValue({});
  });

  const eventFor = (path, body, bearer) => ({
    requestContext: { http: { method: 'POST', path } },
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    body: JSON.stringify(body)
  });

  const scopedBody = {
    name: 'Atomic Brass Band', location: 'Staffordshire', confirmNew: true,
    performerKind: 'brass_band', publicationScopes: ['brass'], discoveryScopes: ['brass'],
    nameVariants: ['Atomic BB'], names: [{ name: 'Atomic Brass Band' }],
    domainProfiles: { brass: { section: 'championship' } }, acts: []
  };

  it('rejects privileged fields on the public route', async () => {
    const res = await handler(eventFor('/api/artists/find-or-create', scopedBody), {});
    expect(res.statusCode).toBe(403);
    expect(mockDynamoDB.transactWrite).not.toHaveBeenCalled();
  });

  it('rejects an invalid service token', async () => {
    const res = await handler(eventFor('/api/artists/find-or-create/mcp', scopedBody, 'wrong'), {});
    expect(res.statusCode).toBe(401);
  });

  it('writes brass metadata inside the artist uniqueness transaction', async () => {
    const res = await handler(eventFor('/api/artists/find-or-create/mcp', scopedBody, token), {});
    expect(res.statusCode).toBe(201);
    const put = mockDynamoDB.transactWrite.mock.calls[0][0].TransactItems.find(i => i.Put?.TableName === 'bndy-artists').Put.Item;
    expect(put).toMatchObject({
      performerKind: 'brass_band', publicationScopes: ['brass'], discoveryScopes: ['brass'],
      name_variants: ['Atomic BB'], names: scopedBody.names, domainProfiles: scopedBody.domainProfiles, acts: []
    });
  });

  it('does not emit duplicate sentinel keys for canonical-equivalent aliases', async () => {
    const body = {
      ...scopedBody,
      name: 'Black Dyke Band',
      location: 'Yorkshire',
      nameVariants: ['Black Dyke Band', 'BLACK DYKE BAND', 'Black Dyke Band']
    };
    const res = await handler(eventFor('/api/artists/find-or-create/mcp', body, token), {});
    expect(res.statusCode).toBe(201);

    const items = mockDynamoDB.transactWrite.mock.calls[0][0].TransactItems;
    const sentinelKeys = items
      .filter((item) => item.Put?.TableName === 'bndy-unique-keys')
      .map((item) => item.Put.Item.key);
    expect(sentinelKeys).toEqual(['artist#blackdyke#yorkshire']);
    expect(new Set(sentinelKeys).size).toBe(sentinelKeys.length);
  });

  it('returns existing scope metadata without updating a matched artist', async () => {
    mockDynamoDB.get.mockResolvedValue({ Item: { id: 'live-1', name: 'Existing', location: 'Staffordshire', publicationScopes: ['live'] } });
    const res = await handler(eventFor('/api/artists/find-or-create/mcp', { ...scopedBody, confirmNew: false, resolveTo: 'live-1' }, token), {});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).artist.publicationScopes).toEqual(['live']);
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
    expect(mockDynamoDB.transactWrite).not.toHaveBeenCalled();
  });
});
