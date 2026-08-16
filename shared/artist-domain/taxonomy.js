'use strict';

/**
 * Canonical BNDY artist taxonomy.
 *
 * This is the single source of truth for ACTIVE artist classification choices.
 * Runtime consumers should use the Artists API taxonomy endpoint rather than
 * maintaining their own lists. Lambda-local copies are guarded by
 * shared/artist-domain/check-sync.test.js.
 *
 * Compatibility policy:
 * - New UI choices come only from the active taxonomy below.
 * - Legacy genre values remain ACCEPTED temporarily so existing artist records
 *   can still be edited without destructive migration.
 * - Artist/act type aliases are normalised to stable machine values on write.
 * - `acoustic` is a separate performance capability boolean, never an actType.
 */

const TAXONOMY_VERSION = '2026-08-16';

const GENRES = [
  'Rock', 'Rock n Roll', 'Grunge', 'Metal', 'Punk', 'Alternative', 'New Wave',
  'Pop', 'Indie', 'Britpop', 'Mod',
  'Blues', 'R&B', 'Country', 'Americana',
  'Folk', 'Soul', 'Funk', 'Motown',
  'Electronic', 'Dance',
  'Jazz', 'Classical', 'Reggae', 'Latin',
  'Other'
];

// Accepted only for compatibility with records created under the retired
// taxonomy. These are deliberately NOT returned as selectable active genres.
const LEGACY_GENRES = [
  'Hardcore', 'Irish', 'Disco', 'Ska',
  '50s', '60s', '70s', '80s', '90s', '00s'
];

const ARTIST_TYPES = [
  { value: 'band', label: 'Band' },
  { value: 'solo', label: 'Solo Act' },
  { value: 'duo', label: 'Duo' },
  { value: 'trio', label: 'Trio' },
  { value: 'group', label: 'Group' },
  { value: 'dj', label: 'DJ' },
  { value: 'collective', label: 'Collective' }
];

const ACT_TYPES = [
  { value: 'originals', label: 'Originals' },
  { value: 'covers', label: 'Covers' },
  { value: 'tribute', label: 'Tribute Act' }
];

const PERFORMANCE_CAPABILITIES = [
  { value: 'acoustic', label: 'Acoustic performances', field: 'acoustic', type: 'boolean' }
];

const ARTIST_TYPE_ALIASES = new Map();
for (const option of ARTIST_TYPES) {
  ARTIST_TYPE_ALIASES.set(option.value.toLowerCase(), option.value);
  ARTIST_TYPE_ALIASES.set(option.label.toLowerCase(), option.value);
}
ARTIST_TYPE_ALIASES.set('solo act', 'solo');

const ACT_TYPE_ALIASES = new Map();
for (const option of ACT_TYPES) {
  ACT_TYPE_ALIASES.set(option.value.toLowerCase(), option.value);
  ACT_TYPE_ALIASES.set(option.label.toLowerCase(), option.value);
}
ACT_TYPE_ALIASES.set('tribute act', 'tribute');

const GENRE_MAP = new Map();
for (const genre of [...GENRES, ...LEGACY_GENRES]) {
  GENRE_MAP.set(genre.toLowerCase(), genre);
}

// Common spelling/case variants.
GENRE_MAP.set('r and b', 'R&B');
GENRE_MAP.set('rhythm and blues', 'R&B');
GENRE_MAP.set('rnb', 'R&B');
GENRE_MAP.set('r & b', 'R&B');
GENRE_MAP.set('rock and roll', 'Rock n Roll');
GENRE_MAP.set('rock & roll', 'Rock n Roll');
GENRE_MAP.set('rocknroll', 'Rock n Roll');
GENRE_MAP.set("rock'n'roll", 'Rock n Roll');
GENRE_MAP.set("rock 'n' roll", 'Rock n Roll');

// Sub-genres flatten to an ACTIVE parent taxonomy value. Legacy categories are
// not targets here: old values are preserved if already present, but new
// free-text normalisation should converge toward the active model.
const SUBGENRE_MAP = new Map([
  ['classic rock', 'Rock'], ['hard rock', 'Rock'], ['glam rock', 'Rock'],
  ['progressive rock', 'Rock'], ['prog rock', 'Rock'], ['psychedelic rock', 'Rock'],
  ['soft rock', 'Rock'], ['southern rock', 'Rock'], ['garage rock', 'Rock'],
  ['indie rock', 'Indie'], ['indie pop', 'Indie'], ['indie folk', 'Indie'],
  ['alternative rock', 'Alternative'], ['alt rock', 'Alternative'],
  ['pop rock', 'Pop'], ['synth pop', 'Pop'], ['synthpop', 'Pop'], ['power pop', 'Pop'],
  ['heavy metal', 'Metal'], ['thrash metal', 'Metal'], ['death metal', 'Metal'],
  ['nu metal', 'Metal'], ['nu-metal', 'Metal'],
  ['pop punk', 'Punk'], ['post-punk', 'Punk'], ['post punk', 'Punk'],
  ['punk rock', 'Punk'], ['hardcore punk', 'Punk'],
  ['blues rock', 'Blues'], ['electric blues', 'Blues'], ['chicago blues', 'Blues'],
  ['country rock', 'Country'], ['alt country', 'Country'], ['outlaw country', 'Country'],
  ['smooth jazz', 'Jazz'], ['jazz fusion', 'Jazz'], ['bebop', 'Jazz'],
  ['electronica', 'Electronic'], ['edm', 'Electronic'], ['synth', 'Electronic'],
  ['synthwave', 'Electronic'],
  ['house', 'Dance'], ['techno', 'Dance'], ['trance', 'Dance'],
  ['drum and bass', 'Dance'], ['dnb', 'Dance']
]);

