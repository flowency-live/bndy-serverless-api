/**
 * Behavior tests for public read handlers: shared caching + gzip + batched joins.
 */
const zlib = require('zlib');
const { handleGetAllPublicEvents, handleGetVenueEvents } = require('./public');

const getCorsHeaders = () => ({ 'Access-Control-Allow-Origin': 'https://live.bndy.co.uk' });

function decodeBody(res) {
  if (res.isBase64Encoded) {
    return JSON.parse(zlib.gunzipSync(Buffer.from(res.body, 'base64')).toString());
  }
  return JSON.parse(res.body);
}

const bigName = 'x'.repeat(50);
const manyEvents = Array.from({ length: 40 }, (_, i) => ({
  id: `ev-${i}`, artistId: `ar-${i % 5}`, venueId: `vn-${i % 3}`,
  date: '2026-07-04', isPublic: true, name: bigName
}));

function mockDynamo() {
  return {
    scan: jest.fn(params => ({ promise: () => Promise.resolve({ Items: manyEvents }) })),
    query: jest.fn(params => ({ promise: () => Promise.resolve({ Items: manyEvents }) })),
    batchGet: jest.fn(params => {
      const table = Object.keys(params.RequestItems)[0];
      return { promise: () => Promise.resolve({
        Responses: { [table]: params.RequestItems[table].Keys.map(k => ({ id: k.id, name: `name-${k.id}`, city: 'Stoke' })) }
      }) };
    }),
    get: jest.fn(params => ({ promise: () => Promise.resolve({ Item: { id: params.Key.id, name: `name-${params.Key.id}` } }) }))
  };
}

describe('handleGetAllPublicEvents', () => {
  const lambdaEvent = { headers: { 'accept-encoding': 'gzip' }, queryStringParameters: { startDate: '2026-07-01', endDate: '2026-07-31' } };

  it('returns enriched events with Cache-Control and gzip', async () => {
    const dynamodb = mockDynamo();
    const res = await handleGetAllPublicEvents({ dynamodb, getCorsHeaders }, lambdaEvent);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toMatch(/max-age=/);
    expect(res.headers['Content-Encoding']).toBe('gzip');
    const body = decodeBody(res);
    expect(body.events).toHaveLength(40);
    expect(body.events[0].artistName).toBe('name-ar-0');
    expect(body.events[0].venueName).toBe('name-vn-0');
  });

  it('uses BatchGetItem, not per-id GetItem, for joins', async () => {
    const dynamodb = mockDynamo();
    await handleGetAllPublicEvents({ dynamodb, getCorsHeaders }, lambdaEvent);
    expect(dynamodb.get).not.toHaveBeenCalled();
    expect(dynamodb.batchGet).toHaveBeenCalled();
  });

  it('returns plain JSON when client does not accept gzip', async () => {
    const dynamodb = mockDynamo();
    const res = await handleGetAllPublicEvents({ dynamodb, getCorsHeaders }, { ...lambdaEvent, headers: {} });
    expect(res.isBase64Encoded).toBeUndefined();
    expect(JSON.parse(res.body).events).toHaveLength(40);
  });

  it('includes festival fields (festivalId, festivalName, billing, billingOrder) when present', async () => {
    const festivalEvents = [
      {
        id: 'ev-fest-1',
        artistId: 'ar-1',
        venueId: 'vn-1',
        date: '2026-07-11',
        isPublic: true,
        name: 'Alsager Festival Headline',
        festivalId: 'fest-alsager-2026',
        festivalName: 'Alsager Music Festival 2026',
        billing: 'headline',
        billingOrder: 1
      },
      {
        id: 'ev-fest-2',
        artistId: 'ar-2',
        venueId: 'vn-1',
        date: '2026-07-11',
        isPublic: true,
        name: 'Alsager Festival Support',
        festivalId: 'fest-alsager-2026',
        festivalName: 'Alsager Music Festival 2026',
        billing: 'support',
        billingOrder: 2
      },
      {
        id: 'ev-no-fest',
        artistId: 'ar-3',
        venueId: 'vn-2',
        date: '2026-07-12',
        isPublic: true,
        name: 'Regular Gig'
        // No festival fields - should be null/undefined
      }
    ];

    const dynamodb = {
      scan: jest.fn(() => ({ promise: () => Promise.resolve({ Items: festivalEvents }) })),
      batchGet: jest.fn(params => {
        const table = Object.keys(params.RequestItems)[0];
        return {
          promise: () => Promise.resolve({
            Responses: { [table]: params.RequestItems[table].Keys.map(k => ({ id: k.id, name: `name-${k.id}`, city: 'Stoke' })) }
          })
        };
      })
    };

    const res = await handleGetAllPublicEvents({ dynamodb, getCorsHeaders }, { ...lambdaEvent, headers: {} });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.events).toHaveLength(3);

    // Festival event should have all festival fields
    const headlineEvent = body.events.find(e => e.id === 'ev-fest-1');
    expect(headlineEvent.festivalId).toBe('fest-alsager-2026');
    expect(headlineEvent.festivalName).toBe('Alsager Music Festival 2026');
    expect(headlineEvent.billing).toBe('headline');
    expect(headlineEvent.billingOrder).toBe(1);

    // Support act should also have festival fields
    const supportEvent = body.events.find(e => e.id === 'ev-fest-2');
    expect(supportEvent.festivalId).toBe('fest-alsager-2026');
    expect(supportEvent.billing).toBe('support');
    expect(supportEvent.billingOrder).toBe(2);

    // Non-festival event should have null/undefined festival fields
    const regularEvent = body.events.find(e => e.id === 'ev-no-fest');
    expect(regularEvent.festivalId).toBeUndefined();
    expect(regularEvent.festivalName).toBeUndefined();
    expect(regularEvent.billing).toBeUndefined();
    expect(regularEvent.billingOrder).toBeUndefined();
  });
});

describe('handleGetVenueEvents', () => {
  const lambdaEvent = {
    headers: { 'accept-encoding': 'gzip' },
    pathParameters: { venueId: 'vn-1' },
    queryStringParameters: { startDate: '2026-07-01', endDate: '2026-07-31' }
  };

  it('returns artist-enriched events with Cache-Control', async () => {
    const dynamodb = mockDynamo();
    const res = await handleGetVenueEvents({ dynamodb, getCorsHeaders }, lambdaEvent);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toMatch(/max-age=/);
    const body = decodeBody(res);
    expect(body.events).toHaveLength(40);
    expect(body.events[0].artist.name).toBe('name-ar-0');
  });

  it('joins artists via BatchGetItem and looks up the venue once for ticketing defaults', async () => {
    const dynamodb = mockDynamo();
    await handleGetVenueEvents({ dynamodb, getCorsHeaders }, lambdaEvent);
    expect(dynamodb.get).toHaveBeenCalledTimes(1);
    expect(dynamodb.get).toHaveBeenCalledWith({
      TableName: 'bndy-venues',
      Key: { id: 'vn-1' }
    });
    expect(dynamodb.batchGet).toHaveBeenCalled();
  });
});
