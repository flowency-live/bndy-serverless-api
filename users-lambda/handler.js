'use strict';

/**
 * Users domain boundary for saved gig filters.
 *
 * The historical Users Lambda is preserved in handler-legacy.js. This wrapper
 * extends its saved-filter contract with canonical Artist Type while keeping
 * the legacy route/auth/profile behaviour intact.
 *
 * Important distinction:
 * - WRITES are strict: malformed or unknown values are rejected.
 * - READS are tolerant: malformed historical members are dropped and valid
 *   members are canonicalised, so one bad old token never blanks the filter.
 *
 * `acoustic` remains a saved filter token for storage compatibility only. It is
 * matched against Artist.acoustic in bndy-app and is never an Artist actType.
 */

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const legacy = require('./handler-legacy');
const {
  GENRES,
  ARTIST_TYPES,
  ACT_TYPES,
  normaliseGenre,
  normaliseArtistType,
  normaliseActType
} = require('./lib/taxonomy');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });
const USERS_TABLE = 'bndy-users';
let JWT_SECRET = null;

const EMPTY_GIG_FILTER = Object.freeze({
  genres: [],
  actTypes: [],
  artistTypes: [],
  includeOpenMic: false,
  enabled: false
});

function methodOf(event) {
  return event.requestContext?.http?.method || event.httpMethod || '';
}

function pathOf(event) {
  return event.requestContext?.http?.path || event.rawPath || event.path || '';
}

function response(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  };
}

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, value] = cookie.trim().split('=');
    if (name) cookies[name] = value;
    return cookies;
  }, {});
}

async function getJWTSecret() {
  if (JWT_SECRET) return JWT_SECRET;
  try {
    const result = await ssm.getParameter({
      Name: '/bndy/auth/jwt-secret',
      WithDecryption: true
    }).promise();
    JWT_SECRET = result.Parameter.Value;
    return JWT_SECRET;
  } catch (error) {
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      return JWT_SECRET;
    }
    throw error;
  }
}

async function requireAuth(event) {
  let token = null;
  if (Array.isArray(event.cookies)) {
    const found = event.cookies.find((cookie) => cookie.startsWith('bndy_session='));
    if (found) token = found.split('=')[1];
  }
  if (!token) {
    const cookies = parseCookies(event.headers?.Cookie || event.headers?.cookie || '');
    token = cookies.bndy_session || null;
  }
  if (!token) return { error: 'Not authenticated', statusCode: 401 };

  try {
    const secret = await getJWTSecret();
    return { user: jwt.verify(token, secret) };
  } catch {
    return { error: 'Invalid session', statusCode: 401 };
  }
}

function parseBody(event) {
  try {
    return { body: JSON.parse(event.body || '{}') };
  } catch {
    return { error: response(400, { error: 'Invalid JSON body' }) };
  }
}

function unique(values) {
  return [...new Set(values)];
}

/** Tolerant read normaliser for historical DynamoDB values. */
function normaliseStoredGigFilter(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...EMPTY_GIG_FILTER, genres: [], actTypes: [], artistTypes: [] };
  }

  const genres = [];
  for (const raw of Array.isArray(value.genres) ? value.genres : []) {
    if (typeof raw !== 'string') continue;
    const normalised = normaliseGenre(raw);
    if (normalised) genres.push(normalised);
  }

  const actTypes = [];
  for (const raw of Array.isArray(value.actTypes) ? value.actTypes : []) {
    if (typeof raw !== 'string') continue;
    const key = raw.trim().toLowerCase();
    if (key === 'acoustic') {
      actTypes.push('acoustic');
      continue;
    }
    const normalised = normaliseActType(raw);
    if (normalised) actTypes.push(normalised);
  }

  const artistTypes = [];
  for (const raw of Array.isArray(value.artistTypes) ? value.artistTypes : []) {
    if (typeof raw !== 'string') continue;
    const normalised = normaliseArtistType(raw);
    if (normalised) artistTypes.push(normalised);
  }

  return {
    genres: unique(genres),
    actTypes: unique(actTypes),
    artistTypes: unique(artistTypes),
    includeOpenMic: value.includeOpenMic === true,
    enabled: value.enabled === true
  };
}

