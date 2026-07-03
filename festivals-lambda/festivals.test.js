/**
 * TDD tests for festivals-lambda CRUD operations
 * Per spec: festival-mcp-write-api-spec.md §1, §3
 */

const {
  handleCreateFestival,
  handleUpdateFestival,
  handleSearchFestivals,
  handleGetPublicFestivals,
  handleGetFestivalBySlug
} = require('./handlers/crud');

const getCorsHeaders = () => ({ 'Access-Control-Allow-Origin': 'https://live.bndy.co.uk' });

// Mock DynamoDB
function mockDynamo(overrides = {}) {
  return {
    put: jest.fn(() => ({ promise: () => Promise.resolve({}) })),
    update: jest.fn(() => ({ promise: () => Promise.resolve({ Attributes: {} }) })),
    get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: null }) })),
    query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) })),
    scan: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) })),
    ...overrides
  };
}

describe('handleCreateFestival', () => {
  const validFestival = {
    name: 'Alsager Music Festival 2026',
    startDate: '2026-07-11',
    endDate: '2026-07-11',
    primaryVenueId: 'venue-milton-park',
    isPublic: true
  };

  it('creates a festival with required fields and generates slug', async () => {
    const dynamodb = mockDynamo({
      query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) })) // No slug collision
    });

    const event = {
      body: JSON.stringify(validFestival),
      headers: {}
    };

    const res = await handleCreateFestival({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(201);

    const body = JSON.parse(res.body);
    expect(body.festivalId).toBeDefined();
    expect(body.slug).toBe('alsager-music-festival-2026');

    // Verify DynamoDB put was called with correct item
    expect(dynamodb.put).toHaveBeenCalledWith(expect.objectContaining({
      Item: expect.objectContaining({
        PK: expect.stringMatching(/^FESTIVAL#/),
        SK: 'META',
        entityType: 'festival',
        name: 'Alsager Music Festival 2026',
        slug: 'alsager-music-festival-2026',
        startDate: '2026-07-11',
        endDate: '2026-07-11',
        primaryVenueId: 'venue-milton-park',
        isPublic: true
      })
    }));
  });

  it('generates collision-suffixed slug when slug exists', async () => {
    const dynamodb = mockDynamo({
      query: jest.fn()
        .mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [{ slug: 'alsager-music-festival-2026' }] }) }) // First slug exists
        .mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [] }) }) // -2 is free
    });

    const event = {
      body: JSON.stringify(validFestival),
      headers: {}
    };

    const res = await handleCreateFestival({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(201);

    const body = JSON.parse(res.body);
    expect(body.slug).toBe('alsager-music-festival-2026-2');
  });

  it('rejects when startDate > endDate', async () => {
    const dynamodb = mockDynamo();
    const event = {
      body: JSON.stringify({
        ...validFestival,
        startDate: '2026-07-15',
        endDate: '2026-07-11'
      }),
      headers: {}
    };

    const res = await handleCreateFestival({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/startDate.*endDate/i);
  });

  it('rejects when date range exceeds 31 days (typo guard)', async () => {
    const dynamodb = mockDynamo();
    const event = {
      body: JSON.stringify({
        ...validFestival,
        startDate: '2026-07-01',
        endDate: '2026-08-15' // 45 days
      }),
      headers: {}
    };

    const res = await handleCreateFestival({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/31 days/i);
  });

  it('requires name', async () => {
    const dynamodb = mockDynamo();
    const event = {
      body: JSON.stringify({
        startDate: '2026-07-11',
        endDate: '2026-07-11'
      }),
      headers: {}
    };

    const res = await handleCreateFestival({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/name.*required/i);
  });

  it('requires startDate', async () => {
    const dynamodb = mockDynamo();
    const event = {
      body: JSON.stringify({
        name: 'Test Festival'
      }),
      headers: {}
    };

    const res = await handleCreateFestival({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/startDate.*required/i);
  });

  it('defaults endDate to startDate when not provided', async () => {
    const dynamodb = mockDynamo({
      query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) }))
    });

    const event = {
      body: JSON.stringify({
        name: 'One Day Festival',
        startDate: '2026-07-11'
        // No endDate
      }),
      headers: {}
    };

    const res = await handleCreateFestival({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(201);

    expect(dynamodb.put).toHaveBeenCalledWith(expect.objectContaining({
      Item: expect.objectContaining({
        startDate: '2026-07-11',
        endDate: '2026-07-11'
      })
    }));
  });

  it('validates billing enum in lineup slots', async () => {
    const dynamodb = mockDynamo({
      query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) }))
    });

    const event = {
      body: JSON.stringify({
        ...validFestival,
        lineup: [{
          displayName: 'Test Act',
          billing: 'invalid_tier' // Not in enum
        }]
      }),
      headers: {}
    };

    const res = await handleCreateFestival({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/billing/i);
  });

  it('validates billingOrder is non-negative integer', async () => {
    const dynamodb = mockDynamo({
      query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) }))
    });

    const event = {
      body: JSON.stringify({
        ...validFestival,
        lineup: [{
          displayName: 'Test Act',
          billing: 'headline',
          billingOrder: -1
        }]
      }),
      headers: {}
    };

    const res = await handleCreateFestival({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/billingOrder/i);
  });

  it('creates festival with stages and lineup slots', async () => {
    const dynamodb = mockDynamo({
      query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) }))
    });

    const event = {
      body: JSON.stringify({
        ...validFestival,
        stages: [
          { name: 'Main Stage' },
          { name: 'Acoustic Tent' }
        ],
        lineup: [
          { displayName: 'Headliner Band', billing: 'headline', billingOrder: 1 },
          { displayName: 'Support Act', billing: 'support', billingOrder: 2 }
        ]
      }),
      headers: {}
    };

    const res = await handleCreateFestival({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(201);

    expect(dynamodb.put).toHaveBeenCalledWith(expect.objectContaining({
      Item: expect.objectContaining({
        stages: expect.arrayContaining([
          expect.objectContaining({ id: expect.any(String), name: 'Main Stage' }),
          expect.objectContaining({ id: expect.any(String), name: 'Acoustic Tent' })
        ]),
        lineup: expect.arrayContaining([
          expect.objectContaining({ id: expect.any(String), displayName: 'Headliner Band' })
        ])
      })
    }));
  });

  it('requires at least one venue when isPublic is true', async () => {
    const dynamodb = mockDynamo({
      query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) }))
    });

    const event = {
      body: JSON.stringify({
        name: 'Public Festival',
        startDate: '2026-07-11',
        isPublic: true
        // No primaryVenueId or venueIds
      }),
      headers: {}
    };

    const res = await handleCreateFestival({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/venue.*required.*public/i);
  });
});

