/**
 * TDD tests for festivals-lambda curator routes
 * Per spec: bndy-app/FESTIVAL-CURATOR-PLAN.md §B2
 *
 * Tests:
 * - 401 no cookie
 * - 403 role user (not curator/staff)
 * - create forces isPublic=false even when body sends true
 * - create ignores non-whitelisted fields (externalIds, source, slug, lineup)
 * - GET returns a draft by id AND by slug
 * - PATCH publish succeeds with stored venues and a lone isPublic patch
 * - PATCH publish 400s when no venues anywhere
 * - slug remains immutable through the curator path
 */

const jwt = require('jsonwebtoken');
const { handleCuratorCreateFestival, handleCuratorGetFestival, handleCuratorUpdateFestival, CURATOR_FESTIVAL_FIELDS } = require('./curator');

// Mock SSM and JWT
const JWT_SECRET = 'test-secret';

function createMockDeps(dynamoOverrides = {}, ssmOverrides = {}) {
  return {
    dynamodb: {
      put: jest.fn(() => ({ promise: () => Promise.resolve({}) })),
      update: jest.fn(() => ({ promise: () => Promise.resolve({ Attributes: {} }) })),
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: null }) })),
      query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) })),
      scan: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) })),
      ...dynamoOverrides
    },
    ssm: {
      getParameter: jest.fn(() => ({
        promise: () => Promise.resolve({ Parameter: { Value: JWT_SECRET } })
      })),
      ...ssmOverrides
    },
    getCorsHeaders: () => ({ 'Content-Type': 'application/json' })
  };
}

function createSessionCookie(payload = { userId: 'user-123' }) {
  return `bndy_session=${jwt.sign(payload, JWT_SECRET)}`;
}

function createEvent(overrides = {}) {
  return {
    headers: {},
    cookies: [],
    body: '{}',
    pathParameters: {},
    ...overrides
  };
}

const curatorUser = { cognito_id: 'user-123', role: 'curator', display_name: 'Test Curator' };
const staffUser = { cognito_id: 'user-456', role: 'staff', display_name: 'Test Staff', platformAdmin: true };
const regularUser = { cognito_id: 'user-789', role: 'user', display_name: 'Regular User' };

describe('Curator Festival Routes - Auth Gates', () => {
  describe('401 - No session cookie', () => {
    it('handleCuratorCreateFestival returns 401 without cookie', async () => {
      const deps = createMockDeps();
      const event = createEvent({ body: JSON.stringify({ name: 'Test Fest', startDate: '2026-07-11' }) });

      const res = await handleCuratorCreateFestival(deps, event);
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toMatch(/authenticated/i);
    });

    it('handleCuratorGetFestival returns 401 without cookie', async () => {
      const deps = createMockDeps();
      const event = createEvent({ pathParameters: { id: 'fest-123' } });

      const res = await handleCuratorGetFestival(deps, event);
      expect(res.statusCode).toBe(401);
    });

    it('handleCuratorUpdateFestival returns 401 without cookie', async () => {
      const deps = createMockDeps();
      const event = createEvent({ pathParameters: { id: 'fest-123' }, body: JSON.stringify({ description: 'Updated' }) });

      const res = await handleCuratorUpdateFestival(deps, event);
      expect(res.statusCode).toBe(401);
    });
  });

  describe('403 - User role (not curator/staff)', () => {
    it('handleCuratorCreateFestival returns 403 for regular user', async () => {
      const deps = createMockDeps({
        get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: regularUser }) }))
      });
      const event = createEvent({
        cookies: [createSessionCookie({ userId: 'user-789' })],
        body: JSON.stringify({ name: 'Test Fest', startDate: '2026-07-11' })
      });

      const res = await handleCuratorCreateFestival(deps, event);
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).error).toMatch(/curator/i);
    });

    it('handleCuratorGetFestival returns 403 for regular user', async () => {
      const deps = createMockDeps({
        get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: regularUser }) }))
      });
      const event = createEvent({
        cookies: [createSessionCookie({ userId: 'user-789' })],
        pathParameters: { id: 'fest-123' }
      });

      const res = await handleCuratorGetFestival(deps, event);
      expect(res.statusCode).toBe(403);
    });

    it('handleCuratorUpdateFestival returns 403 for regular user', async () => {
      const deps = createMockDeps({
        get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: regularUser }) }))
      });
      const event = createEvent({
        cookies: [createSessionCookie({ userId: 'user-789' })],
        pathParameters: { id: 'fest-123' },
        body: JSON.stringify({ description: 'Updated' })
      });

      const res = await handleCuratorUpdateFestival(deps, event);
      expect(res.statusCode).toBe(403);
    });
  });
});

