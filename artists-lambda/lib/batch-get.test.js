const { batchGetByIds } = require('./batch-get');

function mockDynamo(responder) {
  return {
    calls: [],
    batchGet(params) {
      this.calls.push(JSON.parse(JSON.stringify(params)));
      return { promise: () => Promise.resolve(responder(params, this.calls.length)) };
    }
  };
}

describe('batchGetByIds', () => {
  it('returns a map of id -> item', async () => {
    const db = mockDynamo(params => ({
      Responses: { t: params.RequestItems.t.Keys.map(k => ({ id: k.id, name: `n-${k.id}` })) }
    }));
    const map = await batchGetByIds(db, 't', ['a', 'b']);
    expect(map).toEqual({ a: { id: 'a', name: 'n-a' }, b: { id: 'b', name: 'n-b' } });
  });

  it('dedupes ids and skips falsy ids', async () => {
    const db = mockDynamo(params => ({
      Responses: { t: params.RequestItems.t.Keys.map(k => ({ id: k.id })) }
    }));
    await batchGetByIds(db, 't', ['a', 'a', null, undefined, 'b', '']);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].RequestItems.t.Keys).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('chunks requests at 25 keys (BatchGetItem limit)', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `id-${i}`);
    const db = mockDynamo(params => ({
      Responses: { t: params.RequestItems.t.Keys.map(k => ({ id: k.id })) }
    }));
    const map = await batchGetByIds(db, 't', ids);
    expect(db.calls).toHaveLength(3);
    expect(db.calls.map(c => c.RequestItems.t.Keys.length)).toEqual([25, 25, 10]);
    expect(Object.keys(map)).toHaveLength(60);
  });

  it('retries UnprocessedKeys', async () => {
    let first = true;
    const db = mockDynamo(params => {
      if (first) {
        first = false;
        return {
          Responses: { t: [{ id: 'a' }] },
          UnprocessedKeys: { t: { Keys: [{ id: 'b' }] } }
        };
      }
      return { Responses: { t: params.RequestItems.t.Keys.map(k => ({ id: k.id })) } };
    });
    const map = await batchGetByIds(db, 't', ['a', 'b']);
    expect(map).toEqual({ a: { id: 'a' }, b: { id: 'b' } });
    expect(db.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty map for empty input without calling dynamo', async () => {
    const db = mockDynamo(() => ({ Responses: { t: [] } }));
    expect(await batchGetByIds(db, 't', [])).toEqual({});
    expect(db.calls).toHaveLength(0);
  });
});
