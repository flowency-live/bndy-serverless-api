/**
 * bndy shared identity library — THE canonical implementation of entity identity keys.
 *
 * This file is the single source of truth for how bndy decides whether two
 * records are "the same" artist / venue / event. It backs the hard DynamoDB
 * uniqueness gates (sentinel items in the unique-keys table) AND the
 * application-level resolvers. Per the 2026-07-27 gate plan
 * (Documents/Claude/Projects/bndy/IMPORT-SHUTDOWN-AUDIT-AND-GATE-PLAN.md):
 *
 *   - Venue UID  = google_place_id                        (absolute)
 *   - Artist UID = normalise(name) + '#' + regionBucket   (name + performing location)
 *   - Event UID  = sha1(venueId | artistId | isoDate)     (one per artist incl. collaborators)
 *
 * DO NOT re-implement any of this per caller — that is exactly how the
 * duplicate pollution happened (divergent copies of artistSlugNormalise, ad-hoc
 * search thresholds, per-prompt discipline). Copies of this file are synced
 * into each lambda's lib/ by shared/identity/check-sync.test.js, which FAILS
 * if any copy drifts from this canonical one.
 *
 * Provenance of the rules: artist-identity-gate-plan.md §1 (normalise recipe,
 * region buckets, FB-URL-as-strongest-key), dedup-remediation-plan.md
 * (near-miss edit distance ≤2), ADR-023 (act qualifiers are never a new
 * artist), ADR-018 (venues must have google_place_id).
 */

'use strict';

const crypto = require('crypto');

/** Region bucket returned for empty / unresolvable locations. NEVER matches anything (including itself) at the resolver level; at the hard-gate level an UNKNOWN-region artist key may not be created in enforce mode. */
const UNKNOWN_REGION = 'unknown';

/** Trailing tokens stripped (repeatedly) from artist names. Order-independent. Keep in sync with the runbook — do NOT add tokens without updating artist-identity-gate-plan.md. */
const TRAILING_TOKENS = ['band', 'duo', 'trio', 'acoustic', 'live', 'music', 'uk'];

/** Leet-fold map per the runbook recipe. Applied character-wise after lowercasing. */
const LEET = { 3: 'e', 0: 'o', 1: 'i', 5: 's' };

/**
 * Canonical artist-name normalisation.
 * lowercase → '&'→' and ' → leet-fold → punctuation/apostrophes/hyphens → space
 * → collapse whitespace → strip leading 'the ' → strip trailing tokens (repeat).
 *
 * Returns a SPACED normal form (for display/similarity). For the identity key
 * use normaliseKey(), which additionally removes all whitespace so that
 * "Star Breaker" and "Starbreaker" collide (runbook near-miss corpus).
 *
 * @param {string} name
 * @returns {string} normalised name, '' if input is falsy/blank
 */
function normalise(name) {
  if (!name || typeof name !== 'string') return '';
  let s = name.toLowerCase();
  s = s.replace(/['’‘]/g, ''); // apostrophes are REMOVED (banker's -> bankers), not spaced
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[3015]/g, (c) => LEET[c]);
  s = s.replace(/[^a-z0-9]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.startsWith('the ')) s = s.slice(4);
  // Strip trailing qualifier tokens repeatedly: "x covers band uk" -> "x covers" -> ...
  let changed = true;
  while (changed) {
    changed = false;
    for (const tok of TRAILING_TOKENS) {
      if (s === tok) break; // never strip a name down to nothing ("Duo" stays "duo")
      if (s.endsWith(' ' + tok)) {
        s = s.slice(0, -(tok.length + 1)).trim();
        changed = true;
      }
    }
  }
  return s;
}

/**
 * Whitespace-free identity form of normalise(). This is what goes into the
 * hard uniqueness key, so spacing variants ("Star Breaker"/"Starbreaker",
 * "Sound Bar"/"Soundbar") are the SAME artist within a region.
 */
function normaliseKey(name) {
  return normalise(name).replace(/\s+/g, '');
}

