/**
 * Drift guard: identity/domain copies in lambda lib/ folders MUST remain
 * byte-identical to the canonical shared implementation.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TARGETS = {
  'identity.js': ['artists-lambda', 'events-lambda', 'venues-lambda', 'events-agent-lambda'],
  'unique-gate.js': ['artists-lambda', 'events-lambda', 'venues-lambda'],
  'data-quality.js': ['artists-lambda', 'events-lambda', 'venues-lambda']
};

let bad = 0;
for (const [file, lambdas] of Object.entries(TARGETS)) {
  const canonical = fs.readFileSync(path.join(__dirname, file), 'utf8');
  for (const lambda of lambdas) {
    const rel = `../../${lambda}/lib/${file}`;
    const p = path.join(__dirname, rel);
    if (!fs.existsSync(p)) { console.error(`MISSING copy: ${rel}`); bad++; continue; }
    if (fs.readFileSync(p, 'utf8') !== canonical) { console.error(`DRIFTED copy: ${rel} — re-sync from shared/identity/${file}`); bad++; }
  }
}

if (typeof it !== 'undefined') {
  it('identity copies in sync', () => { if (bad) throw new Error(`${bad} identity copies missing/drifted`); });
} else {
  console.log(bad === 0 ? 'all identity copies in sync' : `${bad} PROBLEMS`);
  process.exit(bad ? 1 : 0);
}
