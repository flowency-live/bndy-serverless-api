'use strict';

/**
 * Artist Domain boundary.
 *
 * The historical Artists Lambda handler is intentionally preserved in
 * handler-legacy.js. This thin entrypoint owns cross-client artist taxonomy
 * semantics before delegating to it, which lets Backstage, Godmode, Curator,
 * Gig Wizard and MCP roll forward independently without storing different
 * representations of the same classification.
 *
 * bndy-frontstage is retired and is deliberately not a migration consumer.
 */

const AWS = require('aws-sdk');
const legacy = require('./handler-legacy');
const {
  GENRES,
  publicTaxonomy,
  normaliseGenres,
  normaliseClassification
} = require('./lib/taxonomy');
const {
  requireRole: requireCuratorRole,
  logActivity: logCuratorActivity,
  pickFields
} = require('./curator-core');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

const CURATOR_ARTIST_FIELDS = [
  'bio', 'location', 'locationType', 'locationLat', 'locationLng',
  'genres', 'artistType', 'actType', 'acoustic',
  'facebookUrl', 'instagramUrl', 'websiteUrl', 'socialMediaUrls', 'profileImageUrl'
];

// Same dependency shape as the legacy curator handler. The Artists Lambda has
// JWT_SECRET in env; curator-core falls back to it when this stub rejects.
const CURATOR_DEPS = {
  dynamodb,
  ssm: { getParameter: () => ({ promise: () => Promise.reject(new Error('use JWT_SECRET env')) }) }
};

function methodOf(event) {
  return event.requestContext?.http?.method || event.httpMethod || '';
}

function pathOf(event) {
  return event.requestContext?.http?.path || event.rawPath || event.path || '';
}

function response(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body)
  };
}

function parseBody(event) {
  if (!event.body) return { body: null };
  try {
    return { body: JSON.parse(event.body) };
  } catch {
    return { error: response(400, { error: 'Invalid JSON body' }) };
  }
}

function normaliseAcousticInput(value) {
  if (value === undefined) return { supplied: false };
  if (typeof value === 'boolean') return { supplied: true, value };
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase();
    if (key === 'true') return { supplied: true, value: true };
    if (key === 'false') return { supplied: true, value: false };
  }
  return { supplied: true, invalid: true };
}

/**
 * Canonicalise only fields supplied by the caller. Omitted fields remain
 * omitted, which is essential for PATCH/PUT updates that intentionally touch
 * only one part of an artist.
 */
function normaliseArtistBody(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { body: input };
  }

  const body = { ...input };

  if (input.genres !== undefined) {
    const genreResult = normaliseGenres(input.genres == null ? [] : input.genres);
    if (genreResult.invalid.length > 0) {
      return {
        error: response(400, {
          error: 'Invalid genres',
          code: 'INVALID_GENRES',
          invalidGenres: genreResult.invalid,
          validGenres: GENRES
        })
      };
    }
    body.genres = genreResult.valid;
  }

  const acousticInput = normaliseAcousticInput(input.acoustic);
  if (acousticInput.invalid) {
    return {
      error: response(400, {
        error: 'Invalid acoustic value',
        code: 'INVALID_ACOUSTIC',
        message: 'acoustic must be true or false'
      })
    };
  }

  // Pass the strictly-normalised explicit boolean to the taxonomy helper so
  // string "false" can never become truthy through Boolean("false").
  const classificationInput = acousticInput.supplied
    ? { ...input, acoustic: acousticInput.value }
    : input;
  const classification = normaliseClassification(classificationInput);

  if (classification.invalidArtistType) {
    return {
      error: response(400, {
        error: 'Invalid artist type',
        code: 'INVALID_ARTIST_TYPE',
        invalidArtistType: classification.invalidArtistType,
        validArtistTypes: publicTaxonomy().artistTypes
      })
    };
  }

  if (classification.invalidActTypes.length > 0) {
    return {
      error: response(400, {
        error: 'Invalid act type',
        code: 'INVALID_ACT_TYPE',
        invalidActTypes: classification.invalidActTypes,
        validActTypes: publicTaxonomy().actTypes
      })
    };
  }

  if (classification.artistTypeSupplied) {
    // The legacy update path reads artistType (camelCase), so collapse both
    // historical request spellings to that one canonical input contract.
    body.artistType = classification.artistType;
    delete body.artist_type;
  }

  if (classification.actTypeSupplied) {
    body.actType = classification.actType && classification.actType.length
      ? classification.actType
      : null;
  }

  if (classification.acoustic !== undefined) {
    body.acoustic = classification.acoustic;
  }

  return { body };
}

