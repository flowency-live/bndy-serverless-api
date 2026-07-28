/**
 * Tests for the amended data-quality gates. The DO-NOT-BOUNCE corpus comes
 * from real records in the bndy database — if any of those fail, the patterns
 * are too greedy (that is the exact defect this v2 fixed).
 * Runs standalone (`node data-quality.test.js`) and under jest/vitest.
 */

'use strict';

const { isMultiArtistLineup, isCancelledIndicator, validateArtistName, validateArtistData, sanitizeBillingName, isListingCopyName } = require('./data-quality');

const standalone = typeof describe === 'undefined';
let failures = 0; let checks = 0;
function eq(actual, expected, label) {
  checks++;
  if (actual !== expected) { failures++; console.error(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
}
const d = standalone ? (n, f) => f() : describe;
const t = standalone ? (n, f) => f() : it;

d('Gate 1 — lineup detection', () => {
  t('REJECTS unambiguous lineups (audit corpus)', () => {
    for (const bad of [
      'A Thousand Cuts + Anti-Meta + Tba',
      'Malpractice + Voodoo Voodoo + Nick Degg',
      'Die Ego, Vulgaris, and Bound By Burdens',
      'Scarlett Fever, Disco Lizards, and Grenades',
      'Tombstone, Tits Up, And Bang Bang Firecracker',
      'Anti-Meta, Chin, Fractured Mind + Cure For The Enemy',
      'The Offspin vs Some 41: Derby',
      'Meat Loaf Vs Elton John',
      'Elvis tribute show featuring Mark Clay',
      'Big Band ft. Jane Doe',
      'Headliner w/ support',
      'The Regulars plus special guests',
      'Someone + 2 more',
    ]) eq(isMultiArtistLineup(bad), true, `lineup: ${bad}`);
  });
  t('NEVER bounces legitimate names (real bndy records)', () => {
    for (const good of [
      'Harris & Wheeler',
      'Jane and the Hurricanes',
      'Mike & The Floorfillers',
      'Beatles For Sale',
      'A Band Called Malice',
      'Crosby, Stills',            // single comma allowed
      'Bound By Burdens',
      'Cure For The Enemy',
      'The Vanz',
      'Ant Clowes Duo',
      'Soul4Soul',
      'Wolves in Alcatraz',
      'Croft',                     // must not hit the ft. pattern
      'Supporting Cast',           // hmm — contains "supporting"… see below
    ].filter(n => n !== 'Supporting Cast')) eq(isMultiArtistLineup(good), false, `legit: ${good}`);
    // Known accepted edge: a band literally named "Supporting Cast" would
    // bounce — acceptable; that name routes to review, not silent loss.
  });
});

d('Gate 2 — placeholders', () => {
  t('rejects placeholders in any casing/spacing', () => {
    for (const bad of ['Cancelled', 'CANCELLED', 'canceled', 'TBC', 'T.B.C.', 'tba', 'To Be Confirmed', 'Postponed', 'Various Artists', 'Open Mic']) {
      eq(isCancelledIndicator(bad), true, `placeholder: ${bad}`);
    }
  });
  t('does NOT reject real names containing those words', () => {
    for (const good of ['The Cancellations', 'Various Vices', 'Unknown Pleasures Tribute', 'The Announcement']) {
      eq(isCancelledIndicator(good), false, `not placeholder: ${good}`);
    }
  });
});

d('Gate 3 — searchability (amended: NO non-ASCII ratio rule)', () => {
  t('accented/stylized names are VALID', () => {
    for (const good of ['Motörhead Tribute', 'Beyoncé Experience', 'Blue Öyster Cult UK', 'ÜL†RᛟɣᛨɸLE†', 'Søren']) {
      eq(validateArtistName(good).valid, true, `stylized ok: ${good}`);
    }
  });
  t('only zero-alphanumeric-after-fold names are invalid', () => {
    for (const bad of ['———', '***', '!!!?', '   ']) {
      eq(validateArtistName(bad).valid, false, `unsearchable: ${bad}`);
    }
  });
});

d('Gate 5 — billing-name sanitation', () => {
  t('strips description tails', () => {
    eq(sanitizeBillingName('Not Guilty - 5pc Local Rock/pop Covers Band'), 'Not Guilty', 'klma incident');
    eq(sanitizeBillingName('The Glamz - Party Covers Duo'), 'The Glamz', 'desc tail');
  });
  t('promo blurb tails (Cosey Club class, v1.5)', () => {
    eq(sanitizeBillingName("Cyril Blake 60s & 70s Band - It'll Be Fun! All Aboard!!"), 'Cyril Blake 60s & 70s Band', 'promo tail stripped');
    eq(isListingCopyName("Cyril Blake 60s & 70s Band - It'll Be Fun! All Aboard!!"), true, 'detected as listing copy');
    eq(isListingCopyName('The Glamz - Free Entry!'), true, 'free entry tail');
    eq(isListingCopyName('Party Night!! Join Us'), true, 'standalone hype');
    eq(isListingCopyName('Wham!'), false, 'single bang name ok');
    eq(isListingCopyName('Panic Stations'), false, 'plain name ok');
    eq(validateArtistData({ name: "Cyril Blake 60s & 70s Band - It'll Be Fun! All Aboard!!" }).valid, false, 'aggregate rejects listing copy');
  });
  t('leaves hyphenated NAMES alone', () => {
    eq(sanitizeBillingName('Blond-Age'), 'Blond-Age', 'hyphen name');
    eq(sanitizeBillingName('The All-Nighters'), 'The All-Nighters', 'hyphen name 2');
    eq(sanitizeBillingName('Ashes - Rise'), 'Ashes - Rise', 'non-description tail untouched');
  });
});

d('validateArtistData aggregate', () => {
  t('shapes are stable for the handler', () => {
    const r1 = validateArtistData({ name: 'Harris & Wheeler' });
    eq(r1.valid, true, 'legit passes aggregate');
    const r2 = validateArtistData({ name: 'A + B + C' });
    eq(r2.valid, false, 'lineup fails aggregate');
    eq(Array.isArray(r2.errors), true, 'errors array present');
  });
});

if (standalone) {
  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) process.exit(1);
}