describe('handleUpdateFestival', () => {
  const existingFestival = {
    id: 'fest-123',
    PK: 'FESTIVAL#fest-123',
    SK: 'META',
    name: 'Original Festival',
    slug: 'original-festival',
    startDate: '2026-07-11',
    endDate: '2026-07-11',
    externalIds: [{ source: 'source1', id: 'ext1' }]
  };

  it('updates festival fields (partial update)', async () => {
    const dynamodb = mockDynamo({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: existingFestival }) })),
      update: jest.fn(() => ({ promise: () => Promise.resolve({ Attributes: { ...existingFestival, description: 'Updated description' } }) }))
    });

    const event = {
      pathParameters: { id: 'fest-123' },
      body: JSON.stringify({ description: 'Updated description' }),
      headers: {}
    };

    const res = await handleUpdateFestival({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(200);

    expect(dynamodb.update).toHaveBeenCalled();
  });

  it('merges externalIds additively by default', async () => {
    const dynamodb = mockDynamo({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: existingFestival }) })),
      update: jest.fn(() => ({ promise: () => Promise.resolve({ Attributes: {} }) }))
    });

    const event = {
      pathParameters: { id: 'fest-123' },
      body: JSON.stringify({
        externalIds: [{ source: 'source2', id: 'ext2' }]
      }),
      headers: {}
    };

    const res = await handleUpdateFestival({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(200);

    // Should merge, not replace
    const updateCall = dynamodb.update.mock.calls[0][0];
    expect(updateCall.ExpressionAttributeValues[':externalIds']).toEqual([
      { source: 'source1', id: 'ext1' },
      { source: 'source2', id: 'ext2' }
    ]);
  });

  it('replaces externalIds when replaceExternalIds is true', async () => {
    const dynamodb = mockDynamo({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: existingFestival }) })),
      update: jest.fn(() => ({ promise: () => Promise.resolve({ Attributes: {} }) }))
    });

    const event = {
      pathParameters: { id: 'fest-123' },
      body: JSON.stringify({
        externalIds: [{ source: 'source2', id: 'ext2' }],
        replaceExternalIds: true
      }),
      headers: {}
    };

    const res = await handleUpdateFestival({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(200);

    const updateCall = dynamodb.update.mock.calls[0][0];
    expect(updateCall.ExpressionAttributeValues[':externalIds']).toEqual([
      { source: 'source2', id: 'ext2' }
    ]);
  });

  it('does not allow slug modification', async () => {
    const dynamodb = mockDynamo({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: existingFestival }) }))
    });

    const event = {
      pathParameters: { id: 'fest-123' },
      body: JSON.stringify({ slug: 'new-slug' }),
      headers: {}
    };

    const res = await handleUpdateFestival({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/slug.*immutable/i);
  });

  it('returns 404 when festival not found', async () => {
    const dynamodb = mockDynamo({
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: null }) }))
    });

    const event = {
      pathParameters: { id: 'nonexistent' },
      body: JSON.stringify({ description: 'Updated' }),
      headers: {}
    };

    const res = await handleUpdateFestival({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(404);
  });
});

