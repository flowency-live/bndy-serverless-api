/**
 * Curator core (backlog feature 4). Copied into each entity lambda —
 * the repo pattern keeps every lambda self-contained.
 *
 * Provides:
 *   requireRole(deps, event, roles)  — cookie session + role check on bndy-users
 *   logActivity(dynamodb, entry)     — one row in bndy-activity-log
 *   hideEntity / restoreEntity       — soft delete: hidden flag, never destroy
 *
 * Roles: 'curator' and 'staff' can edit + hide. Restore needs 'staff'
 * (or platformAdmin). platformAdmin always passes every gate.
 */

const jwt = require('jsonwebtoken');

const USERS_TABLE = 'bndy-users';
const ACTIVITY_TABLE = 'bndy-activity-log';

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

/**
 * Verify the session cookie AND the role on the user record.
 * @returns {Object} { user, dbUser, role } on success; { error, statusCode } on failure
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

  if (dbUser.platformAdmin || roles.includes(role)) {
    return { user: session, dbUser, role };
  }
  return { error: 'Curator access required', statusCode: 403 };
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

/** Keep only whitelisted keys from a request body. */
function pickFields(body, allowed) {
  const out = {};
  for (const key of allowed) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

/**
 * Soft delete: set the hidden flag. extraSet lets events also flip isPublic.
 */
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
  let expr = 'SET #hidden = :false REMOVE hidden_by, hidden_at, hidden_reason';
  // extraSet must merge into SET before REMOVE — rebuild in order
  const setParts = ['#hidden = :false'];
  Object.entries(extraSet).forEach(([k, v], i) => {
    names[`#x${i}`] = k;
    values[`:x${i}`] = v;
    setParts.push(`#x${i} = :x${i}`);
  });
  expr = `SET ${setParts.join(', ')} REMOVE hidden_by, hidden_at, hidden_reason`;
  await dynamodb.update({
    TableName: tableName,
    Key: { id },
    ConditionExpression: 'attribute_exists(id)',
    UpdateExpression: expr,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values
  }).promise();
}

module.exports = { requireRole, logActivity, pickFields, hideEntity, restoreEntity };
