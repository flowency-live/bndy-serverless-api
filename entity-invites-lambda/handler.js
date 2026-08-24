const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });
const INVITES_TABLE = process.env.ENTITY_INVITES_TABLE || 'bndy-entity-invites';
const MEMBERSHIPS_TABLE = process.env.ENTITY_MEMBERSHIPS_TABLE || 'bndy-entity-memberships';
const USERS_TABLE = 'bndy-users';
const EXPIRY_DAYS = 7;
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

function response(statusCode, body) { return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
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
    const user = await dynamodb.get({ TableName: USERS_TABLE, Key: { cognito_id: session.userId } }).promise();
    return { user: { ...session, profile: user.Item || null, platformAdmin: user.Item?.platformAdmin === true } };
  } catch { return { error: 'Invalid session', statusCode: 401 }; }
}

function token() {
  return crypto.randomBytes(18).toString('base64url');
}

async function getEntityMemberships(entityId) {
  const result = await dynamodb.query({ TableName: MEMBERSHIPS_TABLE, IndexName: 'entity_id-index', KeyConditionExpression: 'entity_id = :id', ExpressionAttributeValues: { ':id': entityId } }).promise();
  return result.Items || [];
}

async function requireOwner(event, entityId) {
  const auth = await requireAuth(event);
  if (auth.error) return auth;
  if (auth.user.platformAdmin) return auth;
  const memberships = await getEntityMemberships(entityId);
  const owner = memberships.find((item) => item.user_id === auth.user.userId && item.role === 'owner' && item.status === 'active');
  return owner ? auth : { error: 'Owner access required', statusCode: 403 };
}

async function createInvite(event, entityId) {
  const auth = await requireOwner(event, entityId);
  if (auth.error) return response(auth.statusCode, { error: auth.error });
  let body;
  try { body = parseBody(event); } catch { return response(400, { error: 'Invalid JSON body' }); }
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return response(400, { error: 'A valid delegate email is required' });
  const role = body.role === 'member' ? 'member' : 'admin';

  const venue = await dynamodb.get({ TableName: 'bndy-venues', Key: { id: entityId } }).promise();
  if (!venue.Item) return response(404, { error: 'Venue not found' });

  const memberships = await getEntityMemberships(entityId);
  for (const membership of memberships) {
    const user = await dynamodb.get({ TableName: USERS_TABLE, Key: { cognito_id: membership.user_id } }).promise();
    if ((user.Item?.email || '').toLowerCase() === email && membership.status === 'active') {
      return response(409, { error: 'That person already has access', code: 'ALREADY_MEMBER', membership });
    }
  }

  const inviteToken = token();
  const now = new Date().toISOString();
  const expiresAt = Math.floor(Date.now() / 1000) + EXPIRY_DAYS * 24 * 60 * 60;
  const invite = {
    token: inviteToken,
    entity_type: 'venue',
    entity_id: entityId,
    entity_name: venue.Item.name,
    invited_email: email,
    requested_role: role,
    invited_by_user_id: auth.user.userId,
    status: 'active',
    expires_at: expiresAt,
    created_at: now,
    updated_at: now,
  };
  await dynamodb.put({ TableName: INVITES_TABLE, Item: invite, ConditionExpression: 'attribute_not_exists(#token)', ExpressionAttributeNames: { '#token': 'token' } }).promise();
  return response(201, {
    invite: { token: inviteToken, entityType: 'venue', entityId, entityName: venue.Item.name, email, role, expiresAt },
    inviteLink: `https://bndy.live/join/invite/${inviteToken}`,
  });
}

async function getInvite(inviteToken) {
  const result = await dynamodb.get({ TableName: INVITES_TABLE, Key: { token: inviteToken } }).promise();
  if (!result.Item) return response(404, { error: 'Invite not found', code: 'INVITE_NOT_FOUND' });
  const invite = result.Item;
  const expired = invite.expires_at <= Math.floor(Date.now() / 1000);
  if (expired || invite.status !== 'active') return response(410, { error: expired ? 'Invite expired' : 'Invite is no longer active', code: expired ? 'INVITE_EXPIRED' : 'INVITE_INACTIVE' });
  return response(200, {
    token: invite.token,
    entityType: invite.entity_type,
    entityId: invite.entity_id,
    entityName: invite.entity_name,
    role: invite.requested_role,
    emailHint: invite.invited_email ? invite.invited_email.replace(/^(.{1,2}).*(@.*)$/, '$1***$2') : null,
    expiresAt: invite.expires_at,
  });
}

