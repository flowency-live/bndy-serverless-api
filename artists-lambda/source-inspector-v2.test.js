'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const test = typeof globalThis.test === 'function' ? globalThis.test : nodeTest.test;
const base = require('./source-inspector');
const {
  handleFromFacebookKey,
  nameHintFromHandle,
  readHtmlTitle,
  enrichInspectionResult,
} = require('./source-inspector-v2');

test('handleFromFacebookKey accepts stable handles and ids only', () => {
  assert.equal(handleFromFacebookKey('facebook.com/soulskunks'), 'soulskunks');
  assert.equal(handleFromFacebookKey('facebook.com/123456789'), '123456789');
  assert.equal(handleFromFacebookKey('facebook.com/share/abc'), null);
  assert.equal(handleFromFacebookKey('evil.example/soulskunks'), null);
});

test('nameHintFromHandle creates an explicitly unverified display hint', () => {
  assert.equal(nameHintFromHandle('soulskunks'), 'Soulskunks');
  assert.equal(nameHintFromHandle('the.soul.skunks'), 'The Soul Skunks');
  assert.equal(nameHintFromHandle('123456789'), null);
});

test('readHtmlTitle accepts real Facebook page titles and rejects login shells', () => {
  assert.equal(readHtmlTitle('<title>Soulskunks | Facebook</title>'), 'Soulskunks');
  assert.equal(readHtmlTitle('<title>Facebook – log in or sign up</title>'), null);
});

test('existing artist lookup aliases DynamoDB reserved projection fields', async () => {
  let artistGetParams = null;
  const client = {
    get(params) {
      if (params.TableName === 'bndy-unique-keys') {
        return { promise: async () => ({ Item: { refId: 'artist-1' } }) };
      }
      artistGetParams = params;
      return { promise: async () => ({ Item: { id: 'artist-1', name: 'Soulskunks' } }) };
    },
  };

  const artist = await base.findExistingArtistByFacebookKey('facebook.com/soulskunks', client);
  assert.equal(artist.name, 'Soulskunks');
  assert.ok(artistGetParams);
  assert.match(artistGetParams.ProjectionExpression, /#hidden/);
  assert.match(artistGetParams.ProjectionExpression, /#deleted/);
  assert.equal(artistGetParams.ExpressionAttributeNames['#hidden'], 'hidden');
  assert.equal(artistGetParams.ExpressionAttributeNames['#deleted'], 'deleted');
  assert.doesNotMatch(artistGetParams.ProjectionExpression, /(?:^|,\s*)hidden(?:\s*,|$)/);
  assert.doesNotMatch(artistGetParams.ProjectionExpression, /(?:^|,\s*)deleted(?:\s*,|$)/);
});

test('enrichInspectionResult uses mbasic title and Graph picture when primary metadata is barren', async () => {
  const baseResult = {
    source: 'facebook',
    valid: true,
    identityResolved: true,
    facebookUrl: 'https://www.facebook.com/soulskunks',
    facebookKey: 'facebook.com/soulskunks',
    existing: null,
    observed: {
      name: null,
      imageUrl: null,
      description: null,
      canonicalUrl: 'https://www.facebook.com/soulskunks',
      location: null,
      address: null,
      websiteUrl: null,
    },
    evidence: { canonicalUrl: 'facebook_identity' },
    warnings: [],
  };

  const enriched = await enrichInspectionResult(baseResult, {
    expectedType: 'artist',
    fetchHtml: async () => ({
      statusCode: 200,
      finalUrl: 'https://mbasic.facebook.com/soulskunks',
      html: '<html><head><title>Soulskunks | Facebook</title><meta name="description" content="Soul and ska band"></head></html>',
    }),
    fetchPicture: async () => 'https://scontent-lhr8-1.xx.fbcdn.net/soulskunks.jpg',
  });

  assert.equal(enriched.observed.name, 'Soulskunks');
  assert.equal(enriched.evidence.name, 'facebook_basic_html');
  assert.equal(enriched.observed.description, 'Soul and ska band');
  assert.equal(enriched.observed.imageUrl, 'https://scontent-lhr8-1.xx.fbcdn.net/soulskunks.jpg');
  assert.equal(enriched.evidence.imageUrl, 'facebook_graph_picture');
});

test('enrichInspectionResult falls back to a handle hint but never marks it verified', async () => {
  const baseResult = {
    source: 'facebook',
    valid: true,
    identityResolved: true,
    facebookUrl: 'https://www.facebook.com/soulskunks',
    facebookKey: 'facebook.com/soulskunks',
    existing: null,
    observed: { name: null, imageUrl: null, description: null },
    evidence: {},
    warnings: [],
  };

  const enriched = await enrichInspectionResult(baseResult, {
    expectedType: 'artist',
    fetchHtml: async () => ({ statusCode: 200, finalUrl: 'https://mbasic.facebook.com/soulskunks', html: '<title>Facebook</title>' }),
    fetchPicture: async () => null,
  });

  assert.equal(enriched.observed.name, 'Soulskunks');
  assert.equal(enriched.evidence.name, 'facebook_handle_hint');
  assert.equal(enriched.observed.imageUrl, null);
});

test('existing artists are not enriched or network-fetched again', async () => {
  let called = false;
  const existing = {
    valid: true,
    identityResolved: true,
    facebookKey: 'facebook.com/soulskunks',
    existing: { entityType: 'artist', id: 'artist-1', name: 'Soulskunks' },
    observed: { name: 'Soulskunks' },
    evidence: { name: 'bndy_existing_artist' },
  };

  const result = await enrichInspectionResult(existing, {
    expectedType: 'artist',
    fetchHtml: async () => { called = true; throw new Error('should not fetch'); },
    fetchPicture: async () => { called = true; return null; },
  });

  assert.equal(result, existing);
  assert.equal(called, false);
});
