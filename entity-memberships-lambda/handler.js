const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });
const TABLE = process.env.ENTITY_MEMBERSHIPS_TABLE || 'bndy-entity-memberships';
let JWT_SECRET = null;

async function getJWTSecret() {
  if (JWT_SECRET) return JWT_SECRET;
  try {
    const result = await ssm.getParameter({ Name: '/bndy/auth/jwt-secret', WithDecryption: true }).promise();
    JWT_SECRET = result.Parameter.Value;
    return JWT_SECRET;
  } catch (error) {
    if (process.env.JWT_SECRET) { JWT_SECRET = process.env.JWT_SECRET; return JWT_SECRET; }
    throw error;
  }
}

function response(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
function parseBody(event) { return !event.body ? {} : typeof event.body === 'string' ? JSON.parse(event.body) : event.body; }
function parseCookies(header) {
  if (!header) return {};
  return header.split(';').reduce((out, part) => { const [name, ...rest] = part.trim().split('='); out[name] = rest.join('='); return out; }, {});
}
async function requireAuth(event) {
  let token = null;
  if (Array.isArray(event.cookies)) {
    const cookie = event.cookies.find((value) => value.startsWith('bndy_session='));
    if (cookie) token = cookie.slice('bndy_session='.length);
  } else token = parseCookies(event.headers?.Cookie || event.headers?.cookie || '').bndy_session;
  if (!token) return { error: 'Not authenticated', statusCode: 401 };
  try {
    const session = jwt.verify(token, await getJWTSecret());
    const user = await dynamodb.get({ TableName: 'bndy-users', Key: { cognito_id: session.userId } }).promise();
    return { user: { ...session, platformAdmin: user.Item?.platformAdmin === true } };
  } catch { return { error: 'Invalid session', statusCode: 401 }; }
}

async function getMemberships(entityId) {
  const result = await dynamodb.query({ TableName: TABLE, IndexName: 'entity_id-index', KeyConditionExpression: 'entity_id = :id', ExpressionAttributeValues: { ':id': entityId } }).promise();
  return result.Items || [];
}
async function requireManager(event, entityId, ownerOnly = false) {
  const auth = await requireAuth(event);
  if (auth.error) return auth;
  if (auth.user.platformAdmin) return auth;
  const memberships = await getMemberships(entityId);
  const own = memberships.find((item) => item.user_id === auth.user.userId && item.status === 'active');
  if (!own) return { error: 'Entity access required', statusCode: 403 };
  const allowed = ownerOnly ? own.role === 'owner' : ['owner', 'admin'].includes(own.role);
  return allowed ? { ...auth, membership: own } : { error: ownerOnly ? 'Owner access required' : 'Owner or admin access required', statusCode: 403 };
}

async function resolveUser(body) {
  if (body.userId) {
    const direct = await dynamodb.get({ TableName: 'bndy-users', Key: { cognito_id: body.userId } }).promise();
    return direct.Item || null;
  }
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) return null;
  // There is no email GSI on the retained users table yet. Delegate management is low-volume;
  // scan here is bounded operationally and can migrate to an email index without changing API shape.
  let startKey;
  do {
    const result = await dynamodb.scan({ TableName: 'bndy-users', ExclusiveStartKey: startKey, FilterExpression: 'email = :email', ExpressionAttributeValues: { ':email': email }, Limit: 100 }).promise();
    if (result.Items?.[0]) return result.Items[0];
    startKey = result.LastEvaluatedKey;
  } while (startKey);
  return null;
}

async function listEntity(event, entityId) {
  const auth = await requireManager(event, entityId);
  if (auth.error) return response(auth.statusCode, { error: auth.error });
  const memberships = await getMemberships(entityId);
  const resolved = await Promise.all(memberships.map(async (item) => {
    const user = await dynamodb.get({ TableName: 'bndy-users', Key: { cognito_id: item.user_id } }).promise();
    return { ...item, user: user.Item ? { email: user.Item.email || null, displayName: user.Item.display_name || user.Item.username || null } : null };
  }));
  return response(200, { memberships: resolved });
}

