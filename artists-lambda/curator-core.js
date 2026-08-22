/**
 * Curator core. Copied into each entity lambda because every Lambda package is
 * deliberately self-contained.
 *
 * Existing curators with no curator_access document retain the historical
 * global/edit-anything behaviour. A policy only restricts role=curator; staff,
 * platformAdmin and MCP service-token flows are unchanged.
 */

const jwt = require('jsonwebtoken');

const USERS_TABLE = 'bndy-users';
const ACTIVITY_TABLE = 'bndy-activity-log';
const ENTITY_TABLES = Object.freeze({
  artist: 'bndy-artists',
  venue: 'bndy-venues',
  event: 'bndy-events',
  festival: 'bndy-festivals'
});

let JWT_SECRET = null;

async function getJWTSecret(ssm) {
  if (JWT_SECRET) return JWT_SECRET;
  try {
    const result = await ssm.getParameter({ Name: '/bndy/auth/jwt-secret', WithDecryption: true }).promise();
    JWT_SECRET = result.Parameter.Value;
    return JWT_SECRET;
  } catch (error) {
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      return JWT_SECRET;
    }
    throw new Error('JWT_SECRET not available from SSM or environment');
  }
}

function readSessionToken(event) {
  if (event.cookies && Array.isArray(event.cookies)) {
    const c = event.cookies.find((x) => x.startsWith('bndy_session='));
    if (c) return c.split('=')[1];
  }
  const header = event.headers?.Cookie || event.headers?.cookie || '';
  const found = header.split(';').map((x) => x.trim()).find((x) => x.startsWith('bndy_session='));
  return found ? found.split('=')[1] : null;
}

function methodOf(event) {
  return event.requestContext?.http?.method || event.httpMethod || '';
}

function pathOf(event) {
  return event.requestContext?.http?.path || event.rawPath || event.path || '';
}

function normalisePostcodeToken(value) {
  return typeof value === 'string' ? value.toUpperCase().replace(/\s+/g, '') : '';
}

function normaliseCuratorAccess(dbUser) {
  const raw = dbUser?.curator_access;
  if (!raw || typeof raw !== 'object') {
    return { scope: 'global', postcodePrefixes: [], ownRecordsOnly: false };
  }
  const prefixes = Array.isArray(raw.postcode_prefixes)
    ? raw.postcode_prefixes.map(normalisePostcodeToken).filter(Boolean)
    : [];
  return {
    scope: raw.scope === 'postcode' ? 'postcode' : 'global',
    postcodePrefixes: [...new Set(prefixes)],
    ownRecordsOnly: raw.own_records_only === true
  };
}

/**
 * Return the outward code and postcode area without using naive startsWith.
 * ST1 must not match ST10; ST (area) deliberately matches both.
 */
function postcodeParts(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  let outward = '';
  if (trimmed.includes(' ')) {
    outward = trimmed.split(/\s+/)[0];
  } else {
    const compact = normalisePostcodeToken(trimmed);
    const full = compact.match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/);
    outward = full ? full[1] : compact;
  }
  const area = (outward.match(/^[A-Z]{1,2}/) || [])[0] || '';
  return outward && area ? { outward, area } : null;
}

function postcodeAllowed(access, postcode) {
  if (access.scope !== 'postcode') return true;
  const parts = postcodeParts(postcode);
  if (!parts || access.postcodePrefixes.length === 0) return false;
  return access.postcodePrefixes.some((token) => {
    if (/^[A-Z]{1,2}$/.test(token)) return parts.area === token;
    return parts.outward === token;
  });
}

function creatorOf(item) {
  return item?.createdBy || item?.created_by || item?.created_by_user_id || null;
}

async function getItem(dynamodb, tableName, id) {
  if (!id) return null;
  const result = await dynamodb.get({ TableName: tableName, Key: { id } }).promise();
  return result.Item || null;
}

async function getVenuePostcode(dynamodb, venueId, cache) {
  if (!venueId) return null;
  if (cache.has(venueId)) return cache.get(venueId);
  const venue = await getItem(dynamodb, ENTITY_TABLES.venue, venueId);
  const postcode = venue?.postcode || venue?.postalCode || venue?.postal_code || null;
  cache.set(venueId, postcode);
  return postcode;
}