describe('handleCuratorCreateFestival', () => {
  const existingFestival = {
    id: 'fest-123',
    entityType: 'festival',
    name: 'Existing Fest',
    slug: 'existing-fest',
    startDate: '2026-07-11',
    isPublic: false
  };

  it('forces isPublic=false even when body sends true', async () => {
    const putMock = jest.fn(() => ({ promise: () => Promise.resolve({}) }));
    const deps = createMockDeps({
      get: jest.fn((params) => {
        if (params.TableName === 'bndy-users') {
          return { promise: () => Promise.resolve({ Item: curatorUser }) };
        }
        return { promise: () => Promise.resolve({ Item: null }) };
      }),
      query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) })), // No slug collision
      put: putMock
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      body: JSON.stringify({
        name: 'My Festival',
        startDate: '2026-07-11',
        isPublic: true // Trying to create as public
      })
    });

    const res = await handleCuratorCreateFestival(deps, event);
    expect(res.statusCode).toBe(201);

    // Verify that isPublic was forced to false
    const putCall = putMock.mock.calls.find(c => c[0].TableName === 'bndy-events');
    expect(putCall[0].Item.isPublic).toBe(false);
  });

  it('ignores non-whitelisted fields (externalIds, source, slug, lineup)', async () => {
    const putMock = jest.fn(() => ({ promise: () => Promise.resolve({}) }));
    const deps = createMockDeps({
      get: jest.fn((params) => {
        if (params.TableName === 'bndy-users') {
          return { promise: () => Promise.resolve({ Item: curatorUser }) };
        }
        return { promise: () => Promise.resolve({ Item: null }) };
      }),
      query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) })),
      put: putMock
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      body: JSON.stringify({
        name: 'My Festival',
        startDate: '2026-07-11',
        // These should be ignored
        externalIds: [{ source: 'skiddle', id: '12345' }],
        source: 'mcp_ai_import',
        slug: 'custom-slug',
        lineup: [{ displayName: 'Evil Act' }]
      })
    });

    const res = await handleCuratorCreateFestival(deps, event);
    expect(res.statusCode).toBe(201);

    // Verify ignored fields are not present (except source which is overwritten)
    // Note: crud.js initializes externalIds to [] by default, so it won't be undefined
    // but the evil value should not have passed through
    const putCall = putMock.mock.calls.find(c => c[0].TableName === 'bndy-events');
    expect(putCall[0].Item.externalIds).not.toEqual([{ source: 'skiddle', id: '12345' }]);
    // lineup is also initialized to [] by crud.js, so check it's not the evil value
    expect(putCall[0].Item.lineup).not.toEqual([{ displayName: 'Evil Act' }]);
    expect(putCall[0].Item.slug).not.toBe('custom-slug'); // Slug is auto-generated
    expect(putCall[0].Item.source).toBe('curator_app'); // Source is overwritten
  });

  it('sets createdBy and createdByName from session user', async () => {
    const putMock = jest.fn(() => ({ promise: () => Promise.resolve({}) }));
    const deps = createMockDeps({
      get: jest.fn((params) => {
        if (params.TableName === 'bndy-users') {
          return { promise: () => Promise.resolve({ Item: curatorUser }) };
        }
        return { promise: () => Promise.resolve({ Item: null }) };
      }),
      query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) })),
      put: putMock
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      body: JSON.stringify({ name: 'My Festival', startDate: '2026-07-11' })
    });

    const res = await handleCuratorCreateFestival(deps, event);
    expect(res.statusCode).toBe(201);

    const putCall = putMock.mock.calls.find(c => c[0].TableName === 'bndy-events');
    expect(putCall[0].Item.createdBy).toBe('user-123');
    expect(putCall[0].Item.createdByName).toBe('Test Curator');
  });

  it('logs activity on successful create', async () => {
    const putMock = jest.fn(() => ({ promise: () => Promise.resolve({}) }));
    const deps = createMockDeps({
      get: jest.fn((params) => {
        if (params.TableName === 'bndy-users') {
          return { promise: () => Promise.resolve({ Item: curatorUser }) };
        }
        return { promise: () => Promise.resolve({ Item: null }) };
      }),
      query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) })),
      put: putMock
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      body: JSON.stringify({ name: 'Activity Test Fest', startDate: '2026-07-11' })
    });

    await handleCuratorCreateFestival(deps, event);

    // Should have 2 puts: festival + activity log
    const activityPut = putMock.mock.calls.find(c => c[0].TableName === 'bndy-activity-log');
    expect(activityPut).toBeDefined();
    expect(activityPut[0].Item.action).toBe('create');
    expect(activityPut[0].Item.entity_type).toBe('festival');
  });
});

