const { scanAll } = require('./scan-all');

function mockDynamo(pages) {
  let call = 0;
  return {
    calls: [],
    scan(params) {
      this.calls.push(params);
      const page = pages[call++];
      return { promise: () => Promise.resolve(page) };
    }
  };
}

describe('scanAll', () => {
  it('returns items from a single page', async () => {
    const db = mockDynamo([{ Items: [{ id: 'a' }, { id: 'b' }] }]);
    const items = await scanAll(db, { TableName: 't' });
    expect(items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].ExclusiveStartKey).toBeUndefined();
  });

  it('follows LastEvaluatedKey across pages (fixes 1MB silent truncation)', async () => {
    const db = mockDynamo([
      { Items: [{ id: 'a' }], LastEvaluatedKey: { id: 'a' } },
      { Items: [{ id: 'b' }], LastEvaluatedKey: { id: 'b' } },
      { Items: [{ id: 'c' }] }
    ]);
    const items = await scanAll(db, { TableName: 't' });
    expect(items.map(i => i.id)).toEqual(['a', 'b', 'c']);
    expect(db.calls).toHaveLength(3);
    expect(db.calls[1].ExclusiveStartKey).toEqual({ id: 'a' });
    expect(db.calls[2].ExclusiveStartKey).toEqual({ id: 'b' });
  });

  it('handles empty pages', async () => {
    const db = mockDynamo([{ Items: [] }]);
    expect(await scanAll(db, { TableName: 't' })).toEqual([]);
  });

  it('does not mutate the caller params object', async () => {
    const db = mockDynamo([{ Items: [], LastEvaluatedKey: { id: 'x' } }, { Items: [] }]);
    const params = { TableName: 't' };
    await scanAll(db, params);
    expect(params.ExclusiveStartKey).toBeUndefined();
  });
});