async function assertEntityAllowed(dynamodb, gate, access, entityType, item, venueCache, proposedVenueIds) {
  if (!item) return { error: `${entityType[0].toUpperCase()}${entityType.slice(1)} not found`, statusCode: 404 };

  const mine = creatorOf(item) === gate.user.userId;
  if (access.ownRecordsOnly && !mine) {
    return { error: 'This curator can only modify records they created', statusCode: 403 };
  }

  if (access.scope !== 'postcode') return null;

  // Artists have no authoritative postcode. Restricted curators may therefore
  // modify an artist only when they created that artist themselves.
  if (entityType === 'artist') {
    return mine ? null : { error: 'Postcode-restricted curators can only modify artists they created', statusCode: 403 };
  }

  if (entityType === 'venue') {
    return postcodeAllowed(access, item.postcode || item.postalCode || item.postal_code)
      ? null
      : { error: 'Venue is outside this curator’s postcode access', statusCode: 403 };
  }

  if (entityType === 'event') {
    const postcode = await getVenuePostcode(dynamodb, item.venueId || item.venue_id, venueCache);
    return postcodeAllowed(access, postcode)
      ? null
      : { error: 'Event venue is outside this curator’s postcode access', statusCode: 403 };
  }

  if (entityType === 'festival') {
    const requested = Array.isArray(proposedVenueIds) ? proposedVenueIds.filter(Boolean) : [];
    const stored = [item.primaryVenueId, ...(Array.isArray(item.venueIds) ? item.venueIds : [])].filter(Boolean);
    const venueIds = [...new Set(requested.length ? requested : stored)];

    // Drafts can temporarily have no venue. With no geography to evaluate,
    // only the curator who created the draft may modify it.
    if (venueIds.length === 0) {
      return mine ? null : { error: 'Festival has no venue postcode to match this curator’s access', statusCode: 403 };
    }

    for (const venueId of venueIds) {
      const postcode = await getVenuePostcode(dynamodb, venueId, venueCache);
      if (!postcodeAllowed(access, postcode)) {
        return { error: 'Festival includes a venue outside this curator’s postcode access', statusCode: 403 };
      }
    }
  }

  return null;
}

function parseBody(event) {
  try { return JSON.parse(event.body || '{}'); } catch { return {}; }
}

/** Enforce the policy on an existing curator write before its handler mutates data. */
async function enforceCuratorPolicy(deps, event, gate) {
  const access = normaliseCuratorAccess(gate.dbUser);
  if (access.scope === 'global' && !access.ownRecordsOnly) return null;

  const method = methodOf(event).toUpperCase();
  const path = pathOf(event);
  if (method === 'GET' || !path.includes('/api/curator/')) return null;

  const dynamodb = deps.dynamodb;
  const venueCache = new Map();
  const body = parseBody(event);

  // Creating a festival draft is safe: the festival handler stamps createdBy.
  // Geography is enforced as soon as venue linkage is added/changed.
  if (path === '/api/curator/festivals' && method === 'POST') return null;

  if (path.endsWith('/festival-tag')) {
    const festival = await getItem(dynamodb, ENTITY_TABLES.festival, body.festivalId);
    const festivalCheck = await assertEntityAllowed(dynamodb, gate, access, 'festival', festival, venueCache);
    if (festivalCheck) return festivalCheck;

    const ids = [...new Set([
      ...(Array.isArray(body.add) ? body.add : []),
      ...(Array.isArray(body.remove) ? body.remove : [])
    ].filter(Boolean))];
    for (const id of ids) {
      const eventItem = await getItem(dynamodb, ENTITY_TABLES.event, id);
      const check = await assertEntityAllowed(dynamodb, gate, access, 'event', eventItem, venueCache);
      if (check) return check;
    }
    return null;
  }

  const match = path.match(/\/api\/curator\/(artists|venues|events|festivals)\/([^/]+)/);
  if (!match) return null;
  const singular = { artists: 'artist', venues: 'venue', events: 'event', festivals: 'festival' }[match[1]];
  const id = event.pathParameters?.id || match[2];
  const item = await getItem(dynamodb, ENTITY_TABLES[singular], id);

  let proposedVenueIds;
  if (singular === 'festival') {
    proposedVenueIds = [];
    if (body.primaryVenueId) proposedVenueIds.push(body.primaryVenueId);
    if (Array.isArray(body.venueIds)) proposedVenueIds.push(...body.venueIds);
  }

  return assertEntityAllowed(dynamodb, gate, access, singular, item, venueCache, proposedVenueIds);
}

