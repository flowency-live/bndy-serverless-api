'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isPublishedInEdition, hasPrivilegedIngestionFields, validateScopedIngestion } = require('./edition-domain');

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

test('scoped ingestion fields and edition values are closed sets', () => {
  assert.equal(hasPrivilegedIngestionFields({ name: 'Legacy' }), false);
  assert.equal(hasPrivilegedIngestionFields({ publicationScopes: ['brass'] }), true);
  assert.match(validateScopedIngestion({ performerKind: 'brass_band' }, 'artist'), /publicationScopes is required/);
  assert.equal(validateScopedIngestion({ publicationScopes: ['brass'], discoveryScopes: [] }, 'venue'), null);
  assert.match(validateScopedIngestion({ publicationScopes: ['unknown'] }, 'artist'), /unknown edition/);
  assert.match(validateScopedIngestion({ publicationScopes: [] }, 'event'), /at least one edition/);
  assert.match(validateScopedIngestion({ publicationScopes: ['brass'], discoveryScopes: ['brass'], performerKind: 'ordinary_band' }, 'artist'), /brass_band/);
});
