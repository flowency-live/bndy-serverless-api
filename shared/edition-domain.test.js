'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isPublishedInEdition } = require('./edition-domain');

const cases = [
  [{}, true, false],
  [{ publicationScopes: [] }, true, false],
  [{ publicationScopes: ['live'] }, true, false],
  [{ publicationScopes: ['brass'] }, false, true],
  [{ publicationScopes: ['live', 'brass'] }, true, true]
];

test('publication scope contract', async (t) => {
  for (const [record, live, brass] of cases) {
    await t.test(JSON.stringify(record), () => {
      assert.equal(isPublishedInEdition(record, 'live'), live);
      assert.equal(isPublishedInEdition(record, 'brass'), brass);
    });
  }
});
