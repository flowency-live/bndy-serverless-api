'use strict';

/**
 * Drift guard for the Artist Domain taxonomy.
 *
 * Lambda packages are intentionally self-contained in this repo, so the
 * canonical source is copied into active consumers. This test makes that a
 * generated-copy pattern rather than independently maintained lists.
 *
 * bndy-frontstage is retired and intentionally not part of this guard.
 */

const fs = require('fs');
const path = require('path');

const canonical = fs.readFileSync(path.join(__dirname, 'taxonomy.js'), 'utf8');
const copies = [
  '../../artists-lambda/lib/taxonomy.js',
  '../../events-agent-lambda/lib/taxonomy.js',
  '../../users-lambda/lib/taxonomy.js'
];

let bad = 0;
for (const rel of copies) {
  const target = path.join(__dirname, rel);
  if (!fs.existsSync(target)) {
    console.error(`MISSING taxonomy copy: ${rel}`);
    bad++;
    continue;
  }
  if (fs.readFileSync(target, 'utf8') !== canonical) {
    console.error(`DRIFTED taxonomy copy: ${rel} — re-sync from shared/artist-domain/taxonomy.js`);
    bad++;
  }
}

if (typeof it !== 'undefined') {
  it('artist taxonomy copies are in sync', () => {
    if (bad) throw new Error(`${bad} taxonomy copies missing/drifted`);
  });
} else {
  console.log(bad === 0 ? 'all artist taxonomy copies in sync' : `${bad} PROBLEMS`);
  process.exit(bad ? 1 : 0);
}
