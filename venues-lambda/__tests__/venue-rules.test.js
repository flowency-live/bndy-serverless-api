/**
 * Venue rules on the canonical venue record (owner ruling 06/09/2026).
 *
 * `venueRules` carries the special-venue register that used to live as code in
 * Backline (billing rules, source aliases, region, listing surface). Only a
 * platform admin may write it; every read projection must echo it back.
 */

process.env.JWT_SECRET = 'test-jwt-secret';

const mockDynamoDB = {
  get: jest.fn(),
  put: jest.fn(),
  update: jest.fn(),
  scan: jest.fn(),
  query: jest.fn(),
  delete: jest.fn()
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (params) => ({ promise: () => mockDynamoDB.get(params) }),
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      update: (params) => ({ promise: () => mockDynamoDB.update(params) }),
      scan: (params) => ({ promise: () => mockDynamoDB.scan(params) }),
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      delete: (params) => ({ promise: () => mockDynamoDB.delete(params) })
    }))
  },
  SSM: jest.fn(() => ({
    getParameter: () => ({ promise: () => Promise.resolve({ Parameter: { Value: 'test-jwt-secret' } }) })
  })),
  Lambda: jest.fn(() => ({
    invoke: () => ({ promise: () => Promise.resolve({}) })
  }))
}));

const jwt = require('jsonwebtoken');
const { handler } = require('../handler');
const { validateVenueRules, VENUE_BILLING_RULES, LISTING_SURFACES } = require('../handlers/venue-rules');

const token = (userId) => jwt.sign({ userId, email: 'x@example.com', username: 'x' }, 'test-jwt-secret', { expiresIn: '1d' });

const makeEvent = (method, path, { userId, body, id, query } = {}) => ({
  requestContext: { http: { method, path } },
  cookies: userId ? [`bndy_session=${token(userId)}`] : [],
  headers: { origin: 'https://backstage.bndy.co.uk' },
  pathParameters: id ? { id } : undefined,
  queryStringParameters: query,
  body: body === undefined ? undefined : JSON.stringify(body)
});

const storedVenue = (extra = {}) => ({
  id: 'v-sugarmill', name: 'The Sugarmill', address: '1 Brunswick Street', city: 'Hanley', postcode: 'ST1 1DR',
  latitude: 53.02, longitude: -2.17, google_place_id: 'place-1', name_variants: ['Sugarmill'], external_ids: [], ...extra
});

const sugarmillRules = {
  rules: ['promo-tail', 'lineup'],
  aliases: ['the-sugarmill', 'sugarmill'],
  region: 'Staffordshire',
  listing: { url: 'https://www.thesugarmill.co.uk/gig-guide/', surface: 'static-html', sourceId: 'venue-sugarmill' }
};

