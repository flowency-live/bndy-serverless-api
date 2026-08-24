const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });
const CLAIMS_TABLE = process.env.ENTITY_CLAIMS_TABLE || 'bndy-entity-claims';
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

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((out, part) => {
    const [name, ...rest] = part.trim().split('=');
    out[name] = rest.join('=');
    return out;
  }, {});
}

async function requireAuth(event) {
  let sessionToken = null;
  if (Array.isArray(event.cookies)) {
    const cookie = event.cookies.find((value) => value.startsWith('bndy_session='));
    if (cookie) sessionToken = cookie.slice('bndy_session='.length);
  } else {
    sessionToken = parseCookies(event.headers?.Cookie || event.headers?.cookie || '').bndy_session;
  }
  if (!sessionToken) return { error: 'Not authenticated', statusCode: 401 };
  try {
    const session = jwt.verify(sessionToken, await getJWTSecret());
    const userResult = await dynamodb.get({ TableName: 'bndy-users', Key: { cognito_id: session.userId } }).promise();
    return { user: { ...session, platformAdmin: userResult.Item?.platformAdmin === true } };
  } catch {
    return { error: 'Invalid session', statusCode: 401 };
  }
}

function response(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function parseBody(event) {
  if (!event.body) return {};
  return typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
}

function entityTable(entityType) {
  if (entityType === 'artist') return 'bndy-artists';
  if (entityType === 'venue') return 'bndy-venues';
  return null;
}

function claimId(userId, entityType, entityId) {
  return `claim-${crypto.createHash('sha256').update(`${userId}|${entityType}|${entityId}`).digest('hex').slice(0, 28)}`;
}

async function createClaim(event) {
  const auth = await requireAuth(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error, code: 'AUTH_REQUIRED' });

  let body;
  try { body = parseBody(event); } catch { return response(400, { error: 'Invalid JSON body' }); }
  const entityType = body.entityType;
  const entityId = String(body.entityId || '').trim();
  const table = entityTable(entityType);
  if (!table || !entityId) return response(400, { error: 'entityType (artist|venue) and entityId are required' });

  const entityResult = await dynamodb.get({ TableName: table, Key: { id: entityId } }).promise();
  if (!entityResult.Item) return response(404, { error: 'Entity not found', code: 'ENTITY_NOT_FOUND' });
  const entity = entityResult.Item;
  const userId = auth.user.userId;

  if (entity.owner_user_id === userId || entity.claimedByUserId === userId || entity.claimedBy === userId) {
    return response(200, { action: 'already_owned', entityType, entityId, status: 'approved' });
  }

  const id = claimId(userId, entityType, entityId);
  const existing = await dynamodb.get({ TableName: CLAIMS_TABLE, Key: { claim_id: id } }).promise();
  if (existing.Item && ['pending', 'approved'].includes(existing.Item.status)) {
    return response(200, { action: 'existing', claim: existing.Item });
  }

  const now = new Date().toISOString();
  const item = {
    claim_id: id,
    entity_type: entityType,
    entity_id: entityId,
    entity_name: entity.name || '',
    user_id: userId,
    requested_role: body.requestedRole === 'admin' ? 'admin' : 'owner',
    status: 'pending',
    evidence_hints: body.evidenceHints && typeof body.evidenceHints === 'object' ? body.evidenceHints : {},
    source: 'join_bndy',
    created_at: now,
    updated_at: now,
    entity_key: `${entityType}#${entityId}`,
    user_key: userId
  };

  await dynamodb.put({
    TableName: CLAIMS_TABLE,
    Item: item,
    ConditionExpression: 'attribute_not_exists(claim_id) OR #status IN (:rejected, :cancelled)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':rejected': 'rejected', ':cancelled': 'cancelled' }
  }).promise().catch(async (error) => {
    if (error.code !== 'ConditionalCheckFailedException') throw error;
  });

  const saved = await dynamodb.get({ TableName: CLAIMS_TABLE, Key: { claim_id: id } }).promise();
  return response(201, { action: 'created', claim: saved.Item || item });
}

async function listMyClaims(event) {
  const auth = await requireAuth(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error });
  const result = await dynamodb.query({
    TableName: CLAIMS_TABLE,
    IndexName: 'user_id-index',
    KeyConditionExpression: 'user_id = :uid',
    ExpressionAttributeValues: { ':uid': auth.user.userId }
  }).promise();
  const claims = (result.Items || []).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return response(200, { claims });
}

async function cancelClaim(event, id) {
  const auth = await requireAuth(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error });
  const current = await dynamodb.get({ TableName: CLAIMS_TABLE, Key: { claim_id: id } }).promise();
  if (!current.Item) return response(404, { error: 'Claim not found' });
  if (current.Item.user_id !== auth.user.userId && !auth.user.platformAdmin) return response(403, { error: 'Not allowed' });
  if (current.Item.status !== 'pending') return response(409, { error: 'Only pending claims can be cancelled', status: current.Item.status });
  const updated = await dynamodb.update({
    TableName: CLAIMS_TABLE,
    Key: { claim_id: id },
    UpdateExpression: 'SET #status = :cancelled, updated_at = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':cancelled': 'cancelled', ':now': new Date().toISOString() },
    ReturnValues: 'ALL_NEW'
  }).promise();
  return response(200, { claim: updated.Attributes });
}

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path || '';
  try {
    if (method === 'POST' && path === '/api/claims') return await createClaim(event);
    if (method === 'GET' && path === '/api/claims/me') return await listMyClaims(event);
    if (method === 'DELETE' && /^\/api\/claims\/[^/]+$/.test(path)) return await cancelClaim(event, path.split('/').pop());
    return response(404, { error: 'Route not found', method, path });
  } catch (error) {
    console.error('[CLAIMS] error:', error);
    return response(500, { error: 'Internal server error' });
  }
};