/** Strict write validator. Old clients may omit artistTypes; all other fields are required. */
function validateGigFilter(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: { error: 'gigFilter must be an object', code: 'INVALID_GIG_FILTER' } };
  }

  if (!Array.isArray(value.genres) || value.genres.length > 20) {
    return { error: { error: 'gigFilter.genres must be an array of up to 20 genre names', code: 'INVALID_GENRES' } };
  }
  const genres = [];
  const invalidGenres = [];
  for (const raw of value.genres) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 40) {
      invalidGenres.push(raw);
      continue;
    }
    const normalised = normaliseGenre(raw);
    if (!normalised) invalidGenres.push(raw);
    else genres.push(normalised);
  }
  if (invalidGenres.length) {
    return {
      error: {
        error: 'gigFilter.genres contains an invalid genre',
        code: 'INVALID_GENRES',
        invalidGenres,
        validGenres: GENRES
      }
    };
  }

  if (!Array.isArray(value.actTypes) || value.actTypes.length > 4) {
    return { error: { error: 'gigFilter.actTypes contains an invalid act type', code: 'INVALID_ACT_TYPE' } };
  }
  const actTypes = [];
  const invalidActTypes = [];
  for (const raw of value.actTypes) {
    if (typeof raw !== 'string' || !raw.trim()) {
      invalidActTypes.push(raw);
      continue;
    }
    const key = raw.trim().toLowerCase();
    if (key === 'acoustic') {
      actTypes.push('acoustic');
      continue;
    }
    const normalised = normaliseActType(raw);
    if (!normalised) invalidActTypes.push(raw);
    else actTypes.push(normalised);
  }
  if (invalidActTypes.length) {
    return {
      error: {
        error: 'gigFilter.actTypes contains an invalid act type',
        code: 'INVALID_ACT_TYPE',
        invalidActTypes,
        validActTypes: ACT_TYPES
      }
    };
  }

  const rawArtistTypes = value.artistTypes === undefined ? [] : value.artistTypes;
  if (!Array.isArray(rawArtistTypes) || rawArtistTypes.length > ARTIST_TYPES.length) {
    return { error: { error: 'gigFilter.artistTypes contains an invalid artist type', code: 'INVALID_ARTIST_TYPE' } };
  }
  const artistTypes = [];
  const invalidArtistTypes = [];
  for (const raw of rawArtistTypes) {
    if (typeof raw !== 'string' || !raw.trim()) {
      invalidArtistTypes.push(raw);
      continue;
    }
    const normalised = normaliseArtistType(raw);
    if (!normalised) invalidArtistTypes.push(raw);
    else artistTypes.push(normalised);
  }
  if (invalidArtistTypes.length) {
    return {
      error: {
        error: 'gigFilter.artistTypes contains an invalid artist type',
        code: 'INVALID_ARTIST_TYPE',
        invalidArtistTypes,
        validArtistTypes: ARTIST_TYPES
      }
    };
  }

  if (typeof value.includeOpenMic !== 'boolean' || typeof value.enabled !== 'boolean') {
    return {
      error: {
        error: 'gigFilter includeOpenMic and enabled must be booleans',
        code: 'INVALID_GIG_FILTER'
      }
    };
  }

  return {
    value: {
      genres: unique(genres),
      actTypes: unique(actTypes),
      artistTypes: unique(artistTypes),
      includeOpenMic: value.includeOpenMic,
      enabled: value.enabled
    }
  };
}

function asGetProfileEvent(event) {
  const requestContext = event.requestContext
    ? {
        ...event.requestContext,
        http: event.requestContext.http
          ? { ...event.requestContext.http, method: 'GET' }
          : event.requestContext.http
      }
    : event.requestContext;
  return { ...event, requestContext, httpMethod: 'GET', body: undefined };
}

async function rawGigFilter(userId) {
  const result = await dynamodb.get({
    TableName: USERS_TABLE,
    Key: { cognito_id: userId },
    ProjectionExpression: 'gig_filter'
  }).promise();
  return normaliseStoredGigFilter(result.Item?.gig_filter);
}

async function patchProfileResponseWithRawFilter(event, result, knownFilter) {
  if (!result || result.statusCode !== 200) return result;
  let parsed;
  try { parsed = JSON.parse(result.body || '{}'); } catch { return result; }
  if (!parsed.user) return result;

  let filter = knownFilter;
  if (!filter) {
    const auth = await requireAuth(event);
    if (auth.error) return result;
    filter = await rawGigFilter(auth.user.userId);
  }

  return {
    ...result,
    body: JSON.stringify({
      ...parsed,
      user: { ...parsed.user, gigFilter: normaliseStoredGigFilter(filter) }
    })
  };
}

async function handleGigFilterUpdate(event, context, body) {
  const auth = await requireAuth(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error });

  const checked = validateGigFilter(body.gigFilter);
  if (checked.error) return response(400, checked.error);

  // Preserve normal profile updates if a future client sends them alongside
  // gigFilter. Current bndy-app sends only the filter.
  const rest = { ...body };
  delete rest.gigFilter;
  if (Object.keys(rest).length > 0) {
    const delegated = await legacy.handler({ ...event, body: JSON.stringify(rest) }, context || {});
    if (!delegated || delegated.statusCode < 200 || delegated.statusCode >= 300) return delegated;
  }

  await dynamodb.update({
    TableName: USERS_TABLE,
    Key: { cognito_id: auth.user.userId },
    UpdateExpression: 'SET gig_filter = :gigFilter, updated_at = :updatedAt',
    ExpressionAttributeValues: {
      ':gigFilter': checked.value,
      ':updatedAt': new Date().toISOString()
    }
  }).promise();

  const profile = await legacy.handler(asGetProfileEvent(event), context || {});
  return patchProfileResponseWithRawFilter(event, profile, checked.value);
}

exports.handler = async (event, context) => {
  const method = methodOf(event);
  const path = pathOf(event);

  if (path === '/users/profile' && method === 'PUT' && event.body) {
    const parsed = parseBody(event);
    if (parsed.error) return parsed.error;
    if (Object.prototype.hasOwnProperty.call(parsed.body, 'gigFilter')) {
      return handleGigFilterUpdate(event, context, parsed.body);
    }
  }

  const result = await legacy.handler(event, context || {});

  // The legacy profile formatter predates artistTypes and drops that dimension.
  // Overlay the complete canonical raw filter on GET and ordinary profile PUTs.
  if (path === '/users/profile' && ['GET', 'PUT'].includes(method) && result?.statusCode === 200) {
    return patchProfileResponseWithRawFilter(event, result);
  }

  return result;
};