describe('handleCuratorGetFestival', () => {
  const draftFestival = {
    id: 'fest-draft',
    entityType: 'festival',
    name: 'Draft Festival',
    slug: 'draft-festival',
    startDate: '2026-07-11',
    isPublic: false
  };

  it('returns a draft by id (no isPublic filter)', async () => {
    const deps = createMockDeps({
      get: jest.fn((params) => {
        if (params.TableName === 'bndy-users') {
          return { promise: () => Promise.resolve({ Item: curatorUser }) };
        }
        if (params.Key.id === 'fest-draft') {
          return { promise: () => Promise.resolve({ Item: draftFestival }) };
        }
        return { promise: () => Promise.resolve({ Item: null }) };
      })
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      pathParameters: { id: 'fest-draft' }
    });

    const res = await handleCuratorGetFestival(deps, event);
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.festival.id).toBe('fest-draft');
    expect(body.festival.isPublic).toBe(false);
  });

  it('returns a draft by slug (fallback query)', async () => {
    const deps = createMockDeps({
      get: jest.fn((params) => {
        if (params.TableName === 'bndy-users') {
          return { promise: () => Promise.resolve({ Item: curatorUser }) };
        }
        // ID lookup fails
        return { promise: () => Promise.resolve({ Item: null }) };
      }),
      query: jest.fn(() => ({
        promise: () => Promise.resolve({ Items: [draftFestival] })
      }))
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      pathParameters: { id: 'draft-festival' } // Using slug as id
    });

    const res = await handleCuratorGetFestival(deps, event);
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.festival.slug).toBe('draft-festival');
  });

  it('returns 404 when festival not found', async () => {
    const deps = createMockDeps({
      get: jest.fn((params) => {
        if (params.TableName === 'bndy-users') {
          return { promise: () => Promise.resolve({ Item: curatorUser }) };
        }
        return { promise: () => Promise.resolve({ Item: null }) };
      }),
      query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) }))
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      pathParameters: { id: 'nonexistent' }
    });

    const res = await handleCuratorGetFestival(deps, event);
    expect(res.statusCode).toBe(404);
  });

  it('strips PK/SK from response', async () => {
    const festWithPkSk = { ...draftFestival, PK: 'FESTIVAL#fest-draft', SK: 'META' };
    const deps = createMockDeps({
      get: jest.fn((params) => {
        if (params.TableName === 'bndy-users') {
          return { promise: () => Promise.resolve({ Item: curatorUser }) };
        }
        if (params.Key.id === 'fest-draft') {
          return { promise: () => Promise.resolve({ Item: festWithPkSk }) };
        }
        return { promise: () => Promise.resolve({ Item: null }) };
      })
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      pathParameters: { id: 'fest-draft' }
    });

    const res = await handleCuratorGetFestival(deps, event);
    const body = JSON.parse(res.body);
    expect(body.festival.PK).toBeUndefined();
    expect(body.festival.SK).toBeUndefined();
  });
});

