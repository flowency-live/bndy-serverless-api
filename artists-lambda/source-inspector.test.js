'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractFacebookUrl,
  canonicalFacebookUrl,
  isSafeFetchUrl,
  parseFacebookMetadata,
  inspectFacebookSource,
} = require('./source-inspector');

function fakeClient(sequence) {
  let index = 0;
  return {
    get() {
      const value = sequence[index++];
      return { promise: async () => value || {} };
    },
  };
}

test('extractFacebookUrl accepts a clean Facebook URL', () => {
  assert.equal(
    extractFacebookUrl('https://www.facebook.com/TheExampleBand/'),
    'https://www.facebook.com/TheExampleBand/'
  );
});

test('extractFacebookUrl finds Facebook URL inside pasted share text', () => {
  const result = extractFacebookUrl('The Example Band — https://m.facebook.com/TheExampleBand/?ref=share come see this');
  assert.ok(result);
  assert.equal(new URL(result).hostname, 'm.facebook.com');
});

test('extractFacebookUrl rejects Facebook lookalike hosts', () => {
  assert.equal(extractFacebookUrl('https://facebook.com.evil.example/theband'), null);
  assert.equal(extractFacebookUrl('https://evil.example/facebook.com/theband'), null);
});

test('canonicalFacebookUrl uses the canonical identity key', () => {
  assert.equal(
    canonicalFacebookUrl('https://m.facebook.com/profile.php?id=123456789&ref=share'),
    'https://www.facebook.com/123456789'
  );
  assert.equal(
    canonicalFacebookUrl('https://fb.me/TheExampleBand/?ref=share'),
    'https://www.facebook.com/theexampleband'
  );
});

test('safe Facebook fetch URL does not allow arbitrary ports or hosts', () => {
  assert.equal(isSafeFetchUrl('https://www.facebook.com/theband'), true);
  assert.equal(isSafeFetchUrl('https://www.facebook.com:444/theband'), false);
  assert.equal(isSafeFetchUrl('https://facebook.com.evil.example/theband'), false);
  assert.equal(isSafeFetchUrl('http://www.facebook.com/theband'), false);
});

test('parseFacebookMetadata extracts only observed Open Graph data', () => {
  const html = `
    <html><head>
      <meta property="og:title" content="The Example Band | Facebook">
      <meta content="Official page for The Example Band" property="og:description">
      <meta property="og:image" content="https://scontent-lhr8-1.xx.fbcdn.net/example.jpg">
      <meta property="og:url" content="https://www.facebook.com/TheExampleBand/">
    </head></html>`;

  const parsed = parseFacebookMetadata(html, 'https://www.facebook.com/theexampleband');
  assert.equal(parsed.observed.name, 'The Example Band');
  assert.equal(parsed.observed.description, 'Official page for The Example Band');
  assert.equal(parsed.observed.imageUrl, 'https://scontent-lhr8-1.xx.fbcdn.net/example.jpg');
  assert.equal(parsed.evidence.name, 'facebook_html_meta');
});

test('parseFacebookMetadata ignores generic Facebook login titles', () => {
  const parsed = parseFacebookMetadata(
    '<meta property="og:title" content="Facebook – log in or sign up">',
    'https://www.facebook.com/example'
  );
  assert.equal(parsed.observed.name, null);
});

test('inspectFacebookSource returns an existing artist without fetching Facebook', async () => {
  let fetched = false;
  const client = fakeClient([
    { Item: { key: 'artist#fb#facebook.com/theexampleband', refId: 'artist-123' } },
    { Item: { id: 'artist-123', name: 'The Example Band', location: 'Macclesfield', profileImageUrl: 'https://example.test/a.jpg' } },
  ]);

  const result = await inspectFacebookSource({
    input: 'https://facebook.com/TheExampleBand',
    expectedType: 'artist',
    client,
    fetchHtml: async () => {
      fetched = true;
      throw new Error('should not fetch');
    },
  });

  assert.equal(fetched, false);
  assert.equal(result.existing.id, 'artist-123');
  assert.equal(result.existing.name, 'The Example Band');
  assert.equal(result.inspected, false);
});

test('inspectFacebookSource returns observed metadata for an unknown artist', async () => {
  const client = fakeClient([{}]);
  const result = await inspectFacebookSource({
    input: 'Shared from https://www.facebook.com/NewExampleBand?ref=share',
    expectedType: 'artist',
    client,
    fetchHtml: async (url) => ({
      statusCode: 200,
      finalUrl: url,
      html: '<meta property="og:title" content="New Example Band | Facebook"><meta property="og:image" content="https://lookaside.fbsbx.com/example.jpg">',
    }),
  });

  assert.equal(result.existing, null);
  assert.equal(result.observed.name, 'New Example Band');
  assert.equal(result.observed.imageUrl, 'https://lookaside.fbsbx.com/example.jpg');
  assert.deepEqual(result.warnings, []);
});

test('inspection failure is graceful and preserves canonical Facebook identity', async () => {
  const client = fakeClient([{}]);
  const result = await inspectFacebookSource({
    input: 'https://facebook.com/NewExampleBand',
    expectedType: 'artist',
    client,
    fetchHtml: async () => {
      const error = new Error('blocked');
      error.code = 'FETCH_BLOCKED';
      throw error;
    },
  });

  assert.equal(result.valid, true);
  assert.equal(result.facebookKey, 'facebook.com/newexampleband');
  assert.equal(result.facebookUrl, 'https://www.facebook.com/newexampleband');
  assert.deepEqual(result.warnings, ['FETCH_BLOCKED']);
});

test('venue inspection does not query artist identity', async () => {
  let gets = 0;
  const client = {
    get() {
      gets += 1;
      return { promise: async () => ({}) };
    },
  };
  const result = await inspectFacebookSource({
    input: 'https://facebook.com/TheVenue',
    expectedType: 'venue',
    client,
    fetchHtml: async (url) => ({ statusCode: 200, finalUrl: url, html: '<meta property="og:title" content="The Venue | Facebook">' }),
  });

  assert.equal(gets, 0);
  assert.equal(result.observed.name, 'The Venue');
});
