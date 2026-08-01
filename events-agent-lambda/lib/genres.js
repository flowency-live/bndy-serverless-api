/**
 * Genre Normalisation Module
 *
 * CANONICAL copy of genre list - sync verified with bndy-frontstage.
 * Source of truth: bndy-frontstage/src/lib/constants/genres.ts
 *
 * DO NOT modify this list without also updating the frontstage source.
 */

'use strict';

const GENRES = [
  // Rock & Alternative
  'Rock',
  'Rock n Roll',
  'Grunge',
  'Metal',
  'Punk',
  'Alternative',
  'New Wave',

  // Pop & Indie
  'Pop',
  'Indie',
  'Britpop',
  'Mod',

  // Blues & Country
  'Blues',
  'R&B',
  'Country',
  'Americana',

  // Folk & Soul
  'Folk',
  'Soul',
  'Funk',
  'Motown',
  'Disco',

  // Electronic & Dance
  'Electronic',
  'Dance',

  // Other Genres
  'Jazz',
  'Classical',
  'Reggae',
  'Ska',
  'Latin',

  // Era tags
  '50s',
  '60s',
  '70s',
  '80s',
  '90s',
  '00s',

  // Catchall
  'Other'
];

// Case-insensitive lookup map: lowercase -> canonical
const GENRE_MAP = new Map();
GENRES.forEach(g => {
  GENRE_MAP.set(g.toLowerCase(), g);
});

// Special-case mappings for common variations
// R&B variations
GENRE_MAP.set('r and b', 'R&B');
GENRE_MAP.set('rhythm and blues', 'R&B');
GENRE_MAP.set('rnb', 'R&B');
GENRE_MAP.set('r & b', 'R&B');

// Rock n Roll variations
GENRE_MAP.set('rock and roll', 'Rock n Roll');
GENRE_MAP.set('rock & roll', 'Rock n Roll');
GENRE_MAP.set('rocknroll', 'Rock n Roll');
GENRE_MAP.set("rock'n'roll", 'Rock n Roll');
GENRE_MAP.set('rock \'n\' roll', 'Rock n Roll');

// Sub-genre mappings (flatten to parent)
const SUBGENRE_MAP = new Map([
  // Rock sub-genres -> Rock
  ['classic rock', 'Rock'],
  ['hard rock', 'Rock'],
  ['glam rock', 'Rock'],
  ['progressive rock', 'Rock'],
  ['prog rock', 'Rock'],
  ['psychedelic rock', 'Rock'],
  ['soft rock', 'Rock'],
  ['southern rock', 'Rock'],
  ['garage rock', 'Rock'],

  // Indie sub-genres -> Indie
  ['indie rock', 'Indie'],
  ['indie pop', 'Indie'],
  ['indie folk', 'Indie'],

  // Alternative sub-genres -> Alternative
  ['alternative rock', 'Alternative'],
  ['alt rock', 'Alternative'],

  // Pop sub-genres -> Pop
  ['pop rock', 'Pop'],
  ['synth pop', 'Pop'],
  ['synthpop', 'Pop'],
  ['power pop', 'Pop'],

  // Metal sub-genres -> Metal
  ['heavy metal', 'Metal'],
  ['thrash metal', 'Metal'],
  ['death metal', 'Metal'],
  ['nu metal', 'Metal'],
  ['nu-metal', 'Metal'],

  // Punk sub-genres -> Punk
  ['pop punk', 'Punk'],
  ['post-punk', 'Punk'],
  ['post punk', 'Punk'],
  ['punk rock', 'Punk'],
  ['hardcore punk', 'Punk'],

  // Blues sub-genres -> Blues
  ['blues rock', 'Blues'],
  ['electric blues', 'Blues'],
  ['chicago blues', 'Blues'],

  // Country sub-genres -> Country
  ['country rock', 'Country'],
  ['alt country', 'Country'],
  ['outlaw country', 'Country'],

  // Jazz sub-genres -> Jazz
  ['smooth jazz', 'Jazz'],
  ['jazz fusion', 'Jazz'],
  ['bebop', 'Jazz'],

  // Electronic sub-genres -> Electronic
  ['electronica', 'Electronic'],
  ['edm', 'Electronic'],
  ['synth', 'Electronic'],
  ['synthwave', 'Electronic'],

  // Dance sub-genres -> Dance
  ['house', 'Dance'],
  ['techno', 'Dance'],
  ['trance', 'Dance'],
  ['drum and bass', 'Dance'],
  ['dnb', 'Dance'],
]);

/**
 * Normalise a single genre string to canonical form.
 *
 * @param {string} genre - Input genre (any case)
 * @returns {string|null} - Canonical genre or null if off-list
 */
function normaliseGenre(genre) {
  if (!genre || typeof genre !== 'string') return null;

  const key = genre.trim().toLowerCase();
  if (!key) return null;

  // Try exact match first (case-insensitive)
  if (GENRE_MAP.has(key)) {
    return GENRE_MAP.get(key);
  }

  // Try sub-genre mapping
  if (SUBGENRE_MAP.has(key)) {
    return SUBGENRE_MAP.get(key);
  }

  return null;
}

/**
 * Validate and normalise an array of genres.
 *
 * @param {string[]} genres - Input genres
 * @returns {{valid: string[], invalid: string[]}} - Normalised valid genres and rejected invalid ones
 */
function normaliseGenres(genres) {
  if (!Array.isArray(genres)) {
    return { valid: [], invalid: [] };
  }

  const valid = [];
  const invalid = [];
  const seen = new Set(); // Dedupe

  for (const g of genres) {
    const normalised = normaliseGenre(g);
    if (normalised) {
      if (!seen.has(normalised)) {
        seen.add(normalised);
        valid.push(normalised);
      }
      // Duplicate of valid genre - just skip, don't mark invalid
    } else {
      invalid.push(g);
    }
  }

  return { valid, invalid };
}

/**
 * Check if a genre is valid (case-insensitive, includes sub-genre mappings).
 *
 * @param {string} genre - Input genre
 * @returns {boolean}
 */
function isValidGenre(genre) {
  return normaliseGenre(genre) !== null;
}

module.exports = {
  GENRES,
  normaliseGenre,
  normaliseGenres,
  isValidGenre,
};