function normaliseGenre(genre, { allowLegacy = true } = {}) {
  if (typeof genre !== 'string') return null;
  const key = genre.trim().toLowerCase();
  if (!key) return null;

  const exact = GENRE_MAP.get(key);
  if (exact) {
    if (!allowLegacy && LEGACY_GENRES.includes(exact)) return null;
    return exact;
  }
  return SUBGENRE_MAP.get(key) || null;
}

function normaliseGenres(genres, options = {}) {
  if (!Array.isArray(genres)) return { valid: [], invalid: [], legacy: [] };
  const valid = [];
  const invalid = [];
  const legacy = [];
  const seen = new Set();
  for (const genre of genres) {
    const normalised = normaliseGenre(genre, options);
    if (!normalised) {
      invalid.push(genre);
      continue;
    }
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    valid.push(normalised);
    if (LEGACY_GENRES.includes(normalised)) legacy.push(normalised);
  }
  return { valid, invalid, legacy };
}

function normaliseArtistType(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  return ARTIST_TYPE_ALIASES.get(value.trim().toLowerCase()) || null;
}

function normaliseActType(value) {
  if (typeof value !== 'string') return null;
  return ACT_TYPE_ALIASES.get(value.trim().toLowerCase()) || null;
}

/**
 * Normalise act types while recognising the historical `acoustic` pseudo-act.
 * Returns acoustic=true when that legacy value is encountered so callers can
 * move it into the dedicated boolean without losing meaning.
 */
function normaliseActTypes(values) {
  if (values === null || values === undefined) {
    return { valid: [], invalid: [], acoustic: false };
  }
  const input = Array.isArray(values) ? values : [values];
  const valid = [];
  const invalid = [];
  let acoustic = false;
  const seen = new Set();

  for (const raw of input) {
    if (typeof raw === 'string' && raw.trim().toLowerCase() === 'acoustic') {
      acoustic = true;
      continue;
    }
    const normalised = normaliseActType(raw);
    if (!normalised) {
      invalid.push(raw);
      continue;
    }
    if (!seen.has(normalised)) {
      seen.add(normalised);
      valid.push(normalised);
    }
  }
  return { valid, invalid, acoustic };
}

function normaliseClassification(input = {}) {
  const artistTypeSupplied = input.artistType !== undefined || input.artist_type !== undefined;
  const rawArtistType = input.artistType !== undefined ? input.artistType : input.artist_type;
  const artistType = artistTypeSupplied ? normaliseArtistType(rawArtistType) : undefined;

  const actTypeSupplied = input.actType !== undefined;
  const acts = actTypeSupplied ? normaliseActTypes(input.actType) : { valid: undefined, invalid: [], acoustic: false };
  const acoustic = input.acoustic !== undefined
    ? Boolean(input.acoustic)
    : acts.acoustic
      ? true
      : undefined;

  return {
    artistType,
    artistTypeSupplied,
    invalidArtistType: artistTypeSupplied && rawArtistType !== null && rawArtistType !== '' && !artistType ? rawArtistType : null,
    actType: acts.valid,
    actTypeSupplied,
    invalidActTypes: acts.invalid,
    acoustic,
    acousticFromLegacyActType: acts.acoustic
  };
}

function publicTaxonomy() {
  return {
    version: TAXONOMY_VERSION,
    genres: [...GENRES],
    artistTypes: ARTIST_TYPES.map((x) => ({ ...x })),
    actTypes: ACT_TYPES.map((x) => ({ ...x })),
    performanceCapabilities: PERFORMANCE_CAPABILITIES.map((x) => ({ ...x }))
  };
}

module.exports = {
  TAXONOMY_VERSION,
  GENRES,
  LEGACY_GENRES,
  ARTIST_TYPES,
  ACT_TYPES,
  PERFORMANCE_CAPABILITIES,
  normaliseGenre,
  normaliseGenres,
  normaliseArtistType,
  normaliseActType,
  normaliseActTypes,
  normaliseClassification,
  publicTaxonomy
};
