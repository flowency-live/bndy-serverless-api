const { handleGetPublicEventsGeo } = require('./public');

const WINDOW = { startDate: '2026-07-01', endDate: '2026-07-31' };

function evt(qs) {
  return { queryStringParameters: qs, headers: {} };
}

function mockDynamo() {
  const event = {
    id: 'e1', artist_id: 'a1', venue_id: 'v1', date: '2026-07-12',
    start_time: '20:00', geohash: 'gcqrs4', geohash4: 'gcqr', geohash6: 'gcqrs4',
    geo_lat: 53.0, geo_lng: -2.2, ticketed: true, cancelled: false,
    // fields the lightweight geo response must NOT leak
    title: 'Private-ish title', ticket_url: 'https://tickets', information: 'secret-ish'
  };
  return {
    query: jest.fn().mockResolvedValue({ Items: [event] }),
    scan: jest.fn().mockResolvedValue({ Items: [event], LastEvaluatedKey: { id: 'next' } })
  };
}

const getCorsHeaders = () => ({ 'Access-Control-Allow-Origin': '*' });

describe('handleGetPublicEventsGeo — legacy geohash contract', () => {
  it('queries the geohash6 index and returns the lightweight public shape', async () => {
    const dynamodb = mockDynamo();
    const res = await handleGetPublicEventsGeo({ dynamodb, getCorsHeaders }, evt({ geohash: 'gcqrs4', ...WINDOW }));
    expect(res.statusCode).toBe(200);
    expect(dynamodb.query).toHaveBeenCalled();
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
    expect(dynamodb.scan).toHaveBeenCalledTimes(1);
    const body = JSON.parse(res.body);
    expect(body.truncated).toBe(true);
  });
  it('bbox + legacy geohash prefers bbox', async () => {
    const dynamodb = mockDynamo();
    const res = await handleGetPublicEventsGeo({ dynamodb, getCorsHeaders }, evt({ bbox: '-2.4,52.9,-2.0,53.15', geohash: 'gcqrs4', ...WINDOW }));
    expect(res.statusCode).toBe(200);
    expect(dynamodb.query.mock.calls.every(([p]) => p.IndexName === 'geohash4-date-index')).toBe(true);
  });
  it('malformed bbox → 400', async () => {
    const dynamodb = mockDynamo();
    const res = await handleGetPublicEventsGeo({ dynamodb, getCorsHeaders }, evt({ bbox: 'bad', ...WINDOW }));
    expect(res.statusCode).toBe(400);
  });
  it('bbox too many cells at precision 4 falls back rather than issuing unbounded queries', async () => {
    const dynamodb = mockDynamo();
    const res = await handleGetPublicEventsGeo({ dynamodb, getCorsHeaders }, evt({ bbox: '-8,50,2,59', ...WINDOW }));
    expect(res.statusCode).toBe(200);
    expect(dynamodb.query).not.toHaveBeenCalled();
    expect(dynamodb.scan).toHaveBeenCalledTimes(1);
  });
  it('bbox query result shape contains no ticketUrl/title/information', async () => {
    const dynamodb = mockDynamo();
    const res = await handleGetPublicEventsGeo({ dynamodb, getCorsHeaders }, evt({ bbox: '-2.19,53.0,-2.17,53.02', ...WINDOW }));
    const event = JSON.parse(res.body).events[0];
    expect(event.ticketUrl).toBeUndefined();
    expect(event.title).toBeUndefined();
    expect(event.information).toBeUndefined();
  });
});
