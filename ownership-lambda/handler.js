const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });
const ARTIST_MEMBERSHIPS = process.env.ARTIST_MEMBERSHIPS_TABLE || 'bndy-artist-memberships';
const ENTITY_MEMBERSHIPS = process.env.ENTITY_MEMBERSHIPS_TABLE || 'bndy-entity-memberships';
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

function parseCookies(header) {
  if (!header) return {};
  return header.split(';').reduce((out, part) => {
    const [name, ...rest] = part.trim().split('=');
    out[name] = rest.join('=');
    return out;
  }, {});
}

async function requireAuth(event) {
  let token = null;
  if (Array.isArray(event.cookies)) {
    const cookie = event.cookies.find((value) => value.startsWith('bndy_session='));
    if (cookie) token = cookie.slice('bndy_session='.length);
  } else {
    token = parseCookies(event.headers?.Cookie || event.headers?.cookie || '').bndy_session;
  }
  if (!token) return { error: 'Not authenticated', statusCode: 401 };
  try {
    const session = jwt.verify(token, await getJWTSecret());
    return { user: session };
  } catch {
    return { error: 'Invalid session', statusCode: 401 };
  }
}

async function artistMemberships(artistId) {
  const result = await dynamodb.query({
    TableName: ARTIST_MEMBERSHIPS,
    IndexName: 'artist_id-index',
    KeyConditionExpression: 'artist_id = :id',
    ExpressionAttributeValues: { ':id': artistId },
  }).promise();
  return result.Items || [];
}

async function entityMemberships(entityId) {
  const result = await dynamodb.query({
    TableName: ENTITY_MEMBERSHIPS,
    IndexName: 'entity_id-index',
    KeyConditionExpression: 'entity_id = :id',
    ExpressionAttributeValues: { ':id': entityId },
  }).promise();
  return result.Items || [];
}

function activeManagerOtherThan(memberships, userId) {
  return memberships.find((item) =>
    item.user_id !== userId && item.status === 'active' && (item.role === 'owner' || item.role === 'admin'));
}

async function relinquishArtist(userId, artistId) {
  const artist = await dynamodb.get({ TableName: 'bndy-artists', Key: { id: artistId } }).promise();
  if (!artist.Item) return response(404, { error: 'Artist not found' });

  const memberships = await artistMemberships(artistId);
  const owner = memberships.find((item) => item.user_id === userId && item.role === 'owner' && item.status === 'active');
  if (!owner) return response(403, { error: 'Only the current owner can relinquish this artist' });

  const otherManager = activeManagerOtherThan(memberships, userId);
  if (otherManager) {
    return response(409, {
      error: 'This artist has another active owner/admin. Transfer ownership or remove management access before relinquishing.',
      code: 'OTHER_MANAGER_ACTIVE',
    });
  }

  const now = new Date().toISOString();
  await dynamodb.transactWrite({ TransactItems: [
    { Update: {
      TableName: ARTIST_MEMBERSHIPS,
      Key: { membership_id: owner.membership_id },
      UpdateExpression: 'SET #status = :revoked, updated_at = :now',
      ConditionExpression: '#role = :owner AND #status = :active AND user_id = :uid',
      ExpressionAttributeNames: { '#status': 'status', '#role': 'role' },
      ExpressionAttributeValues: { ':revoked': 'revoked', ':owner': 'owner', ':active': 'active', ':uid': userId, ':now': now },
    } },
    { Update: {
      TableName: 'bndy-artists',
      Key: { id: artistId },
      UpdateExpression: 'SET claimStatus = :unclaimed, relinquished_at = :now, relinquished_by_user_id = :uid, updated_at = :now REMOVE owner_user_id, claimedBy, claimedByUserId, claimedAt, claimVerification',
      ConditionExpression: 'attribute_exists(id)',
      ExpressionAttributeValues: { ':unclaimed': 'unclaimed', ':now': now, ':uid': userId },
    } },
  ] }).promise();

  return response(200, {
    action: 'relinquished',
    entityType: 'artist',
    entityId: artistId,
    entityName: artist.Item.name,
    claimStatus: 'unclaimed',
    publicRecordRetained: true,
  });
}

async function relinquishVenue(userId, venueId) {
  const venue = await dynamodb.get({ TableName: 'bndy-venues', Key: { id: venueId } }).promise();
  if (!venue.Item) return response(404, { error: 'Venue not found' });

  const memberships = await entityMemberships(venueId);
  const owner = memberships.find((item) => item.user_id === userId && item.role === 'owner' && item.status === 'active');
  if (!owner) return response(403, { error: 'Only the current owner can relinquish this venue' });

  const otherManager = activeManagerOtherThan(memberships, userId);
  if (otherManager) {
    return response(409, {
      error: 'This venue has another active owner/admin. Transfer ownership or remove delegates before relinquishing.',
      code: 'OTHER_MANAGER_ACTIVE',
    });
  }

  const now = new Date().toISOString();
  await dynamodb.transactWrite({ TransactItems: [
    { Update: {
      TableName: ENTITY_MEMBERSHIPS,
      Key: { membership_id: owner.membership_id },
      UpdateExpression: 'SET #status = :revoked, updated_at = :now',
      ConditionExpression: '#role = :owner AND #status = :active AND user_id = :uid',
      ExpressionAttributeNames: { '#status': 'status', '#role': 'role' },
      ExpressionAttributeValues: { ':revoked': 'revoked', ':owner': 'owner', ':active': 'active', ':uid': userId, ':now': now },
    } },
    { Update: {
      TableName: 'bndy-venues',
      Key: { id: venueId },
      UpdateExpression: 'SET claimStatus = :unclaimed, relinquished_at = :now, relinquished_by_user_id = :uid, updated_at = :now REMOVE owner_user_id, claimedBy, claimedByUserId, claimedAt, claimVerification',
      ConditionExpression: 'attribute_exists(id)',
      ExpressionAttributeValues: { ':unclaimed': 'unclaimed', ':now': now, ':uid': userId },
    } },
  ] }).promise();

  return response(200, {
    action: 'relinquished',
    entityType: 'venue',
    entityId: venueId,
    entityName: venue.Item.name,
    claimStatus: 'unclaimed',
    publicRecordRetained: true,
  });
}

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path || '';
  const match = path.match(/^\/api\/managed-entities\/(artist|venue)\/([^/]+)\/relinquish$/);
  if (!match) return response(404, { error: 'Route not found' });
  if (method !== 'POST') return response(405, { error: 'Method not allowed' });

  const auth = await requireAuth(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error, code: 'AUTH_REQUIRED' });

  try {
    return match[1] === 'artist'
      ? await relinquishArtist(auth.user.userId, match[2])
      : await relinquishVenue(auth.user.userId, match[2]);
  } catch (error) {
    console.error('[OWNERSHIP] relinquish failed', { path, error });
    return response(500, { error: 'Could not relinquish ownership' });
  }
};
