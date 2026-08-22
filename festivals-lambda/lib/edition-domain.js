'use strict';

function isPublishedInEdition(record, edition) {
  const scopes = record?.publicationScopes;
  if (!Array.isArray(scopes) || scopes.length === 0) return edition === 'live';
  return scopes.includes(edition);
}

module.exports = { isPublishedInEdition };