describe('handleSearchFestivals', () => {
  const festivals = [
    { id: 'fest-1', name: 'Alsager Music Festival 2026', startDate: '2026-07-11', endDate: '2026-07-11', town: 'Alsager' },
    { id: 'fest-2', name: 'Alsager Rock Festival 2026', startDate: '2026-08-15', endDate: '2026-08-15', town: 'Alsager' },
    { id: 'fest-3', name: 'Crewe Rocks 2026', startDate: '2026-08-29', endDate: '2026-08-30', town: 'Crewe' }
  ];

  it('searches festivals by name (returns ALL matches, not top-match-only)', async () => {
    const dynamodb = mockDynamo({
      scan: jest.fn(() => ({ promise: () => Promise.resolve({ Items: festivals }) }))
    });

    const event = {
      queryStringParameters: { name: 'Alsager' },
      headers: {}
    };

    const res = await handleSearchFestivals({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.festivals).toHaveLength(2);
    expect(body.festivals.every(f => f.name.includes('Alsager'))).toBe(true);
  });

  it('filters by town', async () => {
    const dynamodb = mockDynamo({
      scan: jest.fn(() => ({ promise: () => Promise.resolve({ Items: festivals }) }))
    });

    const event = {
      queryStringParameters: { town: 'Crewe' },
      headers: {}
    };

    const res = await handleSearchFestivals({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.festivals).toHaveLength(1);
    expect(body.festivals[0].name).toBe('Crewe Rocks 2026');
  });

  it('filters by date range', async () => {
    // Mock returns only August festivals (DynamoDB applies the filter server-side)
    const augustFestivals = festivals.filter(f => f.startDate >= '2026-08-01' && f.endDate <= '2026-08-31');
    const dynamodb = mockDynamo({
      scan: jest.fn(() => ({ promise: () => Promise.resolve({ Items: augustFestivals }) }))
    });

    const event = {
      queryStringParameters: { dateFrom: '2026-08-01', dateTo: '2026-08-31' },
      headers: {}
    };

    const res = await handleSearchFestivals({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.festivals).toHaveLength(2);
    expect(body.festivals.every(f => f.startDate >= '2026-08-01')).toBe(true);
  });
});

describe('handleGetPublicFestivals', () => {
  const publicFestivals = [
    { id: 'fest-1', slug: 'alsager-2026', name: 'Alsager Music Festival', startDate: '2026-07-11', endDate: '2026-07-11', isPublic: true, posterImageUrl: 'https://...', price: 'FREE' },
    { id: 'fest-2', slug: 'crewe-rocks', name: 'Crewe Rocks', startDate: '2026-08-29', endDate: '2026-08-30', isPublic: true, price: '£10' }
  ];

  it('returns public festivals with expected fields', async () => {
    const dynamodb = mockDynamo({
      scan: jest.fn(() => ({ promise: () => Promise.resolve({ Items: publicFestivals }) }))
    });

    const event = {
      queryStringParameters: { startDate: '2026-07-01', endDate: '2026-12-31' },
      headers: {}
    };

    const res = await handleGetPublicFestivals({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.festivals).toHaveLength(2);

    // Should include public-facing fields
    expect(body.festivals[0]).toHaveProperty('id');
    expect(body.festivals[0]).toHaveProperty('slug');
    expect(body.festivals[0]).toHaveProperty('name');
    expect(body.festivals[0]).toHaveProperty('startDate');
    expect(body.festivals[0]).toHaveProperty('endDate');
    expect(body.festivals[0]).toHaveProperty('price');
  });

  it('includes actCount for each festival', async () => {
    const dynamodb = mockDynamo({
      scan: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [{
        ...publicFestivals[0],
        lineup: [{ displayName: 'Act 1' }, { displayName: 'Act 2' }]
      }] }) }))
    });

    const event = {
      queryStringParameters: {},
      headers: {}
    };

    const res = await handleGetPublicFestivals({ dynamodb, getCorsHeaders }, event);
    const body = JSON.parse(res.body);

    expect(body.festivals[0].actCount).toBe(2);
  });

  it('has cache control headers', async () => {
    const dynamodb = mockDynamo({
      scan: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) }))
    });

    const event = { queryStringParameters: {}, headers: {} };
    const res = await handleGetPublicFestivals({ dynamodb, getCorsHeaders }, event);

    expect(res.headers['Cache-Control']).toMatch(/max-age=/);
  });
});

