'use strict';

const OWNED_PROFILE_FIELDS = [
  'bio',
  'location',
  'locationType',
  'locationLat',
  'locationLng',
  'genres',
  'artistType',
  'actType',
  'acoustic',
  'facebookUrl',
  'instagramUrl',
  'websiteUrl',
  'youtubeUrl',
  'spotifyUrl',
  'soundcloudUrl',
  'bandcampUrl',
  'publishAvailability',
  'availabilityMode',
  'contactMethod',
  'phoneNumber',
  'whatsappNumber'
];

const URL_RULES = {
  facebookUrl: ['facebook.com', 'fb.com'],
  instagramUrl: ['instagram.com'],
  youtubeUrl: ['youtube.com', 'youtu.be'],
  spotifyUrl: ['open.spotify.com'],
  soundcloudUrl: ['soundcloud.com'],
  bandcampUrl: ['bandcamp.com']
};

function hostMatches(hostname, allowed) {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function validateUrlField(field, value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) {
    return `${field} must be a valid HTTPS URL`;
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return `${field} must be a valid HTTPS URL`;
  }

  if (parsed.protocol !== 'https:') return `${field} must use HTTPS`;
  const allowed = URL_RULES[field];
  if (allowed && !hostMatches(parsed.hostname, allowed)) {
    return `${field} must use an approved ${field.replace('Url', '')} host`;
  }
  return null;
}

function validatePhoneField(field, value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 32 || !/^[+()\d\s.-]{6,32}$/.test(value)) {
    return `${field} must be a valid phone number`;
  }
  return null;
}

function pickOwnedProfileFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { fields: {}, errors: ['Request body must be an object'] };
  }

  const fields = {};
  const errors = [];
  for (const field of OWNED_PROFILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) fields[field] = body[field];
  }

  if (Object.keys(fields).length === 0) {
    errors.push('No editable profile fields were provided');
    return { fields, errors };
  }

  for (const field of [...Object.keys(URL_RULES), 'websiteUrl']) {
    if (!Object.prototype.hasOwnProperty.call(fields, field)) continue;
    const error = validateUrlField(field, fields[field]);
    if (error) errors.push(error);
    else if (typeof fields[field] === 'string') fields[field] = fields[field].trim();
  }

  for (const field of ['phoneNumber', 'whatsappNumber']) {
    if (!Object.prototype.hasOwnProperty.call(fields, field)) continue;
    const error = validatePhoneField(field, fields[field]);
    if (error) errors.push(error);
    else if (typeof fields[field] === 'string') fields[field] = fields[field].trim() || null;
  }

  if (fields.bio !== undefined && (typeof fields.bio !== 'string' || fields.bio.length > 2500)) {
    errors.push('bio must be a string of 2500 characters or fewer');
  }
  if (fields.location !== undefined && (typeof fields.location !== 'string' || fields.location.length > 160)) {
    errors.push('location must be a string of 160 characters or fewer');
  }
  if (fields.locationType !== undefined && !['city', 'town', 'region', null].includes(fields.locationType)) {
    errors.push('locationType is invalid');
  }
  if (fields.locationLat !== undefined && fields.locationLat !== null &&
      (typeof fields.locationLat !== 'number' || fields.locationLat < -90 || fields.locationLat > 90)) {
    errors.push('locationLat is invalid');
  }
  if (fields.locationLng !== undefined && fields.locationLng !== null &&
      (typeof fields.locationLng !== 'number' || fields.locationLng < -180 || fields.locationLng > 180)) {
    errors.push('locationLng is invalid');
  }
  if (fields.genres !== undefined &&
      (!Array.isArray(fields.genres) || fields.genres.length > 20 || fields.genres.some((item) => typeof item !== 'string' || item.length > 60))) {
    errors.push('genres must contain at most 20 short values');
  }
  if (fields.actType !== undefined && fields.actType !== null &&
      (!Array.isArray(fields.actType) || fields.actType.length > 10 || fields.actType.some((item) => typeof item !== 'string' || item.length > 60))) {
    errors.push('actType must contain at most 10 short values');
  }
  if (fields.artistType !== undefined && fields.artistType !== null &&
      (typeof fields.artistType !== 'string' || fields.artistType.length > 60)) {
    errors.push('artistType is invalid');
  }
  for (const field of ['acoustic', 'publishAvailability']) {
    if (fields[field] !== undefined && typeof fields[field] !== 'boolean') errors.push(`${field} must be a boolean`);
  }
  if (fields.availabilityMode !== undefined && !['selected_dates_only', 'free_weekends'].includes(fields.availabilityMode)) {
    errors.push('availabilityMode is invalid');
  }
  if (fields.contactMethod !== undefined && !['phone', 'whatsapp'].includes(fields.contactMethod)) {
    errors.push('contactMethod is invalid');
  }

  return { fields, errors };
}

module.exports = {
  OWNED_PROFILE_FIELDS,
  URL_RULES,
  hostMatches,
  pickOwnedProfileFields,
  validatePhoneField,
  validateUrlField
};