// dynamodb.get serves the role lookup (bndy-users) and the venue read (bndy-venues).
const wireUser = (platformAdmin, venueItem = storedVenue()) => {
  mockDynamoDB.get.mockImplementation((params) => {
    if (params.TableName === 'bndy-users') return Promise.resolve({ Item: { cognito_id: 'u1', platformAdmin } });
    return Promise.resolve({ Item: venueItem });
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDynamoDB.update.mockImplementation((params) => Promise.resolve({
    Attributes: { ...storedVenue(), venue_rules: params.ExpressionAttributeValues[':venue_rules'] }
  }));
  mockDynamoDB.put.mockResolvedValue({});
});

describe('validateVenueRules', () => {
  test('accepts the register shape and returns it unchanged', () => {
    expect(validateVenueRules(sugarmillRules)).toEqual({ ok: true, value: sugarmillRules });
  });

  test('every billing rule and listing surface Backline knows is allowed', () => {
    expect(VENUE_BILLING_RULES).toEqual(['promo-tail', 'session-tag', 'tribute-subject', 'genre-bleed', 'lineup']);
    expect(LISTING_SURFACES).toEqual(['static-html', 'wix-load-more', 'browser']);
  });

  test.each([
    ['unknown rule', { ...sugarmillRules, rules: ['promo-tail', 'shout-louder'] }, /rules/],
    ['rules not an array', { ...sugarmillRules, rules: 'lineup' }, /rules/],
    ['empty alias', { ...sugarmillRules, aliases: ['sugarmill', ''] }, /aliases/],
    ['listing without url', { ...sugarmillRules, listing: { surface: 'static-html' } }, /listing\.url/],
    ['listing url not http', { ...sugarmillRules, listing: { url: 'ftp://x', surface: 'static-html' } }, /listing\.url/],
    ['unknown surface', { ...sugarmillRules, listing: { url: 'https://x', surface: 'carrier-pigeon' } }, /listing\.surface/],
    ['unknown key', { ...sugarmillRules, adapter: 'auto' }, /adapter/],
    ['not an object', ['lineup'], /object/],
  ])('rejects %s', (_, value, message) => {
    const result = validateVenueRules(value);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(message);
  });

  test('listing is optional and region is optional', () => {
    expect(validateVenueRules({ rules: ['lineup'], aliases: ['artisan-tap'] }).ok).toBe(true);
  });
});

describe('PUT /api/venues/{id} with venueRules', () => {
  test('401 with no session', async () => {
    const res = await handler(makeEvent('PUT', '/api/venues/v-sugarmill', { id: 'v-sugarmill', body: { venueRules: sugarmillRules } }), {});
    expect(res.statusCode).toBe(401);
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });

  test('403 for an authenticated user who is not platform admin', async () => {
    wireUser(false);
    const res = await handler(makeEvent('PUT', '/api/venues/v-sugarmill', { id: 'v-sugarmill', userId: 'u1', body: { venueRules: sugarmillRules } }), {});
    expect(res.statusCode).toBe(403);
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });

  test('a body without venueRules keeps the existing auth-only behaviour', async () => {
    wireUser(false);
    const res = await handler(makeEvent('PUT', '/api/venues/v-sugarmill', { id: 'v-sugarmill', userId: 'u1', body: { website: 'https://www.thesugarmill.co.uk' } }), {});
    expect(res.statusCode).toBe(200);
    expect(mockDynamoDB.update).toHaveBeenCalledTimes(1);
  });

  test('platform admin writes venue_rules and reads it back on the response', async () => {
    wireUser(true);
    const res = await handler(makeEvent('PUT', '/api/venues/v-sugarmill', { id: 'v-sugarmill', userId: 'u1', body: { venueRules: sugarmillRules } }), {});
    expect(res.statusCode).toBe(200);
    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.TableName).toBe('bndy-venues');
    expect(params.UpdateExpression).toContain('venue_rules = :venue_rules');
    expect(params.ExpressionAttributeValues[':venue_rules']).toEqual(sugarmillRules);
    expect(JSON.parse(res.body).venueRules).toEqual(sugarmillRules);
  });

  test('invalid rules are a 400 and nothing is written', async () => {
    wireUser(true);
    const res = await handler(makeEvent('PUT', '/api/venues/v-sugarmill', { id: 'v-sugarmill', userId: 'u1', body: { venueRules: { rules: ['nope'], aliases: [] } } }), {});
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('INVALID_VENUE_RULES');
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });

  test('venueRules null removes the attribute', async () => {
    wireUser(true);
    mockDynamoDB.update.mockResolvedValue({ Attributes: storedVenue() });
    const res = await handler(makeEvent('PUT', '/api/venues/v-sugarmill', { id: 'v-sugarmill', userId: 'u1', body: { venueRules: null } }), {});
    expect(res.statusCode).toBe(200);
    const params = mockDynamoDB.update.mock.calls[0][0];
    expect(params.UpdateExpression).toMatch(/REMOVE .*venue_rules/);
    expect(JSON.parse(res.body).venueRules).toBeNull();
  });
});

describe('venue read projections carry venueRules', () => {
  test('GET /api/venues/{id}', async () => {
    wireUser(false, storedVenue({ venue_rules: sugarmillRules }));
    const res = await handler(makeEvent('GET', '/api/venues/v-sugarmill', { id: 'v-sugarmill' }), {});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).venueRules).toEqual(sugarmillRules);
  });

  test('GET /api/venues/{id} without rules is null, not undefined', async () => {
    wireUser(false, storedVenue());
    const res = await handler(makeEvent('GET', '/api/venues/v-sugarmill', { id: 'v-sugarmill' }), {});
    expect(JSON.parse(res.body).venueRules).toBeNull();
  });

  test('GET /api/venues list', async () => {
    mockDynamoDB.scan.mockResolvedValue({ Items: [storedVenue({ venue_rules: sugarmillRules }), storedVenue({ id: 'v-plain', name: 'Plain Pub' })] });
    const res = await handler(makeEvent('GET', '/api/venues'), {});
    expect(res.statusCode).toBe(200);
    const venues = JSON.parse(res.body);
    expect(venues.find((v) => v.id === 'v-sugarmill').venueRules).toEqual(sugarmillRules);
    expect(venues.find((v) => v.id === 'v-plain').venueRules).toBeNull();
  });

  test('GET /api/venues?withRules=1 returns only venues that carry rules', async () => {
    mockDynamoDB.scan.mockResolvedValue({ Items: [storedVenue({ venue_rules: sugarmillRules }), storedVenue({ id: 'v-plain', name: 'Plain Pub' })] });
    const res = await handler(makeEvent('GET', '/api/venues', { query: { withRules: '1' } }), {});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).map((v) => v.id)).toEqual(['v-sugarmill']);
  });

  test('GET /api/venues/by-external-id', async () => {
    mockDynamoDB.scan.mockResolvedValue({ Items: [storedVenue({ venue_rules: sugarmillRules, external_ids: [{ source: 'klma', id: 'sugarmill' }] })] });
    const res = await handler(makeEvent('GET', '/api/venues/by-external-id', { query: { source: 'klma', id: 'sugarmill' } }), {});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).venue.venueRules).toEqual(sugarmillRules);
  });
});
