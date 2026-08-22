'use strict';

function isPublishedInEdition(record, edition) {
  const scopes = record?.publicationScopes;
  if (!Array.isArray(scopes) || scopes.length === 0) return edition === 'live';
  return scopes.includes(edition);
}

const EDITIONS = new Set(['live', 'brass']);
const PRIVILEGED_FIELDS = new Set(['publicationScopes', 'discoveryScopes', 'performerKind', 'domainProfiles', 'names', 'acts', 'venueKind', 'eventKind', 'productionId', 'productionName', 'conductorName']);
function hasPrivilegedIngestionFields(body = {}) { return Object.keys(body).some((key) => PRIVILEGED_FIELDS.has(key)); }
function validateEditionScopes(value, field, allowEmpty) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) return `${field} must be an array${allowEmpty ? '' : ' with at least one edition'}`;
  if (value.some((scope) => typeof scope !== 'string' || !EDITIONS.has(scope))) return `${field} contains an unknown edition`;
  if (new Set(value).size !== value.length) return `${field} must not contain duplicate editions`;
  return null;
}
function validateScopedIngestion(body = {}, entityType) {
  if (body.publicationScopes === undefined) return 'publicationScopes is required for scoped ingestion';
  { const error = validateEditionScopes(body.publicationScopes, 'publicationScopes', false); if (error) return error; }
  if (body.discoveryScopes !== undefined) { const error = validateEditionScopes(body.discoveryScopes, 'discoveryScopes', true); if (error) return error; }
  if (entityType === 'event' && body.eventKind !== undefined && body.eventKind !== 'concert') return 'eventKind must be concert';
  return null;
}
function editionMetadata(record = {}) { return { publicationScopes: record.publicationScopes, discoveryScopes: record.discoveryScopes, performerKind: record.performerKind, venueKind: record.venueKind, eventKind: record.eventKind }; }

module.exports = { isPublishedInEdition, hasPrivilegedIngestionFields, validateScopedIngestion, editionMetadata };
