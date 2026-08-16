'use strict';

/**
 * Backwards-compatible genre module for Events Agent.
 *
 * The authoritative list and normalisation rules are synced from
 * shared/artist-domain/taxonomy.js into ./taxonomy.js. Keep this wrapper while
 * older agent code still imports ./lib/genres.
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