async function acceptInvite(event, inviteToken) {
  const auth = await requireAuth(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error, code: 'AUTH_REQUIRED' });
  const result = await dynamodb.get({ TableName: INVITES_TABLE, Key: { token: inviteToken } }).promise();
  if (!result.Item) return response(404, { error: 'Invite not found' });
  const invite = result.Item;
  if (invite.status !== 'active' || invite.expires_at <= Math.floor(Date.now() / 1000)) return response(410, { error: 'Invite is expired or inactive' });

  const userEmail = String(auth.user.profile?.email || '').trim().toLowerCase();
  if (!userEmail || userEmail !== invite.invited_email) {
    return response(403, { error: 'This invite was sent to a different email address', code: 'INVITE_EMAIL_MISMATCH' });
  }

  const memberships = await getEntityMemberships(invite.entity_id);
  const existing = memberships.find((item) => item.user_id === auth.user.userId && item.status === 'active');
  if (existing) {
    await dynamodb.update({ TableName: INVITES_TABLE, Key: { token: inviteToken }, UpdateExpression: 'SET #status = :used, accepted_by_user_id = :uid, accepted_at = :now, updated_at = :now', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':used': 'accepted', ':uid': auth.user.userId, ':now': new Date().toISOString() } }).promise();
    return response(200, { action: 'already_member', membership: existing });
  }

  const now = new Date().toISOString();
  const membership = {
    membership_id: crypto.randomUUID(), entity_type: invite.entity_type, entity_id: invite.entity_id,
    user_id: auth.user.userId, role: invite.requested_role === 'member' ? 'member' : 'admin', status: 'active', permissions: [],
    joined_at: now, invited_at: invite.created_at, invited_by_user_id: invite.invited_by_user_id, created_at: now, updated_at: now,
  };

  await dynamodb.transactWrite({ TransactItems: [
    { Put: { TableName: MEMBERSHIPS_TABLE, Item: membership, ConditionExpression: 'attribute_not_exists(membership_id)' } },
    { Update: { TableName: INVITES_TABLE, Key: { token: inviteToken }, UpdateExpression: 'SET #status = :accepted, accepted_by_user_id = :uid, accepted_at = :now, updated_at = :now', ConditionExpression: '#status = :active', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':accepted': 'accepted', ':active': 'active', ':uid': auth.user.userId, ':now': now } } }
  ] }).promise();

  return response(200, { action: 'accepted', membership, entity: { id: invite.entity_id, type: invite.entity_type, name: invite.entity_name } });
}

async function revokeInvite(event, inviteToken) {
  const auth = await requireAuth(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error });
  const result = await dynamodb.get({ TableName: INVITES_TABLE, Key: { token: inviteToken } }).promise();
  if (!result.Item) return response(404, { error: 'Invite not found' });
  const invite = result.Item;
  const owner = await requireOwner(event, invite.entity_id);
  if (owner.error) return response(owner.statusCode, { error: owner.error });
  await dynamodb.update({ TableName: INVITES_TABLE, Key: { token: inviteToken }, UpdateExpression: 'SET #status = :revoked, updated_at = :now', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':revoked': 'revoked', ':now': new Date().toISOString() } }).promise();
  return response(200, { success: true });
}

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path || '';
  const createMatch = path.match(/^\/api\/managed-entities\/([^/]+)\/invites$/);
  const inviteMatch = path.match(/^\/api\/entity-invites\/([^/]+)$/);
  const acceptMatch = path.match(/^\/api\/entity-invites\/([^/]+)\/accept$/);
  try {
    if (createMatch && method === 'POST') return await createInvite(event, createMatch[1]);
    if (inviteMatch && method === 'GET') return await getInvite(inviteMatch[1]);
    if (inviteMatch && method === 'DELETE') return await revokeInvite(event, inviteMatch[1]);
    if (acceptMatch && method === 'POST') return await acceptInvite(event, acceptMatch[1]);
    return response(404, { error: 'Route not found', method, path });
  } catch (error) {
    console.error('[ENTITY_INVITES] error:', error);
    return response(500, { error: 'Internal server error' });
  }
};
