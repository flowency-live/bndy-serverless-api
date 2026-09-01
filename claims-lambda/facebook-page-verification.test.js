'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('./facebook-page-verification');

const secret = 'test-secret-that-is-long-enough';

test('allows only exact bndy and local return origins', () => {
  assert.equal(helper.validateTargetOrigin('https://bndy.live/claim'), 'https://bndy.live');
  assert.equal(helper.validateTargetOrigin('https://stage.bndy.live/path'), 'https://stage.bndy.live');
  assert.equal(helper.validateTargetOrigin('https://bndy.live.attacker.example'), null);
});

test('sanitises and deduplicates managed Pages without leaking access tokens', () => {
  const pages = helper.sanitisePages([
    { id: '12345', name: 'Torrirsts', tasks: ['MANAGE'], access_token: 'secret' },
    { id: '12345', name: 'Duplicate' },
    { id: 'bad', name: 'Invalid' },
  ]);
  assert.deepEqual(pages, [{ id: '12345', name: 'Torrirsts', tasks: ['MANAGE'], pageUrl: 'https://www.facebook.com/12345' }]);
  assert.equal(JSON.stringify(pages).includes('secret'), false);
});

test('receipt is bound to user, entity and selected managed Page', () => {
  const token = helper.signReceipt({
    receiptId: 'receipt-id', userId: 'user-1', entityType: 'artist', entityId: 'artist-1',
    pages: [{ id: '12345' }], secret,
  });
  assert.deepEqual(helper.verifyReceipt({ token, selectedPageId: '12345', userId: 'user-1', entityType: 'artist', entityId: 'artist-1', secret }), { receiptId: 'receipt-id', pageId: '12345' });
  assert.throws(() => helper.verifyReceipt({ token, selectedPageId: '99999', userId: 'user-1', entityType: 'artist', entityId: 'artist-1', secret }));
});

test('OAuth state is opaque and long enough', () => {
  const state = helper.generateOpaqueState();
  assert.match(state, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(state.includes('artist'), false);
});

test('entity matching trusts only a stable numeric Facebook Page ID', () => {
  assert.equal(helper.entityPageMatch({ facebookUrl: 'https://facebook.com/12345' }, '12345'), 'stable_page_id');
  assert.equal(helper.entityPageMatch({ facebookUrl: 'https://facebook.com/torrirsts' }, '12345'), 'review_required');
});

test('callback HTML escapes script-breaking payload and pins the target origin', () => {
  const html = helper.callbackHtml('https://bndy.live/path', { ok: false, error: '</script><script>alert(1)</script>' });
  assert.equal(html.includes('</script><script>alert(1)</script>'), false);
  assert.match(html, /https:\/\/bndy\.live/);
});
