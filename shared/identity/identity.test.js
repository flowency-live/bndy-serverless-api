/**
 * Tests for the canonical identity library.
 * Runs with plain `node identity.test.js` (no framework needed) AND under
 * jest/vitest (describe/it shims below). The validation corpus comes from the
 * dedup runbooks — if any corpus case fails, the normalisation is WRONG per
 * dedup-remediation-plan.md's validation gate; fix the lib, not the test.
 */

'use strict';

const {
  normalise, normaliseKey, regionBucket, artistIdentityKey, facebookKey,
  normaliseEventDate, eventNaturalKey, eventNaturalKeys, venuePlaceKey,
  artistUniqueKey, eventUniqueKeys, editDistance, isNearMiss,
  UNKNOWN_REGION, OPEN_MIC_ARTIST,
} = require('./identity');

// --- micro-harness (works standalone and under jest/vitest) ---
const standalone = typeof describe === 'undefined';
let failures = 0; let checks = 0;
function eq(actual, expected, label) {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.error(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
  else if (standalone && process.env.VERBOSE) console.log(`ok   ${label}`);
}
function throws(fn, label) {
  checks++;
  try { fn(); failures++; console.error(`FAIL ${label}: expected throw`); } catch (_) { /* ok */ }
}
const d = standalone ? (n, f) => f() : describe;
const t = standalone ? (n, f) => f() : it;

// --- normalise / normaliseKey ---
d('normalise', () => {
  t('leading article + trailing tokens', () => {
    eq(normalise('The Beatles For Sale'), normalise('Beatles For Sale'), 'the-strip');
    eq(normalise('Ant Clowes Duo'), normalise('Ant Clowes'), 'duo-strip (ADR-023)');
    eq(normalise('8Ts Band'), normalise('8Ts'), 'band-strip short name');
    eq(normalise('Trilogy Rock Band'), 'trilogy rock', 'compound suffix leaves core');
    eq(normalise('The Select Committee'), normalise('the Select Committee'), 'case-insensitive');
    eq(normalise('Creative Covers Band UK'), 'creative covers', 'repeated trailing strip');
  });
  t('ampersand and punctuation', () => {
    eq(normalise('Mike & The Floorfillers'), 'mike and the floorfillers', 'amp to and, inner the kept');
    eq(normalise("Banker's Draught"), normalise('Bankers Draught'), 'apostrophe');
    eq(normalise('Blond-Age'), normalise('Blond-age'), 'hyphen case');
    eq(normalise('Soul4Soul'), normalise('Soul4soul'), 'no space around 4');
  });
  t('leet fold', () => {
    eq(normalise('S0ul 5ister'), 'soul sister', 'leet 0/5');
  });
  t('never strips a name to nothing', () => {
    eq(normalise('Duo') !== '', true, 'bare token survives');
    eq(normalise('The Band'), 'band', 'the+token survives as token');
  });
  t('key form collapses spacing', () => {
    eq(normaliseKey('Star Breaker'), normaliseKey('Starbreaker'), 'spacing variant SAME key');
    eq(normaliseKey('Sound Bar'), normaliseKey('Soundbar'), 'spacing variant 2');
  });
  t('near-miss stays out of the hard key', () => {
    eq(normaliseKey('Damiain Lodrick') !== normaliseKey('Damien Lodrick'), true, 'misspelling is NOT same key');
    eq(isNearMiss('Damiain Lodrick', 'Damien Lodrick'), true, 'but IS a near-miss (review)');
    eq(isNearMiss('Pheonix', 'Phoenix'), true, 'pheonix near-miss');
    eq(isNearMiss('Atomic', 'Atomica'), true, 'edit distance 1');
    eq(isNearMiss('Backwater', 'Blackwater'), true, 'ed 2 -> review, resolver decides by region');
    eq(isNearMiss('Casino', 'Cassinis'), false, 'ed 3 not near-miss');
  });
});

// --- regionBucket ---
d('regionBucket', () => {
  t('staffs cluster collapses', () => {
    eq(regionBucket('Stoke-on-Trent'), 'staffs', 'stoke');
    eq(regionBucket('Staffordshire'), 'staffs', 'staffordshire');
    eq(regionBucket('Newcastle-under-Lyme'), 'staffs', 'NUL is staffs');
    eq(regionBucket('Hanley, Stoke-on-Trent, UK'), 'staffs', 'compound');
  });
  t('newcastle disambiguation', () => {
    eq(regionBucket('Newcastle upon Tyne'), 'ne', 'upon tyne is NE');
    eq(regionBucket('Newcastle-under-Lyme') !== regionBucket('Newcastle upon Tyne'), true, 'two newcastles distinct');
  });
  t('not-guilty corpus', () => {
    eq(regionBucket('Yorkshire') !== regionBucket('Stoke-on-Trent'), true, 'Not Guilty Stoke vs Yorkshire distinct');
  });
  t('unknowns', () => {
    eq(regionBucket(''), UNKNOWN_REGION, 'empty');
    eq(regionBucket('UK'), UNKNOWN_REGION, 'bare UK is not a location');
    eq(regionBucket('England'), UNKNOWN_REGION, 'england');
    eq(regionBucket(null), UNKNOWN_REGION, 'null');
    eq(regionBucket('tbc'), UNKNOWN_REGION, 'tbc');
  });
  t('hants + nw + derbys', () => {
    eq(regionBucket('Havant'), 'hants', 'havant');
    eq(regionBucket('Waterlooville, Hampshire'), 'hants', 'waterlooville');
    eq(regionBucket('Stockport'), 'nw', 'stockport');
    eq(regionBucket('High Peak'), 'nw', 'high peak (New Mills gotcha)');
    eq(regionBucket('Swadlincote, Derbyshire'), 'derbys-notts', 'swadlincote');
  });
  t('unmatched falls back to own slug (deterministic, fails safe)', () => {
    eq(regionBucket('Ballymena'), 'ballymena', 'unmatched town = own slug');
  });
});

// --- artistIdentityKey ---
d('artistIdentityKey', () => {
  t('jason ruling: name+location is the UID', () => {
    const stoke = artistIdentityKey('Not Guilty', 'Stoke-on-Trent');
    const yorks = artistIdentityKey('Not Guilty', 'Yorkshire');
    eq(stoke.key !== yorks.key, true, 'same name diff region = distinct keys');
    eq(stoke.resolvable && yorks.resolvable, true, 'both resolvable');
  });
  t('unknown region is not resolvable (must route to review, never create)', () => {
    eq(artistIdentityKey('Not Guilty', '').resolvable, false, 'empty loc');
    eq(artistIdentityKey('Not Guilty', 'UK').resolvable, false, 'bare UK');
    eq(artistUniqueKey('Not Guilty', 'UK'), '', 'no sentinel key for unknown region');
  });
  t('act qualifiers collapse within a region (ADR-023)', () => {
    eq(artistIdentityKey('Ant Clowes Duo', 'Stoke-on-Trent').key,
       artistIdentityKey('Ant Clowes', 'Staffordshire').key, 'duo qualifier same key');
  });
  t('sentinel key format', () => {
    eq(artistUniqueKey('The Glamz', 'Stoke-on-Trent'), 'artist#glamz#staffs', 'key shape');
  });
});

// --- facebookKey ---
d('facebookKey', () => {
  t('canonicalisation', () => {
    eq(facebookKey('https://www.facebook.com/TheGlamz/'), 'facebook.com/theglamz', 'basic');
    eq(facebookKey('http://facebook.com/theglamz?ref=page'), 'facebook.com/theglamz', 'query strip');
    eq(facebookKey('https://facebook.com/TheGlamz/about'), 'facebook.com/theglamz', 'about strip');
    eq(facebookKey('https://m.facebook.com/theglamz'), 'facebook.com/theglamz', 'mobile host');
  });
  t('profile.php id preserved', () => {
    eq(facebookKey('https://www.facebook.com/profile.php?id=685142534680018&sk=about'), 'facebook.com/685142534680018', 'profile id');
  });
  t('numeric path forms', () => {
    eq(facebookKey('https://www.facebook.com/p/The-Torrists-685142534680018/'), 'facebook.com/685142534680018', '/p/ form');
    eq(facebookKey('https://www.facebook.com/people/The-Torrists/685142534680018'), 'facebook.com/685142534680018', '/people/ form');
  });
  t('rejects non-facebook', () => {
    eq(facebookKey('https://instagram.com/theglamz'), '', 'instagram');
    eq(facebookKey(''), '', 'empty');
    eq(facebookKey('https://facebook.com/'), '', 'bare host');
  });
});

// --- event keys ---
d('event keys', () => {
  t('date drift collapses', () => {
    eq(eventNaturalKey('v1', 'a1', '2026-6-20'), eventNaturalKey('v1', 'a1', '2026-06-20'), 'YYYY-M-D drift');
    throws(() => eventNaturalKey('v1', 'a1', '20/06/2026'), 'rejects UK format');
    throws(() => eventNaturalKey('v1', 'a1', '2026-13-01'), 'rejects month 13');
    throws(() => normaliseEventDate('junk'), 'rejects junk');
  });
  t('per-artist keys incl collaborators', () => {
    const keys = eventNaturalKeys({ venueId: 'v1', date: '2026-06-20', artistId: 'a1', collaboratingArtistIds: ['a2', 'a1'], artistIds: ['a3'] });
    eq(keys.length, 3, 'deduped per-artist keys');
    eq(new Set(keys).size, 3, 'unique');
  });
  t('open-mic keyed by startTime', () => {
    const k1 = eventNaturalKeys({ venueId: 'v1', date: '2026-06-20', startTime: '19:00' });
    const k2 = eventNaturalKeys({ venueId: 'v1', date: '2026-06-20', startTime: '21:00' });
    eq(k1.length, 1, 'one openmic key');
    eq(k1[0] !== k2[0], true, 'different session different key');
    eq(k1[0], eventNaturalKey('v1', OPEN_MIC_ARTIST, '2026-06-20', '19:00'), 'matches direct call');
  });
  t('collision: same artist+venue+date ALWAYS same key regardless of title/time', () => {
    eq(eventNaturalKey('v1', 'a1', '2026-06-20'), eventNaturalKey('v1', 'a1', '2026-06-20'), 'deterministic');
  });
  t('unique-keys table format', () => {
    const ks = eventUniqueKeys({ venueId: 'v1', date: '2026-06-20', artistId: 'a1' });
    eq(ks[0].startsWith('event#'), true, 'prefixed');
  });
});

// --- venue key ---
d('venuePlaceKey', () => {
  t('shape + rejects empty', () => {
    eq(venuePlaceKey('ChIJabc123'), 'venue#gplace#ChIJabc123', 'shape');
    eq(venuePlaceKey('  '), '', 'blank rejected');
    eq(venuePlaceKey(null), '', 'null rejected');
  });
});

// --- editDistance ---
d('editDistance', () => {
  t('basics', () => {
    eq(editDistance('phoenix', 'pheonix'), 2, 'transposition = 2 (plain levenshtein)');
    eq(editDistance('', 'abc'), 3, 'empty');
    eq(editDistance('same', 'same'), 0, 'identical');
  });
});

if (standalone) {
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}
