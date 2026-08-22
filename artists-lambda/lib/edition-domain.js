'use strict';

function isPublishedInEdition(record, edition) {
  const scopes = record?.publicationScopes;
  if (!Array.isArray(scopes) || scopes.length === 0) return edition === 'live';
  return scopes.includes(edition);
}

const EDITIONS = new Set(['live', 'brass']);
const PRIVILEGED_FIELDS = new Set([
  'publicationScopes', 'discoveryScopes', 'performerKind', 'domainProfiles',
  'names', 'acts', 'venueKind', 'eventKind', 'productionId',
  'productionName', 'conductorName'
]);

function hasPrivilegedIngestionFields(body = {}) {
  return Object.keys(body).some((key) => PRIVILEGED_FIELDS.has(key));
}

function validateEditionScopes(value, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return `${field} must be an array${allowEmpty ? '' : ' with at least one edition'}`;
  if (value.some((scope) => typeof scope !== 'string' || !EDITIONS.has(scope))) return `${field} contains an unknown edition`;
  if (new Set(value).size !== value.length) return `${field} must not contain duplicate editions`;
  return null;
}

function validateScopedIngestion(body = {}, entityType) {
  if (body.publicationScopes === undefined) return 'publicationScopes is required for scoped ingestion';
  const publicationError = validateEditionScopes(body.publicationScopes, 'publicationScopes', { allowEmpty: false });
  if (publicationError) return publicationError;
  if ((entityType === 'artist' || entityType === 'venue') && body.discoveryScopes === undefined) return 'discoveryScopes is required for scoped ingestion';
  if (body.discoveryScopes !== undefined) {
    const error = validateEditionScopes(body.discoveryScopes, 'discoveryScopes');
    if (error) return error;
  }
  if (entityType === 'artist' && body.performerKind !== undefined && body.performerKind !== 'brass_band') return 'performerKind must be brass_band';
  if (entityType === 'artist' && body.names !== undefined && !Array.isArray(body.names)) return 'names must be an array';
  if (entityType === 'artist' && body.acts !== undefined && !Array.isArray(body.acts)) return 'acts must be an array';
  if (entityType === 'artist' && body.domainProfiles !== undefined && (!body.domainProfiles || typeof body.domainProfiles !== 'object' || Array.isArray(body.domainProfiles))) return 'domainProfiles must be an object';
  if (entityType === 'venue' && body.venueKind !== undefined && body.venueKind !== 'concert_hall') return 'venueKind must be concert_hall';
  if (entityType === 'event' && body.eventKind !== undefined && body.eventKind !== 'concert') return 'eventKind must be concert';
  return null;
}

function editionMetadata(record = {}) {
  return {
    publicationScopes: record.publicationScopes,
    discoveryScopes: record.discoveryScopes,
    performerKind: record.performerKind,
    venueKind: record.venueKind,
    eventKind: record.eventKind
  };
}

module.exports = { isPublishedInEdition, hasPrivilegedIngestionFields, validateScopedIngestion, editionMetadata };
