'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  enrichSparseFacebookResult,
  mergeBacklineEnrichment,
  shouldUseBacklineAssist,
} = require('./source-inspector-backline');

function sparse() {
  return {
    ok: true,
    facebookUrl: 'https://www.facebook.com/ahundredendings',
    facebookKey: 'ahundredendings',
    identityResolved: true,
    existing: null,
    observed: { name: 'Ahundredendings', imageUrl: 'https://graph.facebook.com/ahundredendings/picture' },
    evidence: { name: 'facebook_handle_hint', imageUrl: 'facebook_graph_picture' },
    warnings: [],
  };
}

const grounded = {
  name: 'A Hundred Endings',
  location: 'Stoke-on-Trent',
  bio: 'Alternative rock band from Stoke-on-Trent.',
  websiteUrl: 'https://ahundredendings.com',
  artistType: 'Band',
  actTypes: ['Originals'],
  genres: ['Alternative', 'Rock'],
  acoustic: false,
  confidence: 0.96,
  nameEvidenceUrls: ['https://www.facebook.com/ahundredendings'],
  locationEvidenceUrls: ['https://ahundredendings.com/about'],
  bioEvidenceUrls: ['https://ahundredendings.com/about'],
  websiteEvidenceUrls: ['https://ahundredendings.com'],
  classificationEvidenceUrls: ['https://ahundredendings.com/about'],
};

test('sparse resolved artist pages use Backline but rich/existing pages do not', () => {
  assert.equal(shouldUseBacklineAssist(sparse(), 'artist'), true);
  assert.equal(shouldUseBacklineAssist({ ...sparse(), existing: { id: 'a1' } }, 'artist'), false);
  assert.equal(shouldUseBacklineAssist(sparse(), 'venue'), false);
});

test('A Hundred Endings regression: grounded fields replace the handle hint', async () => {
  const result = await enrichSparseFacebookResult(sparse(), {
    expectedType: 'artist',
    discover: async (url) => {
      assert.equal(url, 'https://www.facebook.com/ahundredendings');
      return grounded;
    },
  });
  assert.equal(result.observed.name, 'A Hundred Endings');
  assert.equal(result.observed.location, 'Stoke-on-Trent');
  assert.equal(result.observed.artistType, 'Band');
  assert.deepEqual(result.observed.actTypes, ['Originals']);
  assert.deepEqual(result.observed.genres, ['Alternative', 'Rock']);
  assert.equal(result.evidence.name, 'backline_grounded_search');
  assert.equal(result.backlineAssist.status, 'enriched');
});

test('grounded search cannot overwrite trusted HTML fields', () => {
  const result = mergeBacklineEnrichment({
    ...sparse(),
    observed: { ...sparse().observed, location: 'Manchester' },
    evidence: { ...sparse().evidence, location: 'facebook_about_html' },
  }, grounded);
  assert.equal(result.observed.location, 'Manchester');
});

test('assist failure preserves deterministic result', async () => {
  const result = await enrichSparseFacebookResult(sparse(), {
    expectedType: 'artist',
    discover: async () => { throw new Error('nope'); },
  });
  assert.equal(result.observed.name, 'Ahundredendings');
  assert.ok(result.warnings.includes('backline_assist_failed'));
});
