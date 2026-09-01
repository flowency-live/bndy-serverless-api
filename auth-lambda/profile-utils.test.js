'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanDisplayName, displayNameFromClaims } = require('./profile-utils');

test('uses the social identity name claim', () => {
  assert.equal(displayNameFromClaims({ name: '  Jo   Bloggs  ' }), 'Jo Bloggs');
});

test('falls back to given and family names', () => {
  assert.equal(displayNameFromClaims({ given_name: 'Jo', family_name: 'Bloggs' }), 'Jo Bloggs');
});

test('removes control characters and bounds the stored name', () => {
  assert.equal(cleanDisplayName(`Jo\u0000 ${'x'.repeat(200)}`).length, 120);
});
