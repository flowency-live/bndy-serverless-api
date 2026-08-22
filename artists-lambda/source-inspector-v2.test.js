'use strict';

const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const test = typeof globalThis.test === 'function' ? globalThis.test : nodeTest.test;
const base = require('./source-inspector');
const {
  handleFromFacebookKey,
  nameHintFromHandle,
  unwrapGroupMemberProfileInput,
  readHtmlTitle,
  enrichInspectionResult,
  inspectFacebookSourceV2,
} = require('./source-inspector-v2');

function fakeClient(sequence) {
  let index = 0;
  return {
    get() {
      const value = sequence[index++];
      return { promise: async () => value || {} };
    },
  };
}

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

test('readHtmlTitle accepts real Facebook page titles and rejects generic shells', () => {
  assert.equal(readHtmlTitle('<title>Soulskunks | Facebook</title>'), 'Soulskunks');
  assert.equal(readHtmlTitle('<title>Facebook – log in or sign up</title>'), null);
  assert.equal(readHtmlTitle('<title>Error</title>'), null);
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

test('group-member wrapper resolves embedded numeric profile and inspects canonical profile URL', async () => {
  const input = 'https://www.facebook.com/groups/257127181399411/user/100095600102594';
  assert.deepEqual(base.groupMemberProfileIdentity(input), {
    key: 'facebook.com/100095600102594',
    url: 'https://www.facebook.com/100095600102594',
  });
  assert.equal(base.canonicalFacebookUrl(input), 'https://www.facebook.com/100095600102594');

  let fetchedUrl = null;
  const result = await base.inspectFacebookSource({
    input,
    expectedType: 'artist',
    client: fakeClient([{}]),
    fetchHtml: async (url) => {
      fetchedUrl = url;
      return {
        statusCode: 200,
        finalUrl: url,
        html: '<meta property="og:title" content="Example Artist | Facebook">',
      };
    },
  });

  assert.equal(fetchedUrl, 'https://www.facebook.com/100095600102594');
  assert.equal(result.facebookKey, 'facebook.com/100095600102594');
  assert.equal(result.facebookUrl, 'https://www.facebook.com/100095600102594');
  assert.equal(result.observed.name, 'Example Artist');
  assert.ok(result.sourceUrl.includes('/groups/257127181399411/user/100095600102594'));
});

test('v2 rewrites group-member wrapper before inspection and preserves original input', async () => {
  const input = 'https://www.facebook.com/groups/257127181399411/user/100095600102594';
  assert.equal(unwrapGroupMemberProfileInput(input), 'https://www.facebook.com/100095600102594');

  let fetchedUrl = null;
  const result = await inspectFacebookSourceV2({
    input,
    expectedType: 'artist',
    client: fakeClient([{}]),
    fetchHtml: async (url) => {
      fetchedUrl = url;
      return {
        statusCode: 200,
        finalUrl: url,
        html: '<meta property="og:title" content="Example Artist | Facebook">',
      };
    },
    fetchPicture: async () => null,
  });

  assert.equal(fetchedUrl, 'https://www.facebook.com/100095600102594');
  assert.equal(result.input, input);
  assert.equal(result.facebookKey, 'facebook.com/100095600102594');
  assert.equal(result.facebookUrl, 'https://www.facebook.com/100095600102594');
  assert.equal(result.observed.name, 'Example Artist');
  assert.equal(result.evidence.canonicalUrl, 'facebook_group_member_profile');
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

test('generic Facebook Error metadata is discarded before handle fallback', async () => {
  const baseResult = {
    source: 'facebook',
    valid: true,
    identityResolved: true,
    facebookUrl: 'https://www.facebook.com/thecurrantsband',
    facebookKey: 'facebook.com/thecurrantsband',
    existing: null,
    observed: {
      name: 'Error',
      imageUrl: 'https://scontent-lhr8-1.xx.fbcdn.net/currants.jpg',
      description: 'See posts, photos and more on Facebook.',
      canonicalUrl: 'https://www.facebook.com/thecurrantsband',
    },
    evidence: {
      name: 'facebook_html_meta',
      imageUrl: 'facebook_html_meta',
      description: 'facebook_html_meta',
      canonicalUrl: 'facebook_identity',
    },
    warnings: [],
  };

  const enriched = await enrichInspectionResult(baseResult, {
    expectedType: 'artist',
    fetchHtml: async () => ({
      statusCode: 200,
      finalUrl: 'https://mbasic.facebook.com/thecurrantsband',
      html: '<title>Error</title><meta name="description" content="See posts, photos and more on Facebook.">',
    }),
    fetchPicture: async () => null,
  });

  assert.equal(enriched.observed.name, 'Thecurrantsband');
  assert.equal(enriched.evidence.name, 'facebook_handle_hint');
  assert.equal(enriched.observed.description, null);
  assert.equal(enriched.evidence.description, undefined);
  assert.equal(enriched.observed.imageUrl, 'https://scontent-lhr8-1.xx.fbcdn.net/currants.jpg');
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
