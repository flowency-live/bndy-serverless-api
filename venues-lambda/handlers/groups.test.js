/**
 * Feature 19 — venue ownership groups.
 *
 * The rules these tests exist to hold down:
 *   1. A venue has exactly ONE owner group. Ownership is a fact, not a scope.
 *      Scope (many per venue) is feature 16, Editions, and is not modelled here.
 *   2. Venue IDENTITY is untouchable. The group route writes four fields and can
 *      never reach name, address, postcode, city, googlePlaceId or coordinates.
 *   3. `tenure` defaults to `unknown`, never to `independent`. Blank beats wrong.
 *   4. Groups live in their own table, so they can never leak into venue reads.
 *   5. Writes are staff only in V1.
 */

const mockDynamoDB = {
  get: jest.fn(),
  put: jest.fn().mockResolvedValue({}),
  scan: jest.fn(),
  query: jest.fn(),
  update: jest.fn(),
  delete: jest.fn().mockResolvedValue({})
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (p) => ({ promise: () => mockDynamoDB.get(p) }),
      put: (p) => ({ promise: () => mockDynamoDB.put(p) }),
      scan: (p) => ({ promise: () => mockDynamoDB.scan(p) }),
      query: (p) => ({ promise: () => mockDynamoDB.query(p) }),
      update: (p) => ({ promise: () => mockDynamoDB.update(p) }),
      delete: (p) => ({ promise: () => mockDynamoDB.delete(p) })
    }))
  },
  Lambda: jest.fn(() => ({ invoke: () => ({ promise: () => Promise.resolve({ Payload: '{}' }) }) })),
  SSM: jest.fn(() => ({
    getParameter: () => ({ promise: () => Promise.resolve({ Parameter: { Value: 'test-secret' } }) })
  }))
}));

const mockRoleGate = jest.fn();
jest.mock('../lib/curator-core', () => ({
  requireRole: (...a) => mockRoleGate(...a),
  logActivity: jest.fn().mockResolvedValue({}),
  pickFields: jest.requireActual('../lib/curator-core').pickFields,
  hideEntity: jest.fn(),
  restoreEntity: jest.fn()
}));

const groups = require('./groups');

const deps = { dynamodb: null, getCorsHeaders: () => ({}) };
beforeAll(() => {
  const AWS = require('aws-sdk');
  deps.dynamodb = new AWS.DynamoDB.DocumentClient();
});

const asStaff = () => mockRoleGate.mockResolvedValue({ user: { userId: 'u1' }, dbUser: { display_name: 'Jason' }, role: 'staff' });
const asDenied = () => mockRoleGate.mockResolvedValue({ error: 'Forbidden', statusCode: 403 });

const req = (body, params) => ({ body: JSON.stringify(body), pathParameters: params || {} });
const parse = (res) => JSON.parse(res.body);

const ROBINSONS = { id: 'g1', slug: 'robinsons-brewery', name: 'Robinsons Brewery', groupType: 'brewery', venueCount: 2 };
const VENUE = { id: 'v1', name: 'The Beehive', city: 'Honiton', googlePlaceId: 'ChIJabc', latitude: 50.8, longitude: -3.2 };

beforeEach(() => {
  jest.clearAllMocks();
  mockDynamoDB.put.mockResolvedValue({});
  mockDynamoDB.update.mockResolvedValue({ Attributes: {} });
  mockDynamoDB.scan.mockResolvedValue({ Items: [] });
  mockDynamoDB.query.mockResolvedValue({ Items: [] });
  mockDynamoDB.get.mockResolvedValue({});
});

describe('slugify', () => {
  it('makes a URL-safe slug', () => {
    expect(groups.slugify('Robinsons Brewery')).toBe('robinsons-brewery');
  });
  it('turns & into and, so "Marston & Sons" cannot collide with "Marston Sons"', () => {
    expect(groups.slugify('Marston & Sons')).toBe('marston-and-sons');
  });
  it('never leaves leading or trailing dashes', () => {
    expect(groups.slugify('  The Star!!  ')).toBe('the-star');
  });
});