describe('handleGetFestivalBySlug', () => {
  const festival = {
    id: 'fest-alsager',
    slug: 'alsager-music-festival-2026',
    name: 'Alsager Music Festival 2026',
    startDate: '2026-07-11',
    endDate: '2026-07-11',
    primaryVenueId: 'venue-milton-park',
    stages: [
      { id: 'stage-1', name: 'Main Stage' },
      { id: 'stage-2', name: 'Acoustic Tent' }
    ],
    lineup: [
      { id: 'slot-1', displayName: 'Headliner', artistId: 'artist-1', billing: 'headline' },
      { id: 'slot-2', displayName: 'Support Act', billing: 'support' }
    ],
    isPublic: true
  };

  const childEvents = [
    { id: 'event-1', festivalId: 'fest-alsager', date: '2026-07-11', artistId: 'artist-1', startTime: '20:00' },
    { id: 'event-2', festivalId: 'fest-alsager', date: '2026-07-11', artistId: 'artist-2', startTime: '18:00' }
  ];

  it('returns festival with lineup and child events in one response', async () => {
    const dynamodb = mockDynamo({
      query: jest.fn()
        .mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [festival] }) }) // bySlug query
        .mockReturnValueOnce({ promise: () => Promise.resolve({ Items: childEvents }) }), // byFestival query
      batchGet: jest.fn(() => ({
        promise: () => Promise.resolve({
          Responses: {
            'bndy-artists': [
              { id: 'artist-1', name: 'The Headliners' },
              { id: 'artist-2', name: 'Support Band' }
            ]
          }
        })
      }))
    });

    const event = {
      pathParameters: { slug: 'alsager-music-festival-2026' },
      headers: {}
    };

    const res = await handleGetFestivalBySlug({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.festival).toBeDefined();
    expect(body.festival.name).toBe('Alsager Music Festival 2026');
    expect(body.festival.lineup).toHaveLength(2);
    expect(body.childEvents).toHaveLength(2);
  });

  it('returns 404 when slug not found', async () => {
    const dynamodb = mockDynamo({
      query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) }))
    });

    const event = {
      pathParameters: { slug: 'nonexistent-festival' },
      headers: {}
    };

    const res = await handleGetFestivalBySlug({ dynamodb, getCorsHeaders }, event);
    expect(res.statusCode).toBe(404);
  });

  it('enriches lineup slots with artist data', async () => {
    const dynamodb = mockDynamo({
      query: jest.fn()
        .mockReturnValueOnce({ promise: () => Promise.resolve({ Items: [festival] }) })
        .mockReturnValueOnce({ promise: () => Promise.resolve({ Items: childEvents }) }),
      batchGet: jest.fn(() => ({
        promise: () => Promise.resolve({
          Responses: {
            'bndy-artists': [{ id: 'artist-1', name: 'The Headliners' }]
          }
        })
      }))
    });

    const event = {
      pathParameters: { slug: 'alsager-music-festival-2026' },
      headers: {}
    };

    const res = await handleGetFestivalBySlug({ dynamodb, getCorsHeaders }, event);
    const body = JSON.parse(res.body);

    // Lineup should include resolved artist names
    const headlinerSlot = body.festival.lineup.find(s => s.artistId === 'artist-1');
    expect(headlinerSlot.artistName).toBe('The Headliners');
  });
});