function rewriteAsApprovedArtistUpdate(event, artistId, body) {
  const canonicalPath = `/api/artists/${artistId}`;
  const requestContext = event.requestContext
    ? {
        ...event.requestContext,
        http: event.requestContext.http
          ? { ...event.requestContext.http, path: canonicalPath }
          : event.requestContext.http
      }
    : event.requestContext;

  return {
    ...event,
    requestContext,
    rawPath: canonicalPath,
    path: canonicalPath,
    pathParameters: { ...(event.pathParameters || {}), id: artistId },
    body: JSON.stringify(body),
    __curatorApproved: true
  };
}

async function artistName(artistId) {
  try {
    const result = await dynamodb.get({
      TableName: 'bndy-artists',
      Key: { id: artistId },
      ProjectionExpression: '#name',
      ExpressionAttributeNames: { '#name': 'name' }
    }).promise();
    return result.Item?.name || null;
  } catch {
    return null;
  }
}

/**
 * Curator needed special handling because the legacy whitelist predates
 * artistType + acoustic. We keep the whitelist/security boundary here, run the
 * same curator/staff role gate, then delegate to the ordinary update function
 * with the internal approval flag. This also means classification receives the
 * exact same validation and storage semantics as Backstage/Godmode.
 */
async function handleCuratorUpdate(event, context) {
  const gate = await requireCuratorRole(CURATOR_DEPS, event, ['curator', 'staff']);
  if (gate.error) return response(gate.statusCode || 403, { error: gate.error });

  const artistId = event.pathParameters?.id;
  if (!artistId) return response(400, { error: 'Artist ID is required' });

  const parsed = parseBody(event);
  if (parsed.error) return parsed.error;
  const fields = pickFields(parsed.body || {}, CURATOR_ARTIST_FIELDS);
  if (Object.keys(fields).length === 0) {
    return response(400, { error: `No editable field in body. Allowed: ${CURATOR_ARTIST_FIELDS.join(', ')}` });
  }

  const normalised = normaliseArtistBody(fields);
  if (normalised.error) return normalised.error;

  const delegated = rewriteAsApprovedArtistUpdate(event, artistId, normalised.body);
  const result = await legacy.handler(delegated, context || {});

  if (result?.statusCode === 200) {
    await logCuratorActivity(dynamodb, {
      actorCognitoId: gate.user.userId,
      actorName: gate.dbUser?.display_name,
      action: 'edit',
      entityType: 'artist',
      entityId: artistId,
      entityName: await artistName(artistId),
      detail: Object.keys(fields).join(',')
    });
  }
  return result;
}

exports.handler = async (event, context) => {
  const method = methodOf(event);
  const path = pathOf(event);

  // Stable, public, cacheable source for every active UI. The retired
  // bndy-frontstage codebase is intentionally not a consumer.
  if (method === 'GET' && path === '/api/artists/taxonomy') {
    return response(200, publicTaxonomy(), { 'Cache-Control': 'public, max-age=3600' });
  }

  if (method === 'PUT' && path.startsWith('/api/curator/artists/')) {
    return handleCuratorUpdate(event, context);
  }

  // All other artist write surfaces pass through one compatibility normaliser:
  // Backstage, Godmode, public/community wizard, MCP and automation. Requests
  // without taxonomy fields are delegated byte-for-byte apart from a harmless
  // JSON re-serialisation.
  if (['POST', 'PUT', 'PATCH'].includes(method) && event.body) {
    const parsed = parseBody(event);
    if (parsed.error) return parsed.error;
    const normalised = normaliseArtistBody(parsed.body);
    if (normalised.error) return normalised.error;
    event = { ...event, body: JSON.stringify(normalised.body) };
  }

  return legacy.handler(event, context || {});
};
