/**
 * Behavior tests for GET /api/venues: full pagination, no per-venue COUNT
 * queries, slim payload, gzip + Cache-Control.
 */
const zlib = require('zlib');
const { handleGetAllVenues, handleListVenuesMcp, handleCreateVenue } = require('./venues-routes');

const getCorsHeaders = () => ({ 'Access-Control-Allow-Origin': 'https://live.bndy.co.uk' });

function decodeBody(res) {
  if (res.isBase64Encoded) {
    return JSON.parse(zlib.gunzipSync(Buffer.from(res.body, 'base64')).toString());
  }
  return JSON.parse(res.body);
}

const venue = (i) => ({
  id: `vn-${i}`, name: `Venue ${i}`, address: `${i} High St`, city: 'Stoke',
  latitude: 53.0 + i * 0.001, longitude: -2.18,
  enrichment_data: { huge: 'blob'.repeat(50) }, enrichment_status: 'done'
});

describe('handleGetAllVenues', () => {
  const lambdaEvent = { headers: { 'accept-encoding': 'gzip' }, queryStringParameters: null };

  function mockDynamo(pages) {
    let call = 0;
    return {
      scan: jest.fn(() => ({ promise: () => Promise.resolve(pages[call++]) })),
      query: jest.fn(() => ({ promise: () => Promise.resolve({ Count: 5 }) }))
    };
  }

  it('paginates the scan across LastEvaluatedKey pages', async () => {
    const dynamodb = mockDynamo([
      { Items: [venue(1), venue(2)], LastEvaluatedKey: { id: 'vn-2' } },
      { Items: [venue(3)] }
    ]);
    const res = await handleGetAllVenues({ dynamodb, getCorsHeaders }, lambdaEvent);
    expect(dynamodb.scan).toHaveBeenCalledTimes(2);
    expect(decodeBody(res)).toHaveLength(3);
  });

  it('does NOT run a COUNT query per venue (the 10.8s N+1)', async () => {
    const dynamodb = mockDynamo([{ Items: [venue(1), venue(2), venue(3)] }]);
    await handleGetAllVenues({ dynamodb, getCorsHeaders }, lambdaEvent);
    expect(dynamodb.query).not.toHaveBeenCalled();
  });

  it('omits enrichment_data blobs and eventCount from the list payload', async () => {
    const dynamodb = mockDynamo([{ Items: [venue(1)] }]);
    const res = await handleGetAllVenues({ dynamodb, getCorsHeaders }, lambdaEvent);
    const body = decodeBody(res);
    expect(body[0].enrichment_data).toBeUndefined();
    expect(body[0].eventCount).toBeUndefined();
    expect(body[0].name).toBe('Venue 1');
    expect(body[0].latitude).toBeCloseTo(53.001);
  });

  it('sets Cache-Control and gzips when accepted', async () => {
    const dynamodb = mockDynamo([{ Items: Array.from({ length: 30 }, (_, i) => venue(i)) }]);
    const res = await handleGetAllVenues({ dynamodb, getCorsHeaders }, lambdaEvent);
    expect(res.headers['Cache-Control']).toMatch(/max-age=/);
    expect(res.headers['Content-Encoding']).toBe('gzip');
  });

  it('still filters by search term', async () => {
    const dynamodb = mockDynamo([{ Items: [ { ...venue(1), name: 'The Glebe' }, { ...venue(2), name: 'Mash' } ] }]);
    const res = await handleGetAllVenues({ dynamodb, getCorsHeaders }, { ...lambdaEvent, queryStringParameters: { search: 'glebe' } });
    const body = decodeBody(res);
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('The Glebe');
  });

  it('excludes venues without valid coordinates', async () => {
    const dynamodb = mockDynamo([{ Items: [venue(1), { id: 'bad', name: 'No Coords', latitude: 0, longitude: 0 }] }]);
    const body = decodeBody(await handleGetAllVenues({ dynamodb, getCorsHeaders }, lambdaEvent));
    expect(body).toHaveLength(1);
  });
});

describe('handleListVenuesMcp', () => {
  const lambdaEvent = { headers: {}, queryStringParameters: null };

  function mockDynamo(pages) {
    let call = 0;
    return {
      scan: jest.fn(() => ({ promise: () => Promise.resolve(pages[call++]) }))
    };
  }

  it('rejects unknown query parameters before scanning', async () => {
    const dynamodb = mockDynamo([{ Items: [] }]);
    const res = await handleListVenuesMcp(
      { dynamodb, getCorsHeaders },
      { ...lambdaEvent, queryStringParameters: { missingAdress: 'true' } }
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('missingAdress');
    expect(dynamodb.scan).not.toHaveBeenCalled();
  });

  it('returns createdAt from the canonical attribute', async () => {
    const dynamodb = mockDynamo([{ Items: [{ ...venue(1), createdAt: '2026-08-01T10:00:00.000Z' }] }]);
    const res = await handleListVenuesMcp({ dynamodb, getCorsHeaders }, lambdaEvent);

    expect(JSON.parse(res.body).venues[0].createdAt).toBe('2026-08-01T10:00:00.000Z');
  });
});

describe('handleCreateVenue', () => {
  it('writes createdAt and not created_at on new venue records', async () => {
    const dynamodb = {
      scan: jest.fn(() => ({ promise: () => Promise.resolve({ Items: [] }) })),
      transactWrite: jest.fn(() => ({ promise: () => Promise.resolve({}) }))
    };

    const res = await handleCreateVenue(
      { dynamodb, lambda: { invoke: jest.fn(() => ({ promise: () => Promise.resolve({}) })) }, getCorsHeaders },
      {
        name: 'CreatedAt Venue',
        address: '1 Test Street',
        city: 'Leek',
        latitude: 53.1,
        longitude: -2.0,
        googlePlaceId: 'ChIJ_created_at_test'
      },
      { headers: {} }
    );

    expect(res.statusCode).toBe(201);
    const venuePut = dynamodb.transactWrite.mock.calls[0][0].TransactItems.find(item => item.Put.TableName === 'bndy-venues');
    expect(venuePut.Put.Item.createdAt).toEqual(expect.any(String));
    expect(venuePut.Put.Item.created_at).toBeUndefined();
  });
});