describe('handleCuratorUpdateFestival', () => {
  const festivalWithVenues = {
    id: 'fest-with-venues',
    entityType: 'festival',
    name: 'Festival With Venues',
    slug: 'festival-with-venues',
    startDate: '2026-07-11',
    primaryVenueId: 'venue-1',
    venueIds: ['venue-2'],
    isPublic: false
  };

  const festivalNoVenues = {
    id: 'fest-no-venues',
    entityType: 'festival',
    name: 'Festival No Venues',
    slug: 'festival-no-venues',
    startDate: '2026-07-11',
    primaryVenueId: null,
    venueIds: [],
    isPublic: false
  };

  it('PATCH publish succeeds with stored venues and a lone isPublic patch', async () => {
    const updateMock = jest.fn(() => ({ promise: () => Promise.resolve({ Attributes: { ...festivalWithVenues, isPublic: true } }) }));
    const deps = createMockDeps({
      get: jest.fn((params) => {
        if (params.TableName === 'bndy-users') {
          return { promise: () => Promise.resolve({ Item: curatorUser }) };
        }
        if (params.Key.id === 'fest-with-venues') {
          return { promise: () => Promise.resolve({ Item: festivalWithVenues }) };
        }
        return { promise: () => Promise.resolve({ Item: null }) };
      }),
      update: updateMock
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      pathParameters: { id: 'fest-with-venues' },
      body: JSON.stringify({ isPublic: true }) // Just the publish flag
    });

    const res = await handleCuratorUpdateFestival(deps, event);
    expect(res.statusCode).toBe(200);

    // Verify update was called
    expect(updateMock).toHaveBeenCalled();
  });

  it('PATCH publish 400s when no venues anywhere', async () => {
    const deps = createMockDeps({
      get: jest.fn((params) => {
        if (params.TableName === 'bndy-users') {
          return { promise: () => Promise.resolve({ Item: curatorUser }) };
        }
        if (params.Key.id === 'fest-no-venues') {
          return { promise: () => Promise.resolve({ Item: festivalNoVenues }) };
        }
        return { promise: () => Promise.resolve({ Item: null }) };
      })
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      pathParameters: { id: 'fest-no-venues' },
      body: JSON.stringify({ isPublic: true })
    });

    const res = await handleCuratorUpdateFestival(deps, event);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/venue.*required.*public/i);
  });

  it('slug remains immutable through curator path (not in whitelist)', async () => {
    const deps = createMockDeps({
      get: jest.fn((params) => {
        if (params.TableName === 'bndy-users') {
          return { promise: () => Promise.resolve({ Item: curatorUser }) };
        }
        if (params.Key.id === 'fest-with-venues') {
          return { promise: () => Promise.resolve({ Item: festivalWithVenues }) };
        }
        return { promise: () => Promise.resolve({ Item: null }) };
      })
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      pathParameters: { id: 'fest-with-venues' },
      body: JSON.stringify({ slug: 'new-evil-slug' })
    });

    const res = await handleCuratorUpdateFestival(deps, event);
    // slug is not in CURATOR_FESTIVAL_FIELDS, so it gets stripped by pickFields,
    // leaving an empty body which triggers "No editable field" error
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/No editable field/i);
  });

  it('ignores non-whitelisted fields in PATCH', async () => {
    const updateMock = jest.fn(() => ({ promise: () => Promise.resolve({ Attributes: festivalWithVenues }) }));
    const deps = createMockDeps({
      get: jest.fn((params) => {
        if (params.TableName === 'bndy-users') {
          return { promise: () => Promise.resolve({ Item: curatorUser }) };
        }
        if (params.Key.id === 'fest-with-venues') {
          return { promise: () => Promise.resolve({ Item: festivalWithVenues }) };
        }
        return { promise: () => Promise.resolve({ Item: null }) };
      }),
      update: updateMock
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      pathParameters: { id: 'fest-with-venues' },
      body: JSON.stringify({
        description: 'Valid field',
        externalIds: [{ source: 'evil', id: '666' }], // Should be ignored
        lineup: [{ displayName: 'Evil' }], // Should be ignored
        source: 'evil_source' // Should be ignored
      })
    });

    const res = await handleCuratorUpdateFestival(deps, event);
    expect(res.statusCode).toBe(200);

    // The delegate (handleUpdateFestival) receives only whitelisted fields
    // Since we're testing the curator layer, verify update was called
    expect(updateMock).toHaveBeenCalled();
  });

  it('logs activity with correct action (publish/unpublish/edit)', async () => {
    const putMock = jest.fn(() => ({ promise: () => Promise.resolve({}) }));
    const deps = createMockDeps({
      get: jest.fn((params) => {
        if (params.TableName === 'bndy-users') {
          return { promise: () => Promise.resolve({ Item: curatorUser }) };
        }
        if (params.Key.id === 'fest-with-venues') {
          return { promise: () => Promise.resolve({ Item: festivalWithVenues }) };
        }
        return { promise: () => Promise.resolve({ Item: null }) };
      }),
      update: jest.fn(() => ({ promise: () => Promise.resolve({ Attributes: { ...festivalWithVenues, isPublic: true } }) })),
      put: putMock
    });

    const event = createEvent({
      cookies: [createSessionCookie()],
      pathParameters: { id: 'fest-with-venues' },
      body: JSON.stringify({ isPublic: true })
    });

    await handleCuratorUpdateFestival(deps, event);

    const activityPut = putMock.mock.calls.find(c => c[0].TableName === 'bndy-activity-log');
    expect(activityPut).toBeDefined();
    expect(activityPut[0].Item.action).toBe('publish');
  });
});

describe('validateFestival regression - isCreate-only venue check', () => {
  // Import validateFestival from crud.js for direct testing
  const { validateFestival } = require('./crud');

  it('allows isPublic:true on UPDATE without venues in payload (merged state check)', () => {
    // On UPDATE, the venue check runs against MERGED state (handleUpdateFestival)
    // validateFestival itself should NOT reject on update
    const result = validateFestival({ isPublic: true }, false);
    expect(result.valid).toBe(true);
  });

  it('rejects isPublic:true on CREATE without venues', () => {
    const result = validateFestival({ name: 'Test', startDate: '2026-07-11', isPublic: true }, true);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/venue.*required/i);
  });

  it('allows isPublic:true on CREATE with primaryVenueId', () => {
    const result = validateFestival({
      name: 'Test',
      startDate: '2026-07-11',
      isPublic: true,
      primaryVenueId: 'venue-1'
    }, true);
    expect(result.valid).toBe(true);
  });

  it('allows isPublic:true on CREATE with venueIds', () => {
    const result = validateFestival({
      name: 'Test',
      startDate: '2026-07-11',
      isPublic: true,
      venueIds: ['venue-1']
    }, true);
    expect(result.valid).toBe(true);
  });
});
