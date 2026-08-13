/**
 * Behaviour tests for GET /api/events/public/geo — bbox contract + adaptive
 * precision + capped fan-out. Design: GEO-EVENTS-ENDPOINT-PLAN.md v2.
 */
const { handleGetPublicEventsGeo } = require('./public');

const getCorsHeaders = () => ({ 'Access-Control-Allow-Origin': '*' });
const evt = (qs) => ({ headers: {}, queryStringParameters: qs });
const WINDOW = { startDate: '2026-07-11', endDate: '2026-07-18' };

const ITEM = {
  id: 'e1', artistId: 'a1', venueId: 'v1', date: '2026-07-12',
  startTime: '20:00', geoLat: 53.0, geoLng: -2.2, isPublic: true, ticketed: true,
  privateNotes: 'must not leak',
};

function mockDynamo(items = [ITEM]) {
  return {
    query: jest.fn(() => ({ promise: () => Promise.resolve({ Items: items }) })),
    scan: jest.fn(() => ({ promise: () => Promise.resolve({ Items: items }) })),
  };
}

describe('handleGetPublicEventsGeo — validation', () => {
  it('400 when neither bbox nor geohash given', async () => {
    const res = await handleGetPublicEventsGeo({ dynamodb: mockDynamo(), getCorsHeaders }, evt({ ...WINDOW }));
    expect(res.statusCode).toBe(400);
  });
  it('400 on malformed bbox', async () => {
    const res = await handleGetPublicEventsGeo({ dynamodb: mockDynamo(), getCorsHeaders }, evt({ bbox: '1,2,3', ...WINDOW }));
    expect(res.statusCode).toBe(400);
  });
  it('400 on malformed dates', async () => {
    const res = await handleGetPublicEventsGeo({ dynamodb: mockDynamo(), getCorsHeaders }, evt({ bbox: '-2.4,52.9,-2.0,53.15', startDate: 'nope', endDate: '2026-07-18' }));
    expect(res.statusCode).toBe(400);
  });
});

describe('handleGetPublicEventsGeo — legacy geohash param (deprecated, kept)', () => {
  it('queries centre + 8 neighbours on the gh6 index', async () => {
    const dynamodb = mockDynamo();
    const res = await handleGetPublicEventsGeo({ dynamodb, getCorsHeaders }, evt({ geohash: 'gcqrs4', ...WINDOW }));
    expect(res.statusCode).toBe(200);
    expect(dynamodb.query).toHaveBeenCalledTimes(9);
    expect(dynamodb.query.mock.calls.every(([p]) => p.IndexName === 'geohash6-date-index')).toBe(true);
  });
});

describe('handleGetPublicEventsGeo — bbox contract', () => {
  it('walking-scale bbox → gh6 index, truncated:false, light shape with startTime, no private fields', async () => {
    const dynamodb = mockDynamo();
    const res = await handleGetPublicEventsGeo({ dynamodb, getCorsHeaders }, evt({ bbox: '-2.19,53.0,-2.17,53.02', ...WINDOW }));
    expect(res.statusCode).toBe(200);
    expect(dynamodb.query.mock.calls.length).toBeGreaterThan(0);
    expect(dynamodb.query.mock.calls.every(([p]) => p.IndexName === 'geohash6-date-index')).toBe(true);
    const body = JSON.parse(res.body);
    expect(body.truncated).toBe(false);
    const e = body.events[0];
    // `cancelled` joined the light geo shape with feature 7 (cancelled gigs,
    // 2026-08-11). This expectation was never updated, so the suite has been
    // red since then. Found and fixed 2026-08-13 during feature 12.
    expect(e).toEqual({ id: 'e1', artistId: 'a1', venueId: 'v1', date: '2026-07-12', startTime: '20:00', geoLat: 53.0, geoLng: -2.2, ticketed: true, cancelled: false });
  });
  it('city-scale bbox → gh4 index with bounded fan-out', async () => {
    const dynamodb = mockDynamo();
    const res = await handleGetPublicEventsGeo({ dynamodb, getCorsHeaders }, evt({ bbox: '-2.4,52.9,-2.0,53.15', ...WINDOW }));
    expect(res.statusCode).toBe(200);
    expect(dynamodb.query.mock.calls.every(([p]) => p.IndexName === 'geohash4-date-index')).toBe(true);
    expect(dynamodb.query.mock.calls.length).toBeLessThanOrEqual(24);
  });
  it('country-scale bbox → whole-window scan fallback, truncated:true, zero geo queries', async () => {
    const dynamodb = mockDynamo();
    const res = await handleGetPublicEventsGeo({ dynamodb, getCorsHeaders }, evt({ bbox: '-8,50,2,59', ...WINDOW }));
    expect(res.statusCode).toBe(200);
    expect(dynamodb.query).not.toHaveBeenCalled();
    expect(dynamodb.scan).toHaveBeenCalled();
    expect(JSON.parse(res.body).truncated).toBe(true);
  });
  it('every geo query filters isPublic and windows by date', async () => {
    const dynamodb = mockDynamo();
    await handleGetPublicEventsGeo({ dynamodb, getCorsHeaders }, evt({ bbox: '-2.4,52.9,-2.0,53.15', ...WINDOW }));
    for (const [p] of dynamodb.query.mock.calls) {
      expect(p.FilterExpression).toMatch(/isPublic/);
      expect(p.ExpressionAttributeValues[':start']).toBe(WINDOW.startDate);
      expect(p.ExpressionAttributeValues[':end']).toBe(WINDOW.endDate);
    }
  });
  it('sets shared-cache headers', async () => {
    const res = await handleGetPublicEventsGeo({ dynamodb: mockDynamo(), getCorsHeaders }, evt({ bbox: '-2.19,53.0,-2.17,53.02', ...WINDOW }));
    expect(res.headers['Cache-Control']).toMatch(/max-age=60/);
  });
});
