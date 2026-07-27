/**
 * Drift guard: the identity library copies in each lambda's lib/ MUST be
 * byte-identical to the canonical shared/identity/identity.js. This is the
 * lesson of artistSlugNormalise (handler.js vs find-runner-duplicate-artists.js
 * diverged silently). Runs standalone: `node check-sync.test.js`.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const CANONICAL_FILES = ['identity.js', 'unique-gate.js'];
const LAMBDAS = ['artists-lambda', 'events-lambda', 'venues-lambda'];
let bad = 0;
for (const file of CANONICAL_FILES) {
  const canonical = fs.readFileSync(path.join(__dirname, file), 'utf8');
  for (const lambda of LAMBDAS) {
    const rel = `../../${lambda}/lib/${file}`;
    const p = path.join(__dirname, rel);
    if (!fs.existsSync(p)) { console.error(`MISSING copy: ${rel}`); bad++; continue; }
    if (fs.readFileSync(p, 'utf8') !== canonical) { console.error(`DRIFTED copy: ${rel} — re-sync from shared/identity/${file}`); bad++; }
  }
}
if (typeof it !== 'undefined') { it('identity copies in sync', () => { if (bad) throw new Error(`${bad} identity copies missing/drifted`); }); }
else { console.log(bad === 0 ? 'all identity copies in sync' : `${bad} PROBLEMS`); process.exit(bad ? 1 : 0); }
