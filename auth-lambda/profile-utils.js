'use strict';

function cleanDisplayName(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 120) : null;
}

function displayNameFromClaims(claims) {
  if (!claims || typeof claims !== 'object') return null;
  const direct = cleanDisplayName(claims.name || claims.display_name);
  if (direct) return direct;
  const given = cleanDisplayName(claims.given_name);
  const family = cleanDisplayName(claims.family_name);
  return cleanDisplayName([given, family].filter(Boolean).join(' '));
}

module.exports = { cleanDisplayName, displayNameFromClaims };
