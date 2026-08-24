'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const test = typeof globalThis.test === 'function' ? globalThis.test : nodeTest.test;
const {
  handler,
  PREVIEW_USER_AGENT,
  appendBoundedChunk,
  fetchFacebookPreviewHtml,
} = require('./source-inspector-v3');

test('public metadata transport uses Facebook link-preview representation', () => {
  assert.match(PREVIEW_USER_AGENT, /^facebookexternalhit\/1\.1/);
});

test('oversized Facebook HTML keeps a parseable bounded prefix', () => {
  const chunks = [Buffer.from('abc')];
  const result = appendBoundedChunk(chunks, Buffer.from('defgh'), 3, 5);

  assert.deepEqual(result, { total: 5, truncated: true });
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'abcde');
});

test('public metadata transport preserves the Facebook-only fetch boundary', async () => {
  await assert.rejects(
    () => fetchFacebookPreviewHtml('https://evil.example/facebook.com/not-a-page'),
    (error) => error && error.code === 'UNSAFE_URL',
  );
});

test('v3 handler keeps hostile non-Facebook input rejected before network inspection', async () => {
  const result = await handler({
    body: JSON.stringify({
      input: 'https://evil.example/facebook.com/not-a-page',
      expectedType: 'artist',
    }),
  });

  assert.equal(result.statusCode, 422);
  const body = JSON.parse(result.body);
  assert.equal(body.code, 'NOT_FACEBOOK_URL');
});
