const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });
const CLAIMS_TABLE = process.env.ENTITY_CLAIMS_TABLE || 'bndy-entity-claims';
const ENTITY_MEMBERSHIPS_TABLE = process.env.ENTITY_MEMBERSHIPS_TABLE || 'bndy-entity-memberships';
const ARTIST_MEMBERSHIPS_TABLE = 'bndy-artist-memberships';
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

async function requirePlatformAdmin(event) {
  const auth = await requireAuth(event);
  if (auth.error) return auth;
  if (!auth.user.platformAdmin) return { error: 'Platform admin access required', statusCode: 403 };
  return auth;
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

  const requestedRole = ['owner','admin','member'].includes(body.requestedRole) ? body.requestedRole : 'admin';
  if (entityType === 'venue' && requestedRole === 'member') return response(400, { error: 'Venue claims support owner or admin relationships', code: 'INVALID_ROLE' });
  const relationshipKind = String(body.relationshipKind || '').trim().slice(0,80);
  const verificationMethod = body.verificationMethod === 'facebook_page' ? 'facebook_page' : 'manual';
  const relationshipExplanation = String(body.relationshipExplanation || '').trim().slice(0,2000);
  const supportingUrl = String(body.supportingUrl || '').trim().slice(0,1000);
  const officialEmail = String(body.officialEmail || '').trim().slice(0,320);
  const evidenceHints = body.evidenceHints && typeof body.evidenceHints === 'object' ? body.evidenceHints : {};

  if (verificationMethod === 'manual' && !relationshipExplanation) {
    return response(400, { error: 'Tell us how you are connected to this artist or venue.', code: 'EVIDENCE_REQUIRED' });
  }
  if (verificationMethod === 'facebook_page') {
    // Never trust client-supplied Page-control assertions. This method remains
    // closed until a server-side Meta verification flow issues the evidence.
    return response(409, { error: 'Facebook Page verification is not available until Meta Page access is approved.', code: 'FACEBOOK_PAGE_VERIFICATION_UNAVAILABLE' });
  }

  const now = new Date().toISOString();
  const evidenceItem = {
    evidence_id: crypto.randomUUID(), method: 'manual_explanation', status: 'submitted', strength: 'weak',
    observed_at: now, verifier: null, public_reference: supportingUrl || null,
    metadata: { explanation: relationshipExplanation, official_email: officialEmail || null }
  };
  const currentOwnerUserId = entity.owner_user_id || entity.claimedByUserId || entity.claimedBy || null;
  const initialStatus = requestedRole === 'owner' && currentOwnerUserId && currentOwnerUserId !== userId ? 'conflict' : 'pending_review';

  const id = claimId(userId, entityType, entityId);
  const existing = await dynamodb.get({ TableName: CLAIMS_TABLE, Key: { claim_id: id } }).promise();
  if (existing.Item && ['pending','pending_review','verified_pending','conflict','approved'].includes(existing.Item.status)) {
    return response(200, { action: 'existing', claim: existing.Item });
  }
  if (existing.Item?.status === 'more_evidence_required') {
    const nextStatus = requestedRole === 'owner' && currentOwnerUserId && currentOwnerUserId !== userId ? 'conflict' : 'pending_review';
    const updated = await dynamodb.update({
      TableName: CLAIMS_TABLE, Key: { claim_id: id },
      UpdateExpression: 'SET evidence = list_append(if_not_exists(evidence, :empty), :evidence), #status = :status, requested_role = :role, relationship_kind = :kind, evidence_hints = :hints, verification_method = :method, updated_at = :now, evidence_revision = if_not_exists(evidence_revision, :zero) + :one REMOVE reviewed_at',
      ConditionExpression: '#status = :moreEvidence',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':empty': [], ':evidence': [evidenceItem], ':status': nextStatus, ':role': requestedRole, ':kind': relationshipKind || null, ':hints': evidenceHints, ':method': verificationMethod, ':now': now, ':zero': 0, ':one': 1, ':moreEvidence': 'more_evidence_required' },
      ReturnValues: 'ALL_NEW'
    }).promise();
    return response(200, { action: 'evidence_updated', claim: updated.Attributes });
  }

  if (!existing.Item) {
    const recent = await dynamodb.query({ TableName: CLAIMS_TABLE, IndexName: 'user_id-index', KeyConditionExpression: 'user_id = :uid', ExpressionAttributeValues: { ':uid': userId } }).promise();
    const cutoff = Date.now() - 60 * 60 * 1000;
    const recentCount = (recent.Items || []).filter((claim) => Date.parse(claim.created_at || 0) >= cutoff).length;
    if (recentCount >= 20) return response(429, { error: 'Too many Claim attempts. Try again later.', code: 'CLAIM_RATE_LIMITED' });
  }
  const item = {
    claim_id: id, entity_type: entityType, entity_id: entityId, entity_name: entity.name || '', user_id: userId,
    requested_role: requestedRole, relationship_kind: relationshipKind || null, status: initialStatus,
    verification_method: verificationMethod, evidence: [evidenceItem], evidence_hints: evidenceHints, source: 'join_bndy_v2',
    evidence_revision: 1, evidence_summary: { strongest_strength: 'weak', verified_count: 0, methods: ['manual_explanation'] },
    owner_at_claim_time: currentOwnerUserId, prior_claim_summary: existing.Item ? { status: existing.Item.status, reviewed_at: existing.Item.reviewed_at || null, review_note: existing.Item.review_note || null } : null,
    created_at: now, updated_at: now, entity_key: entityType+'#'+entityId, user_key: userId
  };

  await dynamodb.put({ TableName: CLAIMS_TABLE, Item: item,
    ConditionExpression: 'attribute_not_exists(claim_id) OR #status IN (:rejected, :cancelled)',
    ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':rejected': 'rejected', ':cancelled': 'cancelled' }
  }).promise().catch(async (error) => { if (error.code !== 'ConditionalCheckFailedException') throw error; });

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

