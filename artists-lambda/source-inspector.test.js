'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert/strict');
// The artists Lambda suite runs Jest, while the root predeploy script runs this
// file with `node --test`. Register with whichever runner owns the process.
const test = typeof globalThis.test === 'function' ? globalThis.test : nodeTest.test;
const {
  extractFacebookUrl,
  canonicalFacebookUrl,
  isTransientFacebookKey,
  stableFacebookIdentity,
  isSafeFetchUrl,
  toSafeFetchUrl,
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

test('extractFacebookUrl preserves transient share token case and query for resolution', () => {
  const result = extractFacebookUrl('Shared https://www.facebook.com/share/AbCdEf123/?mibextid=wwXIfr thanks');
  assert.ok(result);
  const parsed = new URL(result);
  assert.equal(parsed.pathname, '/share/AbCdEf123/');
  assert.equal(parsed.searchParams.get('mibextid'), 'wwXIfr');
});

test('extractFacebookUrl rejects Facebook lookalike hosts', () => {
  assert.equal(extractFacebookUrl('https://facebook.com.evil.example/theband'), null);
  assert.equal(extractFacebookUrl('https://evil.example/facebook.com/theband'), null);
});

test('canonicalFacebookUrl uses the canonical stable identity key', () => {
  assert.equal(
    canonicalFacebookUrl('https://m.facebook.com/profile.php?id=123456789&ref=share'),
    'https://www.facebook.com/123456789'
  );
  assert.equal(
    canonicalFacebookUrl('https://fb.me/TheExampleBand/?ref=share'),
    'https://www.facebook.com/theexampleband'
  );
});

test('transient Facebook links are not accepted as entity identity', () => {
  assert.equal(isTransientFacebookKey('facebook.com/share/abcdef'), true);
  assert.equal(isTransientFacebookKey('facebook.com/posts/123456'), true);
  assert.equal(isTransientFacebookKey('facebook.com/theexampleband'), false);
  assert.equal(canonicalFacebookUrl('https://www.facebook.com/share/AbCdEf123/?mibextid=wwXIfr'), null);
  assert.equal(stableFacebookIdentity('https://www.facebook.com/share/AbCdEf123/'), null);
});

test('safe Facebook fetch URL does not allow arbitrary ports or hosts', () => {
  assert.equal(isSafeFetchUrl('https://www.facebook.com/theband'), true);
  assert.equal(isSafeFetchUrl('https://fb.me/theband'), true);
  assert.equal(isSafeFetchUrl('https://www.facebook.com:444/theband'), false);
  assert.equal(isSafeFetchUrl('https://facebook.com.evil.example/theband'), false);
  assert.equal(isSafeFetchUrl('http://www.facebook.com/theband'), false);
});

test('toSafeFetchUrl upgrades allowed http input without changing the share token', () => {
  assert.equal(
    toSafeFetchUrl('http://www.facebook.com/share/AbCdEf123/?mibextid=wwXIfr'),
    'https://www.facebook.com/share/AbCdEf123/?mibextid=wwXIfr'
  );
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
  assert.equal(result.facebookKey, 'facebook.com/theexampleband');
});

test('inspectFacebookSource returns observed metadata for an unknown direct artist', async () => {
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
  assert.equal(result.facebookKey, 'facebook.com/newexampleband');
  assert.equal(result.identityResolved, true);
  assert.deepEqual(result.warnings, []);
});

test('inspection failure is graceful and preserves a direct stable Facebook identity', async () => {
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
  assert.equal(result.identityResolved, true);
  assert.deepEqual(result.warnings, ['FETCH_BLOCKED']);
});

test('share URL resolves to canonical page identity and then finds an existing artist', async () => {
  let fetchedUrl = null;
  const client = fakeClient([
    { Item: { key: 'artist#fb#facebook.com/theexampleband', refId: 'artist-123' } },
    { Item: { id: 'artist-123', name: 'The Example Band', location: 'Macclesfield' } },
  ]);

  const result = await inspectFacebookSource({
    input: 'Copied from Facebook https://www.facebook.com/share/AbCdEf123/?mibextid=wwXIfr',
    expectedType: 'artist',
    client,
    fetchHtml: async (url) => {
      fetchedUrl = url;
      return {
        statusCode: 200,
        finalUrl: 'https://www.facebook.com/TheExampleBand/',
        html: '<meta property="og:title" content="The Example Band | Facebook">',
      };
    },
  });

  assert.equal(new URL(fetchedUrl).pathname, '/share/AbCdEf123/');
  assert.equal(result.existing.id, 'artist-123');
  assert.equal(result.facebookKey, 'facebook.com/theexampleband');
  assert.equal(result.facebookUrl, 'https://www.facebook.com/theexampleband');
  assert.equal(result.identityResolved, true);
});

test('share URL can resolve identity from observed og:url', async () => {
  const client = fakeClient([{}]);
  const result = await inspectFacebookSource({
    input: 'https://www.facebook.com/share/AbCdEf123/?mibextid=wwXIfr',
    expectedType: 'artist',
    client,
    fetchHtml: async (url) => ({
      statusCode: 200,
      finalUrl: url,
      html: '<meta property="og:title" content="New Example Band | Facebook"><meta property="og:url" content="https://www.facebook.com/NewExampleBand/">',
    }),
  });

  assert.equal(result.existing, null);
  assert.equal(result.facebookKey, 'facebook.com/newexampleband');
  assert.equal(result.facebookUrl, 'https://www.facebook.com/newexampleband');
  assert.equal(result.observed.name, 'New Example Band');
  assert.equal(result.identityResolved, true);
});

test('unresolved share URL is never returned as an artist Facebook identity', async () => {
  const client = fakeClient([]);
  const result = await inspectFacebookSource({
    input: 'https://www.facebook.com/share/AbCdEf123/?mibextid=wwXIfr',
    expectedType: 'artist',
    client,
    fetchHtml: async () => {
      const error = new Error('blocked');
      error.code = 'FETCH_BLOCKED';
      throw error;
    },
  });

  assert.equal(result.facebookKey, null);
  assert.equal(result.facebookUrl, null);
  assert.equal(result.identityResolved, false);
  assert.ok(result.sourceUrl.includes('/share/AbCdEf123/'));
  assert.deepEqual(result.warnings, ['FETCH_BLOCKED', 'facebook_identity_unresolved']);
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
  assert.equal(result.facebookKey, 'facebook.com/thevenue');
});
