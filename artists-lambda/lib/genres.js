'use strict';

/**
 * Backwards-compatible genre module.
 *
 * Existing handler code imports ./lib/genres. The authoritative taxonomy now
 * lives in ./lib/taxonomy (synced from shared/artist-domain/taxonomy.js), so
 * this module deliberately contains no genre list of its own.
 */

const {
  GENRES,
  LEGACY_GENRES,
  normaliseGenre,
  normaliseGenres
} = require('./taxonomy');

function isValidGenre(genre) {
  return normaliseGenre(genre) !== null;
}

module.exports = {
  GENRES,
  LEGACY_GENRES,
  normaliseGenre,
  normaliseGenres,
  isValidGenre
};