async function listPendingClaims(event) {
  const auth = await requirePlatformAdmin(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error });
  const result = await dynamodb.scan({ TableName: CLAIMS_TABLE }).promise();
  const reviewable = new Set(['pending','pending_review','verified_pending','more_evidence_required','conflict']);
  const reviewableClaims = (result.Items || []).filter((item) => reviewable.has(item.status));
  const counts = reviewableClaims.reduce((map, item) => { map[item.entity_key] = (map[item.entity_key] || 0) + 1; return map; }, {});
  const claims = await Promise.all(reviewableClaims.map(async (item) => {
    const table = entityTable(item.entity_type);
    const entityResult = table ? await dynamodb.get({ TableName: table, Key: { id: item.entity_id } }).promise().catch(() => ({})) : {};
    const entity = entityResult.Item || {};
    return { ...item, current_owner_user_id: entity.owner_user_id || entity.claimedByUserId || entity.claimedBy || null, competing_claim_count: counts[item.entity_key] || 1 };
  }));
  return response(200, { claims: claims.sort((a,b) => String(a.created_at).localeCompare(String(b.created_at))) });
}

async function cancelClaim(event, id) {
  const auth = await requireAuth(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error });
  const current = await dynamodb.get({ TableName: CLAIMS_TABLE, Key: { claim_id: id } }).promise();
  if (!current.Item) return response(404, { error: 'Claim not found' });
  if (current.Item.user_id !== auth.user.userId && !auth.user.platformAdmin) return response(403, { error: 'Not allowed' });
  if (!['pending','pending_review','verified_pending','more_evidence_required'].includes(current.Item.status)) return response(409, { error: 'Only reviewable claims can be cancelled', status: current.Item.status });
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

async function approveClaim(claim, reviewerId) {
  const table = entityTable(claim.entity_type);
  const entityResult = await dynamodb.get({ TableName: table, Key: { id: claim.entity_id } }).promise();
  if (!entityResult.Item) throw Object.assign(new Error('Entity not found'), { statusCode: 404, code: 'ENTITY_NOT_FOUND' });
  const entity = entityResult.Item;
  if (entity.owner_user_id && entity.owner_user_id !== claim.user_id && claim.requested_role === 'owner') {
    throw Object.assign(new Error('Entity already has a different owner; transfer/dispute review required'), { statusCode: 409, code: 'OWNER_CONFLICT' });
  }

  const now = new Date().toISOString();
  const membershipId = crypto.randomUUID();
  const role = ['owner','admin','member'].includes(claim.requested_role) ? claim.requested_role : 'admin';
  const transactItems = [];

  if (claim.entity_type === 'artist') {
    transactItems.push({ Put: { TableName: ARTIST_MEMBERSHIPS_TABLE, Item: {
      membership_id: membershipId, user_id: claim.user_id, artist_id: claim.entity_id,
      membership_type: role, role, status: 'active', permissions: [], joined_at: now,
      invited_at: now, invited_by_user_id: reviewerId, created_at: now, updated_at: now,
      display_name: null, avatar_url: null, instrument: null, bio: null, icon: 'fa-music', color: '#708090'
    }, ConditionExpression: 'attribute_not_exists(membership_id)' } });
    if (role === 'owner') transactItems.push({ Update: {
      TableName: 'bndy-artists', Key: { id: claim.entity_id },
      UpdateExpression: 'SET owner_user_id = :uid, claimedByUserId = :uid, updated_at = :now',
      ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(owner_user_id) OR owner_user_id = :uid)',
      ExpressionAttributeValues: { ':uid': claim.user_id, ':now': now }
    } });
  } else {
    transactItems.push({ Put: { TableName: ENTITY_MEMBERSHIPS_TABLE, Item: {
      membership_id: membershipId, entity_type: 'venue', entity_id: claim.entity_id,
      user_id: claim.user_id, role, status: 'active', permissions: [], joined_at: now,
      invited_at: now, invited_by_user_id: reviewerId, created_at: now, updated_at: now
    }, ConditionExpression: 'attribute_not_exists(membership_id)' } });
    if (role === 'owner') transactItems.push({ Update: {
      TableName: 'bndy-venues', Key: { id: claim.entity_id },
      UpdateExpression: 'SET owner_user_id = :uid, claimedBy = :uid, claimedAt = :now, claimVerification = :verified, updated_at = :now',
      ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(owner_user_id) OR owner_user_id = :uid)',
      ExpressionAttributeValues: { ':uid': claim.user_id, ':now': now, ':verified': 'verified_claim' }
    } });
  }

  transactItems.push({ Update: {
    TableName: CLAIMS_TABLE, Key: { claim_id: claim.claim_id },
    UpdateExpression: 'SET #status = :approved, reviewed_at = :now, reviewed_by = :reviewer, updated_at = :now',
    ConditionExpression: '#status IN (:pending, :pendingReview, :verifiedPending, :moreEvidence, :conflict)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':approved': 'approved', ':pending': 'pending', ':pendingReview': 'pending_review', ':verifiedPending': 'verified_pending', ':moreEvidence': 'more_evidence_required', ':conflict': 'conflict', ':now': now, ':reviewer': reviewerId }
  } });

  await dynamodb.transactWrite({ TransactItems: transactItems }).promise();
  return { membershipId, role, now };
}