/**
 * Region bucket table. First match wins — ORDER MATTERS:
 * 'newcastle-under-lyme' MUST be tested before 'newcastle' (upon Tyne).
 * Patterns are tested against the lowercased, punctuation-stripped location.
 *
 * Coarse on purpose (artist-identity-gate-plan §5 recommendation): a bucket is
 * a "performing footprint" area, not a town. stoke-on-trent / staffordshire /
 * newcastle-under-lyme are ONE bucket.
 */
const REGION_PATTERNS = [
  // Staffordshire / Potteries
  [/newcastle under lyme|stoke|staffordshire|staffs|hanley|burslem|tunstall|longton|fenton|kidsgrove|biddulph|leek\b|stafford\b|cannock|lichfield|tamworth|uttoxeter|stone\b/, 'staffs'],
  // Cheshire
  [/cheshire|crewe|nantwich|congleton|macclesfield|sandbach|alsager|northwich|winsford|middlewich|knutsford|wilmslow|chester\b|ellesmere port/, 'cheshire'],
  // North East (Tyne & Wear / Northumberland / Durham / Teesside)
  [/newcastle upon tyne|tyne|wearside|sunderland|gateshead|northumberland|ashington|blyth|cramlington|morpeth|whitley bay|north shields|south shields|washington\b|durham|hartlepool|darlington|stockton|middlesbrough|teesside|seaham|peterlee|consett|stanley\b|chester le street|crook\b|new hartley/, 'ne'],
  // North West (Gtr Manchester / Lancashire / Merseyside)
  [/manchester|stockport|oldham|rochdale|bury\b|bolton|wigan|salford|tameside|ashton under lyne|glossop|trafford|altrincham|sale\b|lancashire|preston|blackburn|burnley|blackpool|lancaster|merseyside|liverpool|st helens|warrington|widnes|runcorn|high peak|new mills|chapel en le frith|buxton/, 'nw'],
  // Yorkshire
  [/yorkshire|leeds|sheffield|york\b|bradford|huddersfield|halifax|wakefield|barnsley|doncaster|rotherham|hull\b|harrogate|scarborough|selston/, 'yorks'],
  // Derbyshire / Notts
  [/derbyshire|derby\b|swadlincote|melbourne|ilkeston|ripley|belper|matlock|chesterfield|alfreton|heanor|long eaton|nottingham|notts|mansfield/, 'derbys-notts'],
  // Hampshire / south coast
  [/hampshire|hants|havant|waterlooville|emsworth|hayling|portsmouth|southampton|gosport|fareham|petersfield|winchester|eastleigh|basingstoke|isle of wight|bembridge/, 'hants'],
  // West Midlands
  [/west midlands|birmingham|wolverhampton|walsall|dudley|sandwell|solihull|coventry|west bromwich|stourbridge|halesowen/, 'west-mids'],
  // Shropshire
  [/shropshire|shrewsbury|telford|oswestry|market drayton|whitchurch/, 'shrops'],
  // Wales (coarse)
  [/wales|cardiff|swansea|newport\b|wrexham|rhyl|bangor\b|llandudno/, 'wales'],
  // Scotland (coarse)
  [/scotland|glasgow|edinburgh|aberdeen|dundee|stirling|inverness/, 'scotland'],
  // London / South East (coarse)
  [/london|croydon|bromley|essex|kent\b|surrey|sussex|brighton|reading\b|oxford\b|milton keynes|luton|watford/, 'london-se'],
  // South West (coarse)
  [/bristol|bath\b|somerset|devon|cornwall|plymouth|exeter|gloucester|cheltenham|swindon|dorset|bournemouth|poole/, 'sw'],
  // East (coarse)
  [/norfolk|norwich|suffolk|ipswich|cambridge|peterborough|lincoln/, 'east'],
];

/** Values that mean "no usable location". 'uk' alone is NOT a location (331-artist backfill finding). */
const NON_LOCATIONS = new Set(['', 'uk', 'united kingdom', 'england', 'britain', 'great britain', 'tbc', 'unknown', 'n a', 'none', 'null']);

