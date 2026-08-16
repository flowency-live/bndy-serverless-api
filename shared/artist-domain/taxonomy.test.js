'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const taxonomy = require('./taxonomy');

test('public taxonomy exposes only active selectable values', () => {
  const published = taxonomy.publicTaxonomy();
  assert.equal(published.version, taxonomy.TAXONOMY_VERSION);
  assert.deepEqual(published.genres, taxonomy.GENRES);
  assert.deepEqual(published.artistTypes, taxonomy.ARTIST_TYPES);
  assert.deepEqual(published.actTypes, taxonomy.ACT_TYPES);
  assert.ok(!published.genres.includes('Hardcore'));
  assert.ok(!published.genres.includes('80s'));
  assert.ok(!published.actTypes.some((option) => option.value === 'acoustic'));
  assert.ok(published.performanceCapabilities.some((option) => option.value === 'acoustic' && option.field === 'acoustic'));
});

test('artist types converge labels and machine values to canonical machine values', () => {
  assert.equal(taxonomy.normaliseArtistType('band'), 'band');
  assert.equal(taxonomy.normaliseArtistType('Band'), 'band');
  assert.equal(taxonomy.normaliseArtistType('Solo Act'), 'solo');
  assert.equal(taxonomy.normaliseArtistType('TRIO'), 'trio');
  assert.equal(taxonomy.normaliseArtistType('not-a-type'), null);
});

test('act types keep acoustic out of the actType dimension', () => {
  const result = taxonomy.normaliseActTypes(['Covers', 'Tribute Act', 'Acoustic']);
  assert.deepEqual(result.valid, ['covers', 'tribute']);
  assert.equal(result.acoustic, true);
  assert.deepEqual(result.invalid, []);
});

test('genre compatibility preserves retired stored values but does not make them active choices', () => {
  assert.equal(taxonomy.normaliseGenre('Hardcore'), 'Hardcore');
  assert.equal(taxonomy.normaliseGenre('80s'), '80s');
  assert.equal(taxonomy.normaliseGenre('Hardcore', { allowLegacy: false }), null);
  assert.equal(taxonomy.normaliseGenre('classic rock'), 'Rock');
  assert.equal(taxonomy.normaliseGenre('rnb'), 'R&B');
});

test('classification migrates historical acoustic pseudo-act without losing meaning', () => {
  const result = taxonomy.normaliseClassification({
    artistType: 'Solo Act',
    actType: ['Originals', 'Acoustic']
  });
  assert.equal(result.artistType, 'solo');
  assert.deepEqual(result.actType, ['originals']);
  assert.equal(result.acoustic, true);
  assert.equal(result.acousticFromLegacyActType, true);
});

test('all active lambda copies are byte-identical to the canonical taxonomy', () => {
  const canonical = fs.readFileSync(path.join(__dirname, 'taxonomy.js'), 'utf8');
  const copies = [
    '../../artists-lambda/lib/taxonomy.js',
    '../../events-agent-lambda/lib/taxonomy.js',
    '../../users-lambda/lib/taxonomy.js'
  ];
  for (const rel of copies) {
    assert.equal(fs.readFileSync(path.join(__dirname, rel), 'utf8'), canonical, rel);
  }
});