async function reviewClaim(event, id) {
  const auth = await requirePlatformAdmin(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error });
  let body;
  try { body = parseBody(event); } catch { return response(400, { error: 'Invalid JSON body' }); }
  if (!['approved', 'rejected', 'more_evidence_required'].includes(body.status)) return response(400, { error: 'status must be approved, rejected or more_evidence_required' });

  const current = await dynamodb.get({ TableName: CLAIMS_TABLE, Key: { claim_id: id } }).promise();
  if (!current.Item) return response(404, { error: 'Claim not found' });
  if (!['pending','pending_review','verified_pending','more_evidence_required','conflict'].includes(current.Item.status)) return response(409, { error: 'Claim has already been reviewed', status: current.Item.status });

  if (body.status === 'more_evidence_required') {
    const note = String(body.note || '').trim();
    if (!note) return response(400, { error: 'Tell the claimant what additional evidence is needed', code: 'REVIEW_NOTE_REQUIRED' });
    const now = new Date().toISOString();
    const updated = await dynamodb.update({
      TableName: CLAIMS_TABLE, Key: { claim_id: id },
      UpdateExpression: 'SET #status = :status, reviewed_at = :now, reviewed_by = :reviewer, review_note = :note, updated_at = :now',
      ConditionExpression: '#status IN (:pending, :pendingReview, :verifiedPending, :conflict)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': 'more_evidence_required', ':pending': 'pending', ':pendingReview': 'pending_review', ':verifiedPending': 'verified_pending', ':conflict': 'conflict', ':now': now, ':reviewer': auth.user.userId, ':note': note },
      ReturnValues: 'ALL_NEW'
    }).promise();
    return response(200, { claim: updated.Attributes });
  }

  if (body.status === 'rejected') {
    const now = new Date().toISOString();
    const updated = await dynamodb.update({
      TableName: CLAIMS_TABLE, Key: { claim_id: id },
      UpdateExpression: 'SET #status = :rejected, reviewed_at = :now, reviewed_by = :reviewer, review_note = :note, updated_at = :now',
      ConditionExpression: '#status IN (:pending, :pendingReview, :verifiedPending, :moreEvidence, :conflict)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':rejected': 'rejected', ':pending': 'pending', ':pendingReview': 'pending_review', ':verifiedPending': 'verified_pending', ':moreEvidence': 'more_evidence_required', ':conflict': 'conflict', ':now': now, ':reviewer': auth.user.userId, ':note': String(body.note || '') },
      ReturnValues: 'ALL_NEW'
    }).promise();
    return response(200, { claim: updated.Attributes });
  }

  try {
    const approved = await approveClaim(current.Item, auth.user.userId);
    const saved = await dynamodb.get({ TableName: CLAIMS_TABLE, Key: { claim_id: id } }).promise();
    return response(200, { claim: saved.Item, relationship: { id: approved.membershipId, role: approved.role, status: 'active' } });
  } catch (error) {
    return response(error.statusCode || 500, { error: error.message || 'Claim approval failed', code: error.code || 'CLAIM_APPROVAL_FAILED' });
  }
}

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path || '';
  try {
    if (method === 'POST' && path === '/api/claims') return await createClaim(event);
    if (method === 'GET' && path === '/api/claims/me') return await listMyClaims(event);
    if (method === 'GET' && path === '/api/admin/claims') return await listPendingClaims(event);
    if (method === 'PATCH' && /^\/api\/admin\/claims\/[^/]+$/.test(path)) return await reviewClaim(event, path.split('/').pop());
    if (method === 'DELETE' && /^\/api\/claims\/[^/]+$/.test(path)) return await cancelClaim(event, path.split('/').pop());
    return response(404, { error: 'Route not found', method, path });
  } catch (error) {
    console.error('[CLAIMS] error:', error);
    return response(500, { error: 'Internal server error' });
  }
};