/**
 * Canonicalise a free-text location (or region string) to a coarse bucket.
 * Unmatched non-empty locations fall back to their own slug — deterministic,
 * and it fails SAFE for the hard gate (unmatched variants create rather than
 * wrongly merge); the resolver layer catches those with a same-name-any-region
 * review rule.
 *
 * @param {string} location
 * @returns {string} bucket id, or UNKNOWN_REGION
 */
function regionBucket(location) {
  if (!location || typeof location !== 'string') return UNKNOWN_REGION;
  const s = location.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (NON_LOCATIONS.has(s)) return UNKNOWN_REGION;
  for (const [pattern, bucket] of REGION_PATTERNS) {
    if (pattern.test(s)) return bucket;
  }
  // Deterministic fallback: the location's own slug (strip trailing ', uk' noise first)
  const slug = s.replace(/\buk$/, '').trim().replace(/\s+/g, '-');
  return slug || UNKNOWN_REGION;
}

/**
 * The artist identity key — Jason's ruling: artist name + performing location
 * IS the UID. Same name in a different (non-empty) region = distinct artist.
 *
 * @param {string} name
 * @param {string} location
 * @returns {{key: string, nameKey: string, region: string, resolvable: boolean}}
 *   resolvable=false when the region is UNKNOWN — such a key MUST NOT be
 *   created in enforce mode (route to review instead), and MUST NOT be treated
 *   as matching anything.
 */
function artistIdentityKey(name, location) {
  const nameKey = normaliseKey(name);
  const region = regionBucket(location);
  return {
    key: `${nameKey}#${region}`,
    nameKey,
    region,
    resolvable: nameKey.length > 0 && region !== UNKNOWN_REGION,
  };
}

/**
 * Normalise a Facebook URL to a stable identity key (strongest artist signal —
 * exact facebook_key match means same artist regardless of name spelling).
 * Handles: protocol/www/trailing-slash/query/hash stripping, /about suffix,
 * profile.php?id=N (id preserved), and numeric-id path forms.
 *
 * @param {string} url
 * @returns {string} e.g. 'facebook.com/theglamz' or 'facebook.com/685142534680018', '' if unusable
 */
function facebookKey(url) {
  if (!url || typeof url !== 'string') return '';
  let s = url.trim().toLowerCase();
  if (!/facebook\.com|fb\.com|fb\.me/.test(s)) return '';
  // profile.php?id=N — the id IS the identity; grab it before stripping the query
  const profileMatch = s.match(/profile\.php\?(?:.*&)?id=(\d+)/);
  if (profileMatch) return `facebook.com/${profileMatch[1]}`;
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/^m\./, '').replace(/^mbasic\./, '');
  s = s.replace(/^fb\.com/, 'facebook.com').replace(/^fb\.me/, 'facebook.com');
  s = s.split('?')[0].split('#')[0];
  s = s.replace(/\/about\/?$/, '');
  s = s.replace(/\/+$/, '');
  // /p/Name-1234567890 and /people/Name/1234567890 — numeric id is the identity
  const pMatch = s.match(/facebook\.com\/p\/[^/]*-(\d{6,})$/) || s.match(/facebook\.com\/people\/[^/]+\/(\d{6,})$/);
  if (pMatch) return `facebook.com/${pMatch[1]}`;
  return s.startsWith('facebook.com/') && s.length > 'facebook.com/'.length ? s : '';
}

/**
 * Normalise an event date to strict YYYY-MM-DD. Accepts YYYY-M-D drift.
 * Throws on anything unparseable — an event with a bad date must not be
 * silently keyed (that is how string-drift bypassed the old advisory check).
 *
 * @param {string} date
 * @returns {string} YYYY-MM-DD
 */
function normaliseEventDate(date) {
  if (typeof date !== 'string') throw new Error(`Invalid event date: ${date}`);
  const m = date.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (!m) throw new Error(`Invalid event date: ${date}`);
  const [, y, mo, d] = m;
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new Error(`Invalid event date: ${date}`);
  }
  return iso;
}