/**
 * Verify the session cookie and role on bndy-users. Policy is read from the
 * same database record on every curator write, so changing Godmode access takes
 * effect immediately and requires no JWT/session rotation.
 */
async function requireRole(deps, event, roles) {
  const { dynamodb, ssm } = deps;
  const sessionToken = readSessionToken(event);
  if (!sessionToken) return { error: 'Not authenticated', statusCode: 401 };

  let session;
  try {
    const secret = await getJWTSecret(ssm);
    session = jwt.verify(sessionToken, secret);
  } catch (e) {
    return { error: 'Invalid session', statusCode: 401 };
  }

  const userResult = await dynamodb.get({
    TableName: USERS_TABLE,
    Key: { cognito_id: session.userId }
  }).promise();

  if (!userResult.Item) return { error: 'User not found', statusCode: 404 };

  const dbUser = userResult.Item;
  const role = dbUser.role || (dbUser.platformAdmin ? 'staff' : 'user');
  if (!(dbUser.platformAdmin || roles.includes(role))) {
    return { error: 'Curator access required', statusCode: 403 };
  }

  const gate = { user: session, dbUser, role };
  if (!dbUser.platformAdmin && role === 'curator') {
    const denied = await enforceCuratorPolicy(deps, event, gate);
    if (denied) return denied;
  }
  return gate;
}

/** Write one audit row. Failures log but never fail the main write. */
async function logActivity(dynamodb, { actorCognitoId, actorName, action, entityType, entityId, entityName, detail }) {
  try {
    const at = new Date().toISOString();
    const suffix = Math.random().toString(36).slice(2, 10);
    await dynamodb.put({
      TableName: ACTIVITY_TABLE,
      Item: {
        user_id: actorCognitoId,
        sk: `${at}#${suffix}`,
        at,
        actor_name: actorName || null,
        action,
        entity_type: entityType,
        entity_id: entityId,
        entity_name: entityName || null,
        detail: detail || null,
        gsi_pk: 'ALL'
      }
    }).promise();
  } catch (error) {
    console.error('[CURATOR] Activity log write failed:', error.message);
  }
}

function pickFields(body, allowed) {
  const out = {};
  for (const key of allowed) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

async function hideEntity(dynamodb, { tableName, id, actor, reason, extraSet = {} }) {
  const now = new Date().toISOString();
  const names = { '#hidden': 'hidden' };
  const values = { ':true': true, ':by': actor, ':at': now, ':reason': reason || null };
  let expr = 'SET #hidden = :true, hidden_by = :by, hidden_at = :at, hidden_reason = :reason';
  Object.entries(extraSet).forEach(([k, v], i) => {
    names[`#x${i}`] = k;
    values[`:x${i}`] = v;
    expr += `, #x${i} = :x${i}`;
  });
  await dynamodb.update({
    TableName: tableName,
    Key: { id },
    ConditionExpression: 'attribute_exists(id)',
    UpdateExpression: expr,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values
  }).promise();
}

async function restoreEntity(dynamodb, { tableName, id, extraSet = {} }) {
  const names = { '#hidden': 'hidden' };
  const values = { ':false': false };
  const setParts = ['#hidden = :false'];
  Object.entries(extraSet).forEach(([k, v], i) => {
    names[`#x${i}`] = k;
    values[`:x${i}`] = v;
    setParts.push(`#x${i} = :x${i}`);
  });
  await dynamodb.update({
    TableName: tableName,
    Key: { id },
    ConditionExpression: 'attribute_exists(id)',
    UpdateExpression: `SET ${setParts.join(', ')} REMOVE hidden_by, hidden_at, hidden_reason`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values
  }).promise();
}

module.exports = {
  requireRole,
  logActivity,
  pickFields,
  hideEntity,
  restoreEntity,
  normaliseCuratorAccess,
  postcodeAllowed,
  postcodeParts
};
