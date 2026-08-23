'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { gatedPut, releaseUniqueKeys } = require('./unique-gate');

test('gatedPut deduplicates exact sentinel keys before transacting', async () => {
  const calls = [];
  const dynamodb = {
    transactWrite(params) {
      calls.push(params);
      return { promise: async () => ({}) };
    }
  };
  const previousMode = process.env.GATE_MODE;
  process.env.GATE_MODE = 'enforce';
  try {
    const key = 'artist#black-dyke-band#yorkshire';
    const result = await gatedPut(dynamodb, {
      tableName: 'bndy-artists',
      item: { id: 'artist-1', name: 'Black Dyke Band' },
      keys: [key, key],
      entityType: 'artist'
    });

    assert.equal(result.written, true);
    assert.equal(calls.length, 1);
    const puts = calls[0].TransactItems.map((entry) => entry.Put);
    assert.equal(puts.filter((put) => put.TableName === 'bndy-unique-keys' && put.Item.key === key).length, 1);
    assert.equal(puts.filter((put) => put.TableName === 'bndy-artists').length, 1);
  } finally {
    if (previousMode === undefined) delete process.env.GATE_MODE;
    else process.env.GATE_MODE = previousMode;
  }
});

test('releaseUniqueKeys deletes duplicate inputs once', async () => {
  const calls = [];
  const dynamodb = {
    delete(params) {
      calls.push(params);
      return { promise: async () => ({}) };
    }
  };
  await releaseUniqueKeys(dynamodb, ['artist#one', 'artist#one'], 'artist-1');
  assert.equal(calls.length, 1);
});