/** Sentinel artistId used for events with no named artist (open-mic class). Disambiguated by startTime so two different open-mic sessions on one day don't collide. */
const OPEN_MIC_ARTIST = 'OPENMIC';

/**
 * The event natural key — sha1(venueId|artistId|date). Matches the (already
 * stored, never used) naturalKey the events-agent computes, so existing
 * events-agent items are compatible.
 *
 * @param {string} venueId
 * @param {string} artistId  pass OPEN_MIC_ARTIST + startTime for artist-less events
 * @param {string} date      any YYYY-M-D form; normalised internally
 * @param {string} [startTime] only used for OPEN_MIC_ARTIST keys
 * @returns {string} 40-char sha1 hex
 */
function eventNaturalKey(venueId, artistId, date, startTime) {
  if (!venueId) throw new Error('eventNaturalKey: venueId required');
  const isoDate = normaliseEventDate(date);
  const artistPart = artistId === OPEN_MIC_ARTIST
    ? `${OPEN_MIC_ARTIST}|${startTime || '00:00'}`
    : artistId;
  if (!artistPart) throw new Error('eventNaturalKey: artistId required');
  return crypto.createHash('sha1').update(`${venueId}|${artistPart}|${isoDate}`).digest('hex');
}

/**
 * All natural keys for an event — one per artist (primary + artistIds +
 * collaboratingArtistIds, deduped). Artist-less events get the OPENMIC key.
 *
 * @param {{venueId: string, date: string, startTime?: string, artistId?: string, artistIds?: string[], collaboratingArtistIds?: string[]}} ev
 * @returns {string[]} unique sha1 keys
 */
function eventNaturalKeys(ev) {
  const artists = new Set(
    [ev.artistId, ...(ev.artistIds || []), ...(ev.collaboratingArtistIds || [])].filter(Boolean)
  );
  if (artists.size === 0) {
    return [eventNaturalKey(ev.venueId, OPEN_MIC_ARTIST, ev.date, ev.startTime)];
  }
  return [...artists].map((a) => eventNaturalKey(ev.venueId, a, ev.date));
}

/** Venue uniqueness key from a Google Place ID. */
function venuePlaceKey(googlePlaceId) {
  if (!googlePlaceId || typeof googlePlaceId !== 'string' || !googlePlaceId.trim()) return '';
  return `venue#gplace#${googlePlaceId.trim()}`;
}

/** Artist uniqueness key string for the unique-keys table. */
function artistUniqueKey(name, location) {
  const { key, resolvable } = artistIdentityKey(name, location);
  return resolvable ? `artist#${key}` : '';
}

/** Event uniqueness key strings for the unique-keys table. */
function eventUniqueKeys(ev) {
  return eventNaturalKeys(ev).map((k) => `event#${k}`);
}

/**
 * Plain Levenshtein edit distance (for the resolver's near-miss pass —
 * Damiain/Damien, Pheonix/Phoenix). NOT used in the hard key.
 */
function editDistance(a, b) {
  a = a || ''; b = b || '';
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[b.length];
}

/** Near-miss test on normalised keys: edit distance ≤2 → route to review, never auto-merge, never auto-create. */
function isNearMiss(nameA, nameB) {
  const a = normaliseKey(nameA);
  const b = normaliseKey(nameB);
  if (!a || !b || a === b) return false;
  if (Math.abs(a.length - b.length) > 2) return false;
  return editDistance(a, b) <= 2;
}

module.exports = {
  UNKNOWN_REGION,
  OPEN_MIC_ARTIST,
  TRAILING_TOKENS,
  normalise,
  normaliseKey,
  regionBucket,
  artistIdentityKey,
  facebookKey,
  normaliseEventDate,
  eventNaturalKey,
  eventNaturalKeys,
  venuePlaceKey,
  artistUniqueKey,
  eventUniqueKeys,
  editDistance,
  isNearMiss,
};