async function addDelegate(event, entityId) {
  const auth = await requireManager(event, entityId, true);
  if (auth.error) return response(auth.statusCode, { error: auth.error });
  let body;
  try { body = parseBody(event); } catch { return response(400, { error: 'Invalid JSON body' }); }
  const user = await resolveUser(body);
  if (!user) return response(404, { error: 'That person does not have a bndy account yet', code: 'USER_NOT_FOUND', inviteRequired: true, email: body.email || null });
  if (user.cognito_id === auth.user.userId) return response(400, { error: 'You already manage this entity' });

  const current = await getMemberships(entityId);
  const existing = current.find((item) => item.user_id === user.cognito_id && item.status !== 'revoked');
  if (existing) return response(409, { error: 'This person already has access', membership: existing });

  const role = body.role === 'member' ? 'member' : 'admin';
  const now = new Date().toISOString();
  const item = {
    membership_id: crypto.randomUUID(), entity_type: String(body.entityType || 'venue'), entity_id: entityId,
    user_id: user.cognito_id, role, status: 'active', permissions: Array.isArray(body.permissions) ? body.permissions : [],
    joined_at: now, invited_at: now, invited_by_user_id: auth.user.userId, created_at: now, updated_at: now
  };
  await dynamodb.put({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(membership_id)' }).promise();
  return response(201, { membership: item });
}

async function updateMembership(event, id) {
  const auth = await requireAuth(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error });
  const existing = await dynamodb.get({ TableName: TABLE, Key: { membership_id: id } }).promise();
  if (!existing.Item) return response(404, { error: 'Membership not found' });
  const ownerCheck = await requireManager(event, existing.Item.entity_id, true);
  if (ownerCheck.error) return response(ownerCheck.statusCode, { error: ownerCheck.error });
  if (existing.Item.role === 'owner') return response(409, { error: 'Owner role is changed through ownership transfer, not delegate editing' });
  let body;
  try { body = parseBody(event); } catch { return response(400, { error: 'Invalid JSON body' }); }
  const role = body.role === 'member' ? 'member' : 'admin';
  const status = body.status === 'revoked' ? 'revoked' : 'active';
  const updated = await dynamodb.update({ TableName: TABLE, Key: { membership_id: id }, UpdateExpression: 'SET #role = :role, #status = :status, permissions = :permissions, updated_at = :now', ExpressionAttributeNames: { '#role': 'role', '#status': 'status' }, ExpressionAttributeValues: { ':role': role, ':status': status, ':permissions': Array.isArray(body.permissions) ? body.permissions : existing.Item.permissions || [], ':now': new Date().toISOString() }, ReturnValues: 'ALL_NEW' }).promise();
  return response(200, { membership: updated.Attributes });
}

async function transferOwnership(event, entityId) {
  const auth = await requireManager(event, entityId, true);
  if (auth.error) return response(auth.statusCode, { error: auth.error });
  let body;
  try { body = parseBody(event); } catch { return response(400, { error: 'Invalid JSON body' }); }
  const target = await resolveUser(body);
  if (!target) return response(404, { error: 'New owner must already have a bndy account', code: 'USER_NOT_FOUND', inviteRequired: true });
  if (target.cognito_id === auth.user.userId) return response(400, { error: 'You are already the owner' });

  const memberships = await getMemberships(entityId);
  const currentOwner = memberships.find((item) => item.user_id === auth.user.userId && item.role === 'owner' && item.status === 'active');
  if (!currentOwner) return response(403, { error: 'Current owner relationship not found' });
  let targetMembership = memberships.find((item) => item.user_id === target.cognito_id && item.status !== 'revoked');
  const now = new Date().toISOString();
  if (!targetMembership) {
    targetMembership = { membership_id: crypto.randomUUID(), entity_type: currentOwner.entity_type, entity_id: entityId, user_id: target.cognito_id, role: 'admin', status: 'active', permissions: [], joined_at: now, invited_at: now, invited_by_user_id: auth.user.userId, created_at: now, updated_at: now };
  }

  const entityTable = currentOwner.entity_type === 'venue' ? 'bndy-venues' : null;
  if (!entityTable) return response(400, { error: 'Ownership transfer is not enabled for this entity type in this service' });

  await dynamodb.transactWrite({ TransactItems: [
    ...(memberships.some((item) => item.membership_id === targetMembership.membership_id)
      ? [{ Update: { TableName: TABLE, Key: { membership_id: targetMembership.membership_id }, UpdateExpression: 'SET #role = :owner, #status = :active, updated_at = :now', ExpressionAttributeNames: { '#role': 'role', '#status': 'status' }, ExpressionAttributeValues: { ':owner': 'owner', ':active': 'active', ':now': now } } }]
      : [{ Put: { TableName: TABLE, Item: { ...targetMembership, role: 'owner' } } }]),
    { Update: { TableName: TABLE, Key: { membership_id: currentOwner.membership_id }, UpdateExpression: 'SET #role = :admin, updated_at = :now', ExpressionAttributeNames: { '#role': 'role' }, ExpressionAttributeValues: { ':admin': 'admin', ':now': now } } },
    { Update: { TableName: entityTable, Key: { id: entityId }, UpdateExpression: 'SET owner_user_id = :newOwner, claimedBy = :newOwner, claimedAt = :now, updated_at = :now', ConditionExpression: 'owner_user_id = :oldOwner', ExpressionAttributeValues: { ':newOwner': target.cognito_id, ':oldOwner': auth.user.userId, ':now': now } } }
  ] }).promise();
  return response(200, { entityId, ownerUserId: target.cognito_id, previousOwnerRole: 'admin' });
}

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path || '';
  const entityMatch = path.match(/^\/api\/managed-entities\/([^/]+)\/members$/);
  const transferMatch = path.match(/^\/api\/managed-entities\/([^/]+)\/transfer$/);
  const membershipMatch = path.match(/^\/api\/entity-memberships\/([^/]+)$/);
  try {
    if (entityMatch && method === 'GET') return await listEntity(event, entityMatch[1]);
    if (entityMatch && method === 'POST') return await addDelegate(event, entityMatch[1]);
    if (transferMatch && method === 'POST') return await transferOwnership(event, transferMatch[1]);
    if (membershipMatch && method === 'PATCH') return await updateMembership(event, membershipMatch[1]);
    return response(404, { error: 'Route not found', method, path });
  } catch (error) {
    console.error('[ENTITY_MEMBERSHIPS] error:', error);
    return response(500, { error: 'Internal server error' });
  }
};
