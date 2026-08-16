'use strict';

/**
 * Users domain boundary for saved gig filters.
 *
 * The historical Users Lambda is preserved in handler-legacy.js. This wrapper
 * fixes the cross-domain contract for My Filters without risking unrelated
 * profile/user behaviour: artistTypes are now persisted, taxonomy values are
 * canonicalised, and the legacy `acoustic` saved-filter token remains supported
 * while matching it against artist.acoustic in bndy-app.
 */

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const legacy = require('./handler-legacy');
const {
  GENRES,
  ARTIST_TYPES,
  ACT_TYPES,
  normaliseGenres,
  normaliseArtistType,
  normaliseActTypes
} = require('./lib/taxonomy');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });
const USERS_TABLE = 'bndy-users';
let JWT_SECRET = null;

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

function normaliseGigFilter(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  const genreResult = normaliseGenres(Array.isArray(input.genres) ? input.genres : []);
  if (genreResult.invalid.length) {
    return {
      error: {
        error: 'Invalid genres',
        code: 'INVALID_GENRES',
        invalidGenres: genreResult.invalid,
        validGenres: GENRES
      }
    };
  }

  const rawArtistTypes = Array.isArray(input.artistTypes) ? input.artistTypes : [];
  const artistTypes = [];
  const invalidArtistTypes = [];
  for (const raw of rawArtistTypes) {
    const normalised = normaliseArtistType(raw);
    if (!normalised) invalidArtistTypes.push(raw);
    else if (!artistTypes.includes(normalised)) artistTypes.push(normalised);
  }
  if (invalidArtistTypes.length) {
    return {
      error: {
        error: 'Invalid artist type',
        code: 'INVALID_ARTIST_TYPE',
        invalidArtistTypes,
        validArtistTypes: ARTIST_TYPES
      }
    };
  }

  const actResult = normaliseActTypes(Array.isArray(input.actTypes) ? input.actTypes : []);
  if (actResult.invalid.length) {
    return {
      error: {
        error: 'Invalid act type',
        code: 'INVALID_ACT_TYPE',
        invalidActTypes: actResult.invalid,
        validActTypes: ACT_TYPES
      }
    };
  }

  // `acoustic` remains a saved-filter token for storage compatibility only.
  // It is NOT an artist actType; bndy-app interprets it against artist.acoustic.
  const actTypes = [...actResult.valid];
  if (actResult.acoustic) actTypes.push('acoustic');

  return {
    value: {
      genres: genreResult.valid,
      actTypes,
      artistTypes,
      includeOpenMic: input.includeOpenMic === true,
      enabled: input.enabled === true
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
  return normaliseGigFilter(result.Item?.gig_filter).value || {
    genres: [], actTypes: [], artistTypes: [], includeOpenMic: false, enabled: false
  };
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
      user: { ...parsed.user, gigFilter: filter }
    })
  };
}

async function handleGigFilterUpdate(event, context, body) {
  const auth = await requireAuth(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error });

  const checked = normaliseGigFilter(body.gigFilter);
  if (checked.error) return response(400, checked.error);

  // If a caller mixed normal profile fields with gigFilter, preserve existing
  // behaviour for those fields first. The current bndy-app sends only gigFilter,
  // but this keeps the route backwards-compatible for any other active client.
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

  // The legacy profile formatter predates artistTypes and would otherwise hide
  // the field even when it is correctly stored. Overlay the canonical raw filter
  // on reads so current clients receive the complete contract.
  if (path === '/users/profile' && method === 'GET') {
    return patchProfileResponseWithRawFilter(event, result);
  }

  return result;
};
