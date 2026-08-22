'use strict';

const EDITIONS = Object.freeze(['live', 'brass']);
const DEFAULT_EDITION = 'live';

function normaliseEdition(value) {
  if (typeof value !== 'string') return DEFAULT_EDITION;
  const edition = value.trim().toLowerCase();
  return EDITIONS.includes(edition) ? edition : DEFAULT_EDITION;
}

/**
 * Read publication scopes without breaking legacy records.
 * Existing records pre-date editions and therefore remain live by default.
 */
function getPublicationScopes(record) {
  if (!record || !Array.isArray(record.publicationScopes) || record.publicationScopes.length === 0) {
    return [DEFAULT_EDITION];
  }

  const scopes = [...new Set(record.publicationScopes
    .map((scope) => typeof scope === 'string' ? scope.trim().toLowerCase() : null)
    .filter((scope) => EDITIONS.includes(scope)))];

  return scopes.length > 0 ? scopes : [DEFAULT_EDITION];
}

function isPublishedInEdition(record, edition = DEFAULT_EDITION) {
  return getPublicationScopes(record).includes(normaliseEdition(edition));
}

/**
 * Discovery scope is intentionally NOT backwards-defaulted to brass.
 * Existing behaviour remains live; new brass-derived venues must opt in.
 */
function getDiscoveryScopes(record) {
  if (!record || !Array.isArray(record.discoveryScopes)) {
    return record && record.publicationScopes ? [] : [DEFAULT_EDITION];
  }

  return [...new Set(record.discoveryScopes
    .map((scope) => typeof scope === 'string' ? scope.trim().toLowerCase() : null)
    .filter((scope) => EDITIONS.includes(scope)))];
}

function canDriveDiscovery(record, edition = DEFAULT_EDITION) {
  return getDiscoveryScopes(record).includes(normaliseEdition(edition));
}

function brassVenueDefaults() {
  return {
    publicationScopes: ['brass'],
    discoveryScopes: []
  };
}

module.exports = {
  EDITIONS,
  DEFAULT_EDITION,
  normaliseEdition,
  getPublicationScopes,
  isPublishedInEdition,
  getDiscoveryScopes,
  canDriveDiscovery,
  brassVenueDefaults
};