describe('the enums', () => {
  it('covers a pubco, not only a brewery', () => {
    // Amber Taverns is the reason this cannot be a boolean called isBrewery.
    expect(groups.GROUP_TYPES).toEqual(['brewery', 'pubco', 'chain', 'operator']);
  });
  it('defaults tenure to unknown, and unknown is a real value not an absence', () => {
    expect(groups.TENURES[0]).toBe('unknown');
    expect(groups.TENURES).not.toContain('owned_managed'); // arrives with claiming
  });
});

describe('create a group', () => {
  it('refuses a non-staff caller', async () => {
    asDenied();
    const res = await groups.handleCreateGroup(deps, req({ name: 'X', groupType: 'brewery' }));
    expect(res.statusCode).toBe(403);
    expect(mockDynamoDB.put).not.toHaveBeenCalled();
  });

  it('refuses a groupType outside the enum', async () => {
    asStaff();
    const res = await groups.handleCreateGroup(deps, req({ name: 'X', groupType: 'brewary' }));
    expect(res.statusCode).toBe(400);
    expect(parse(res).code).toBe('INVALID_GROUP_TYPE');
  });

  it('writes the group with a slug and a zero venue count', async () => {
    asStaff();
    const res = await groups.handleCreateGroup(deps, req({ name: 'Robinsons Brewery', groupType: 'brewery' }));
    expect(res.statusCode).toBe(201);
    const item = mockDynamoDB.put.mock.calls[0][0].Item;
    expect(item.slug).toBe('robinsons-brewery');
    expect(item.venueCount).toBe(0);
    expect(item.groupType).toBe('brewery');
  });

  it('writes groups to their OWN table, never to bndy-venues', async () => {
    // A group row has no coordinates. In bndy-venues it would leak into venue
    // lists and the map, exactly like an unpartitioned sentinel would.
    asStaff();
    await groups.handleCreateGroup(deps, req({ name: 'Robinsons Brewery', groupType: 'brewery' }));
    expect(mockDynamoDB.put.mock.calls[0][0].TableName).toBe('bndy-venue-groups');
  });

  it('refuses a duplicate name', async () => {
    // Two Robinsons records would split the estate and neither would look wrong.
    asStaff();
    mockDynamoDB.scan.mockResolvedValue({ Items: [ROBINSONS] });
    const res = await groups.handleCreateGroup(deps, req({ name: 'Robinsons Brewery', groupType: 'brewery' }));
    expect(res.statusCode).toBe(409);
    expect(parse(res).code).toBe('DUPLICATE_GROUP');
    expect(parse(res).existingId).toBe('g1');
    expect(mockDynamoDB.scan.mock.calls[0][0]).not.toHaveProperty('Limit');
  });
});

describe('venueCount is derived, never the stored field', () => {
  // 2026-08-14: an MCP edit wrote ownerGroupId through the generic venue PUT.
  // That path never moves the stored counter, so the group read 0 while owning
  // 1, and nothing could repair it. Both reads now count the index.
  it('the list counts the index and ignores a stale stored value', async () => {
    mockDynamoDB.scan.mockResolvedValue({ Items: [{ ...ROBINSONS, venueCount: 0 }] });
    mockDynamoDB.query.mockResolvedValue({ Count: 3 });

    const res = await groups.handleListGroups(deps, {});
    expect(mockDynamoDB.query).toHaveBeenCalledWith(expect.objectContaining({
      IndexName: 'ownerGroupId-index',
      Select: 'COUNT'
    }));
    expect(parse(res).groups[0].venueCount).toBe(3);
  });

  it('reports null, not a stale number, when the index is unavailable', async () => {
    mockDynamoDB.scan.mockResolvedValue({ Items: [{ ...ROBINSONS, venueCount: 99 }] });
    mockDynamoDB.query.mockRejectedValue(new Error('index missing'));

    const res = await groups.handleListGroups(deps, {});
    expect(parse(res).groups[0].venueCount).toBeNull();
  });

  it('the detail read overrides the stored count too', async () => {
    mockDynamoDB.scan.mockResolvedValue({ Items: [{ ...ROBINSONS, venueCount: 0 }] });
    mockDynamoDB.query.mockResolvedValue({ Items: [{ id: 'v1', name: 'A' }] });

    const res = await groups.handleGetGroup(deps, { pathParameters: { slug: 'robinsons-brewery' } });
    expect(parse(res).group.venueCount).toBe(1);
  });
});

