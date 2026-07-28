const { deleteArtistEvents, EVENTS_TABLE } = require('./cascade-delete-events');

function mockDynamo({ pages, unprocessedFirst = 0 }) {
  let unprocessedLeft = unprocessedFirst;
  // aws-sdk v2 style: every call returns { promise: () => Promise }
  const queryImpl = jest.fn();
  pages.forEach((p, i) => {
    queryImpl.mockReturnValueOnce({ promise: () => Promise.resolve({ Items: p, LastEvaluatedKey: i < pages.length - 1 ? { k: i } : undefined }) });
  });
  const batchWrite = jest.fn((params) => ({
    promise: () => {
      const reqs = params.RequestItems[EVENTS_TABLE];
      if (unprocessedLeft > 0) {
        const n = Math.min(unprocessedLeft, reqs.length);
        unprocessedLeft = 0;
        return Promise.resolve({ UnprocessedItems: { [EVENTS_TABLE]: reqs.slice(0, n) } });
      }
      return Promise.resolve({ UnprocessedItems: {} });
    },
  }));
  return { query: queryImpl, batchWrite };
}

const ev = (i) => ({ id: `e${i}`, date: `2026-07-${String((i % 28) + 1).padStart(2, '0')}`, venueId: `v${i}`, isPublic: true });

describe('deleteArtistEvents', () => {
  test('no events → deleted 0, no writes', async () => {
    const db = mockDynamo({ pages: [[]] });
    const res = await deleteArtistEvents(db, 'a1');
    expect(res).toEqual({ deleted: 0, audit: [] });
    expect(db.batchWrite).not.toHaveBeenCalled();
  });

  test('paginates the GSI query and deletes across pages', async () => {
    const p1 = Array.from({ length: 3 }, (_, i) => ev(i));
    const p2 = Array.from({ length: 2 }, (_, i) => ev(i + 3));
    const db = mockDynamo({ pages: [p1, p2] });
    const res = await deleteArtistEvents(db, 'a1');
    expect(res.deleted).toBe(5);
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[0][0].IndexName).toBe('artistId-date-index');
    expect(db.query.mock.calls[0][0].KeyConditionExpression).toBe('artistId = :a');
  });

  test('chunks BatchWrite at 25', async () => {
    const events = Array.from({ length: 60 }, (_, i) => ev(i));
    const db = mockDynamo({ pages: [events] });
    await deleteArtistEvents(db, 'a1');
    expect(db.batchWrite).toHaveBeenCalledTimes(3); // 25 + 25 + 10
    const sizes = db.batchWrite.mock.calls.map(([p]) => p.RequestItems[EVENTS_TABLE].length);
    expect(sizes).toEqual([25, 25, 10]);
  });

  test('retries UnprocessedItems until clean', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ev(i));
    const db = mockDynamo({ pages: [events], unprocessedFirst: 2 });
    const res = await deleteArtistEvents(db, 'a1');
    expect(res.deleted).toBe(5);
    expect(db.batchWrite).toHaveBeenCalledTimes(2); // initial + retry of the 2 unprocessed
  });

  test('audit captures compact record per event', async () => {
    const db = mockDynamo({ pages: [[{ id: 'e9', date: '2026-08-01', venueId: null, isPublic: false }]] });
    const res = await deleteArtistEvents(db, 'a1');
    expect(res.audit).toEqual([{ id: 'e9', date: '2026-08-01', venueId: null, name: null, isPublic: false }]);
  });
});
