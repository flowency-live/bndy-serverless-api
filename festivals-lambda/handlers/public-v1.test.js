const {
  handleGetPublicFestivals,
  handleGetFestivalBySlug,
  findFestivalBySlug,
  findChildEvents,
  isMissingIndex
} = require('./public-v1');

const getCorsHeaders = () => ({ 'Content-Type': 'application/json' });

function promiseResult(value) {
  return { promise: () => Promise.resolve(value) };
}

function missingIndex() {
  const err = new Error('The table does not have the specified index: byFestival');
  err.code = 'ValidationException';
  return { promise: () => Promise.reject(err) };
}

describe('public-v1 festival reads', () => {
  it('recognises missing-index validation errors', () => {
    const err = new Error('The table does not have the specified index');
    err.code = 'ValidationException';
    expect(isMissingIndex(err)).toBe(true);
  });

  it('falls back to scan when bySlug is unavailable', async () => {
    const festival = { id: 'f1', entityType: 'festival', slug: 'jazz-weekend', isPublic: true };
    const dynamodb = {
      query: jest.fn(() => missingIndex()),
      scan: jest.fn(() => promiseResult({ Items: [festival] }))
    };
    const result = await findFestivalBySlug(dynamodb, 'jazz-weekend');
    expect(result).toEqual(festival);
    expect(dynamodb.scan).toHaveBeenCalled();
  });

  it('falls back to scan when byFestival is unavailable', async () => {
    const event = { id: 'e1', festivalId: 'f1', date: '2026-09-11' };
    const dynamodb = {
      query: jest.fn(() => missingIndex()),
      scan: jest.fn(() => promiseResult({ Items: [event] }))
    };
    const result = await findChildEvents(dynamodb, 'f1');
    expect(result).toEqual([event]);
  });

  it('normalises location and venue count in public summaries', async () => {
    const dynamodb = {
      scan: jest.fn(() => promiseResult({ Items: [{
        id: 'f1', entityType: 'festival', isPublic: true, slug: 'jazz', name: 'Jazz',
        startDate: '2026-09-11', endDate: '2026-09-13', town: 'Congleton',
        primaryVenueId: 'v1', venueIds: ['v1', 'v2'], lineup: [{ id: 's1' }]
      }] }))
    };
    const response = await handleGetPublicFestivals({ dynamodb, getCorsHeaders }, { queryStringParameters: {} });
    const body = JSON.parse(response.body);
    expect(body.festivals[0]).toMatchObject({ location: 'Congleton', venueCount: 2, actCount: 1 });
  });

  it('returns a public festival, child gigs, and true gigCount using index fallbacks', async () => {
    const festival = {
      id: 'f1', entityType: 'festival', isPublic: true, slug: 'jazz', name: 'Jazz',
      startDate: '2026-09-11', endDate: '2026-09-13', venueIds: ['v1'], lineup: []
    };
    const child = { id: 'e1', festivalId: 'f1', isPublic: true, date: '2026-09-11', startTime: '20:00' };
    let scanNo = 0;
    const dynamodb = {
      query: jest.fn(() => missingIndex()),
      scan: jest.fn(() => promiseResult({ Items: (++scanNo === 1) ? [festival] : [child] })),
      batchGet: jest.fn(() => promiseResult({ Responses: { 'bndy-artists': [] } }))
    };
    const response = await handleGetFestivalBySlug(
      { dynamodb, getCorsHeaders },
      { pathParameters: { slug: 'jazz' } }
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.festival.gigCount).toBe(1);
    expect(body.childEvents).toHaveLength(1);
  });
});