describe('read a group and its estate', () => {
  it('reads the estate from the GSI, not with a scan', async () => {
    // A scan works at 2,585 venues and stops working at 25,000.
    mockDynamoDB.scan.mockResolvedValue({ Items: [ROBINSONS] });
    mockDynamoDB.query.mockResolvedValue({ Items: [{ id: 'v1', name: 'B' }, { id: 'v2', name: 'A' }] });

    const res = await groups.handleGetGroup(deps, { pathParameters: { slug: 'robinsons-brewery' } });
    expect(res.statusCode).toBe(200);
    expect(mockDynamoDB.query).toHaveBeenCalledWith(expect.objectContaining({
      TableName: 'bndy-venues',
      IndexName: 'ownerGroupId-index'
    }));
    expect(parse(res).venues.map(v => v.name)).toEqual(['A', 'B']); // sorted
    expect(parse(res).venueCount).toBe(2);
    expect(mockDynamoDB.scan.mock.calls[0][0]).not.toHaveProperty('Limit');
  });

  it('404s an unknown slug', async () => {
    const res = await groups.handleGetGroup(deps, { pathParameters: { slug: 'nope' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('assign a venue to a group', () => {
  const setup = () => {
    asStaff();
    mockDynamoDB.get.mockImplementation((p) =>
      p.TableName === 'bndy-venue-groups'
        ? Promise.resolve({ Item: ROBINSONS })
        : Promise.resolve({ Item: VENUE }));
  };

  it('refuses a non-staff caller', async () => {
    asDenied();
    const res = await groups.handleSetVenueGroup(deps, req({ ownerGroupId: 'g1' }, { id: 'v1' }));
    expect(res.statusCode).toBe(403);
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });

  it('writes the pointer, the denormalised name and the tenure', async () => {
    setup();
    const res = await groups.handleSetVenueGroup(deps, req({ ownerGroupId: 'g1' }, { id: 'v1' }));
    expect(res.statusCode).toBe(200);

    const call = mockDynamoDB.update.mock.calls.find(c => c[0].TableName === 'bndy-venues')[0];
    expect(call.ExpressionAttributeValues[':g']).toBe('g1');
    expect(call.ExpressionAttributeValues[':gn']).toBe('Robinsons Brewery');
    // Assigning a venue to a group IS the statement that it is owned. `unknown`
    // here would be false modesty about the fact we just recorded.
    expect(call.ExpressionAttributeValues[':t']).toBe('owned');
  });

  it('CANNOT touch venue identity', async () => {
    // Jason ruling 2026-08-11. This holds by construction: the route builds its
    // own UpdateExpression and has no pass-through for arbitrary fields.
    setup();
    await groups.handleSetVenueGroup(deps, req({
      ownerGroupId: 'g1',
      name: 'Renamed', address: '1 Nowhere', postcode: 'XX1 1XX',
      city: 'Elsewhere', googlePlaceId: 'ChIJhacked', latitude: 0, longitude: 0
    }, { id: 'v1' }));

    const call = mockDynamoDB.update.mock.calls.find(c => c[0].TableName === 'bndy-venues')[0];
    for (const forbidden of ['name', 'address', 'postcode', 'city', 'googlePlaceId', 'latitude', 'longitude']) {
      expect(call.UpdateExpression).not.toContain(forbidden);
    }
    expect(call.UpdateExpression).toBe(
      'SET ownerGroupId = :g, ownerGroupName = :gn, tenure = :t, tenureCheckedAt = :n, updatedAt = :n'
    );
  });

  it('404s an unknown group instead of writing a dangling pointer', async () => {
    asStaff();
    mockDynamoDB.get.mockImplementation((p) =>
      p.TableName === 'bndy-venue-groups' ? Promise.resolve({}) : Promise.resolve({ Item: VENUE }));
    const res = await groups.handleSetVenueGroup(deps, req({ ownerGroupId: 'ghost' }, { id: 'v1' }));
    expect(res.statusCode).toBe(404);
    expect(parse(res).code).toBe('GROUP_NOT_FOUND');
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });

  it('refuses a tenure outside the enum', async () => {
    setup();
    const res = await groups.handleSetVenueGroup(deps, req({ ownerGroupId: 'g1', tenure: 'leasehold' }, { id: 'v1' }));
    expect(res.statusCode).toBe(400);
    expect(parse(res).code).toBe('INVALID_TENURE');
  });

  it('moves the count off the old group and onto the new one', async () => {
    asStaff();
    mockDynamoDB.get.mockImplementation((p) =>
      p.TableName === 'bndy-venue-groups'
        ? Promise.resolve({ Item: ROBINSONS })
        : Promise.resolve({ Item: { ...VENUE, ownerGroupId: 'gOld' } }));

    await groups.handleSetVenueGroup(deps, req({ ownerGroupId: 'g1' }, { id: 'v1' }));
    const counts = mockDynamoDB.update.mock.calls
      .filter(c => c[0].TableName === 'bndy-venue-groups')
      .map(c => [c[0].Key.id, c[0].ExpressionAttributeValues[':d']]);
    expect(counts).toEqual(expect.arrayContaining([['gOld', -1], ['g1', 1]]));
  });
});

describe('clear a venue group', () => {
  it('removes the pointer and does NOT assume independence', async () => {
    // No parent does not mean free house. It may simply be unchecked.
    asStaff();
    mockDynamoDB.get.mockResolvedValue({ Item: { ...VENUE, ownerGroupId: 'g1' } });

    const res = await groups.handleSetVenueGroup(deps, req({ ownerGroupId: null }, { id: 'v1' }));
    expect(res.statusCode).toBe(200);

    const call = mockDynamoDB.update.mock.calls.find(c => c[0].TableName === 'bndy-venues')[0];
    expect(call.UpdateExpression).toContain('REMOVE ownerGroupId, ownerGroupName');
    expect(call.ExpressionAttributeValues[':t']).toBe('unknown');
  });

  it('records independence only when told explicitly', async () => {
    asStaff();
    mockDynamoDB.get.mockResolvedValue({ Item: { ...VENUE, ownerGroupId: 'g1' } });
    await groups.handleSetVenueGroup(deps, req({ ownerGroupId: null, tenure: 'independent' }, { id: 'v1' }));
    const call = mockDynamoDB.update.mock.calls.find(c => c[0].TableName === 'bndy-venues')[0];
    expect(call.ExpressionAttributeValues[':t']).toBe('independent');
  });
});

describe('rename a group', () => {
  it('sweeps the denormalised name across the estate', async () => {
    // The venue rows carry ownerGroupName, the same pattern events use for
    // festivalName. Without the sweep the two disagree and the venue is stale.
    asStaff();
    mockDynamoDB.get.mockResolvedValue({ Item: ROBINSONS });
    mockDynamoDB.scan.mockResolvedValue({ Items: [] });
    mockDynamoDB.update.mockResolvedValue({ Attributes: { ...ROBINSONS, name: 'Robinsons' } });
    mockDynamoDB.query.mockResolvedValue({ Items: [{ id: 'v1' }, { id: 'v2' }] });

    const res = await groups.handleUpdateGroup(deps, req({ name: 'Robinsons' }, { id: 'g1' }));
    expect(res.statusCode).toBe(200);

    const sweeps = mockDynamoDB.update.mock.calls
      .filter(c => c[0].TableName === 'bndy-venues' && c[0].UpdateExpression.includes('ownerGroupName'));
    expect(sweeps).toHaveLength(2);
    expect(sweeps[0][0].ExpressionAttributeValues[':n']).toBe('Robinsons');
  });

  it('refuses a rename that collides with another group', async () => {
    asStaff();
    mockDynamoDB.get.mockResolvedValue({ Item: { id: 'g2', name: 'Other', slug: 'other' } });
    mockDynamoDB.scan.mockResolvedValue({ Items: [ROBINSONS] });
    const res = await groups.handleUpdateGroup(deps, req({ name: 'Robinsons Brewery' }, { id: 'g2' }));
    expect(res.statusCode).toBe(409);
    expect(parse(res).code).toBe('DUPLICATE_GROUP');
  });

  it('rejects a body with no editable field', async () => {
    asStaff();
    const res = await groups.handleUpdateGroup(deps, req({ venueCount: 999 }, { id: 'g1' }));
    expect(res.statusCode).toBe(400);
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });
});

/**
 * Change B, 2026-08-14. The importer has no cookie. It carries the same machine
 * credential that already gates the /mcp write routes. Without this gate a 235
 * pub estate must be assigned by hand.
 */
describe('the MCP service token gate', () => {
  const TOKEN = 'a-very-secret-service-token';
  const bearer = (t) => ({ headers: { Authorization: `Bearer ${t}` }, body: JSON.stringify({ name: 'Amber Taverns', groupType: 'pubco' }), pathParameters: {} });

  beforeEach(() => {
    process.env.MCP_SERVICE_TOKEN = TOKEN;
    // No cookie path at all: if the token gate fails, the cookie gate denies.
    asDenied();
  });
  afterEach(() => { delete process.env.MCP_SERVICE_TOKEN; });

  it('creates a group on a valid Bearer token, with no cookie', async () => {
    const res = await groups.handleCreateGroup(deps, bearer(TOKEN));
    expect(res.statusCode).toBe(201);
    expect(mockRoleGate).not.toHaveBeenCalled();
  });

  it('records the machine as the actor, not a person', async () => {
    const { logActivity } = require('../lib/curator-core');
    await groups.handleCreateGroup(deps, bearer(TOKEN));
    expect(logActivity.mock.calls[0][1].actorCognitoId).toBe('mcp-service');
  });

  it('assigns a venue to a group on a valid Bearer token', async () => {
    mockDynamoDB.get
      .mockResolvedValueOnce({ Item: VENUE })
      .mockResolvedValueOnce({ Item: ROBINSONS });
    const res = await groups.handleSetVenueGroup(deps, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ownerGroupId: 'g1', tenure: 'owned' }),
      pathParameters: { id: 'v1' }
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a wrong token of the same length', async () => {
    const res = await groups.handleCreateGroup(deps, bearer('b-very-secret-service-token'));
    expect(res.statusCode).toBe(403);
    expect(mockRoleGate).toHaveBeenCalled();
  });

  it('refuses a wrong token of a different length', async () => {
    const res = await groups.handleCreateGroup(deps, bearer('short'));
    expect(res.statusCode).toBe(403);
  });

  it('refuses when no token and no cookie are present', async () => {
    const res = await groups.handleCreateGroup(deps, { headers: {}, body: '{}', pathParameters: {} });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a Bearer token when the environment holds no service token', async () => {
    delete process.env.MCP_SERVICE_TOKEN;
    const res = await groups.handleCreateGroup(deps, bearer(TOKEN));
    expect(res.statusCode).toBe(403);
  });

  it('still accepts a staff cookie', async () => {
    asStaff();
    const res = await groups.handleCreateGroup(deps, { headers: {}, body: JSON.stringify({ name: 'Amber Taverns', groupType: 'pubco' }), pathParameters: {} });
    expect(res.statusCode).toBe(201);
  });
});
