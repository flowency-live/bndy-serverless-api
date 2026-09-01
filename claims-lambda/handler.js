const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });
const secretsManager = new AWS.SecretsManager({ region: 'eu-west-2' });
const facebookVerification = require('./facebook-page-verification');
const CLAIMS_TABLE = process.env.ENTITY_CLAIMS_TABLE || 'bndy-entity-claims';
const ENTITY_MEMBERSHIPS_TABLE = process.env.ENTITY_MEMBERSHIPS_TABLE || 'bndy-entity-memberships';
const ARTIST_MEMBERSHIPS_TABLE = 'bndy-artist-memberships';
const OAUTH_STATE_TABLE = process.env.OAUTH_STATE_TABLE || 'bndy-oauth-states';
const FACEBOOK_SECRET_ID = process.env.FACEBOOK_META_SECRET_ID || 'bndy/meta-page-verification';
const FACEBOOK_CALLBACK_URI = process.env.FACEBOOK_PAGE_CALLBACK_URI || 'https://bndy.live/api/claims/facebook/callback';
const FACEBOOK_GRAPH_API_VERSION = process.env.FACEBOOK_GRAPH_API_VERSION || 'v26.0';
let JWT_SECRET = null;
let FACEBOOK_CONFIG = null;

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

async function getFacebookConfig() {
  if (process.env.FACEBOOK_PAGE_VERIFICATION_ENABLED !== 'true') return null;
  if (FACEBOOK_CONFIG) return FACEBOOK_CONFIG;
  if (!/^v\d+\.\d+$/.test(FACEBOOK_GRAPH_API_VERSION)) return null;
  try {
    const callback = new URL(FACEBOOK_CALLBACK_URI);
    if (callback.protocol !== 'https:' || callback.origin !== 'https://bndy.live') return null;
    const result = await secretsManager.getSecretValue({ SecretId: FACEBOOK_SECRET_ID }).promise();
    const secret = JSON.parse(result.SecretString || '{}');
    const appId = String(secret.app_id || '').trim();
    const appSecret = String(secret.app_secret || '').trim();
    if (!/^\d+$/.test(appId) || !appSecret) return null;
    FACEBOOK_CONFIG = { appId, appSecret, callbackUri: callback.toString(), graphApiVersion: FACEBOOK_GRAPH_API_VERSION };
    return FACEBOOK_CONFIG;
  } catch (error) {
    console.warn('[CLAIMS] Facebook Page verification configuration is unavailable:', error.code || error.name || 'configuration_error');
    return null;
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

function htmlResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
    body,
  };
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

async function putOAuthRecord(item) {
  await dynamodb.put({
    TableName: OAUTH_STATE_TABLE,
    Item: item,
    ConditionExpression: 'attribute_not_exists(#state)',
    ExpressionAttributeNames: { '#state': 'state' },
  }).promise();
}

async function consumeOAuthState(state) {
  if (typeof state !== 'string' || state.length < 32 || state.length > 200) return null;
  try {
    const result = await dynamodb.delete({
      TableName: OAUTH_STATE_TABLE,
      Key: { state },
      ConditionExpression: 'record_kind = :kind AND ttl >= :now',
      ExpressionAttributeValues: {
        ':kind': 'facebook_page_oauth_state',
        ':now': Math.floor(Date.now() / 1000),
      },
      ReturnValues: 'ALL_OLD',
    }).promise();
    return result.Attributes || null;
  } catch (error) {
    if (error.code === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function getFacebookReceipt(receiptId) {
  const state = `facebook-page-receipt#${receiptId}`;
  const result = await dynamodb.get({ TableName: OAUTH_STATE_TABLE, Key: { state } }).promise();
  const record = result.Item;
  if (!record || record.record_kind !== 'facebook_page_receipt' || record.ttl < Math.floor(Date.now() / 1000)) return null;
  return record;
}

async function consumeFacebookReceipt(receiptId) {
  const state = `facebook-page-receipt#${receiptId}`;
  try {
    const result = await dynamodb.delete({
      TableName: OAUTH_STATE_TABLE,
      Key: { state },
      ConditionExpression: 'record_kind = :kind AND ttl >= :now',
      ExpressionAttributeValues: {
        ':kind': 'facebook_page_receipt',
        ':now': Math.floor(Date.now() / 1000),
      },
      ReturnValues: 'ALL_OLD',
    }).promise();
    return result.Attributes || null;
  } catch (error) {
    if (error.code === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

async function parseMetaResponse(metaResponse) {
  const body = await metaResponse.json().catch(() => ({}));
  if (!metaResponse.ok) {
    throw Object.assign(new Error('Facebook did not complete Page verification.'), { code: 'META_REQUEST_FAILED' });
  }
  return body;
}

async function getManagedFacebookPages(config, accessToken) {
  const proof = facebookVerification.appSecretProof(config.appSecret, accessToken);
  let after = null;
  const pages = [];
  for (let requestCount = 0; requestCount < 5 && pages.length < 100; requestCount += 1) {
    const url = new URL(`https://graph.facebook.com/${config.graphApiVersion}/me/accounts`);
    url.searchParams.set('fields', 'id,name,tasks');
    url.searchParams.set('limit', '100');
    url.searchParams.set('appsecret_proof', proof);
    if (after) url.searchParams.set('after', after);
    const graphResponse = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const graphBody = await parseMetaResponse(graphResponse);
    pages.push(...facebookVerification.sanitisePages(graphBody.data));
    after = graphBody?.paging?.cursors?.after || null;
    if (!after || !graphBody?.paging?.next) break;
  }
  return facebookVerification.sanitisePages(pages);
}

async function facebookVerificationStatus(event) {
  const auth = await requireAuth(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error, code: 'AUTH_REQUIRED' });
  return response(200, { available: Boolean(await getFacebookConfig()) });
}

async function startFacebookVerification(event) {
  const auth = await requireAuth(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error, code: 'AUTH_REQUIRED' });
  const query = event.queryStringParameters || {};
  const entity = facebookVerification.normaliseEntity(query.entityType, query.entityId);
  const targetOrigin = facebookVerification.validateTargetOrigin(query.targetOrigin);
  if (!entity || !targetOrigin) return response(400, { error: 'A valid entity and bndy return origin are required.', code: 'INVALID_FACEBOOK_PAGE_REQUEST' });
  const config = await getFacebookConfig();
  if (!config) return response(503, { error: 'Facebook Page verification is not available.', code: 'FACEBOOK_PAGE_VERIFICATION_UNAVAILABLE' });

  const table = entityTable(entity.entityType);
  const entityResult = await dynamodb.get({ TableName: table, Key: { id: entity.entityId } }).promise();
  if (!entityResult.Item) return response(404, { error: 'Entity not found', code: 'ENTITY_NOT_FOUND' });

  const state = facebookVerification.generateOpaqueState();
  await putOAuthRecord(facebookVerification.stateRecord({
    state,
    userId: auth.user.userId,
    entityType: entity.entityType,
    entityId: entity.entityId,
    targetOrigin,
    callbackUri: config.callbackUri,
  }));

  const authUrl = new URL(`https://www.facebook.com/${config.graphApiVersion}/dialog/oauth`);
  authUrl.searchParams.set('client_id', config.appId);
  authUrl.searchParams.set('redirect_uri', config.callbackUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'pages_show_list');
  authUrl.searchParams.set('auth_type', 'rerequest');
  authUrl.searchParams.set('display', 'popup');
  return { statusCode: 302, headers: { Location: authUrl.toString(), 'Cache-Control': 'no-store' }, body: '' };
}

async function finishFacebookVerification(event) {
  const query = event.queryStringParameters || {};
  const stateRecord = await consumeOAuthState(query.state);
  const targetOrigin = stateRecord?.target_origin || 'https://bndy.live';
  const failure = (message) => htmlResponse(200, facebookVerification.callbackHtml(targetOrigin, { ok: false, error: message }));
  if (!stateRecord) return failure('This Facebook verification request expired. Return to bndy and try again.');
  if (query.error || !query.code) return failure('Facebook Page verification was cancelled. You can use manual evidence instead.');
  const config = await getFacebookConfig();
  if (!config || stateRecord.callback_uri !== config.callbackUri) return failure('Facebook Page verification is not available.');

  try {
    const tokenResponse = await fetch(`https://graph.facebook.com/${config.graphApiVersion}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.appId,
        client_secret: config.appSecret,
        redirect_uri: config.callbackUri,
        code: query.code,
      }),
    });
    const tokenBody = await parseMetaResponse(tokenResponse);
    const accessToken = String(tokenBody.access_token || '');
    if (!accessToken) throw Object.assign(new Error('Facebook returned no access token.'), { code: 'META_TOKEN_MISSING' });
    const pages = await getManagedFacebookPages(config, accessToken);
    const receiptId = facebookVerification.generateReceiptId();
    const jwtSecret = await getJWTSecret();
    const receipt = facebookVerification.signReceipt({
      receiptId,
      userId: stateRecord.user_id,
      entityType: stateRecord.entity_type,
      entityId: stateRecord.entity_id,
      pages,
      secret: jwtSecret,
    });
    await putOAuthRecord(facebookVerification.receiptRecord({
      receiptId,
      userId: stateRecord.user_id,
      entityType: stateRecord.entity_type,
      entityId: stateRecord.entity_id,
      pages,
    }));
    return htmlResponse(200, facebookVerification.callbackHtml(targetOrigin, { ok: true, pages, receipt }));
  } catch (error) {
    console.warn('[CLAIMS] Facebook Page verification failed:', error.code || error.name || 'meta_error');
    return failure('Facebook did not complete Page verification. Return to bndy and try again.');
  }
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

  const now = new Date().toISOString();
  let evidenceItem;
  let facebookReceiptId = null;
  if (verificationMethod === 'facebook_page') {
    const receiptToken = String(body.facebookVerificationReceipt || '');
    const selectedPageId = String(body.facebookEvidence?.verifiedPageId || '').trim();
    if (!receiptToken || !selectedPageId) {
      return response(400, { error: 'Connect Facebook and choose a managed Page first.', code: 'FACEBOOK_PAGE_EVIDENCE_REQUIRED' });
    }
    try {
      const verified = facebookVerification.verifyReceipt({ token: receiptToken, selectedPageId, userId, entityType, entityId, secret: await getJWTSecret() });
      const storedReceipt = await getFacebookReceipt(verified.receiptId);
      const storedPage = storedReceipt?.pages?.find((page) => page.id === verified.pageId);
      if (!storedReceipt || storedReceipt.user_id !== userId || storedReceipt.entity_type !== entityType || storedReceipt.entity_id !== entityId || !storedPage) {
        return response(409, { error: 'This Facebook Page verification expired or was already used.', code: 'FACEBOOK_PAGE_RECEIPT_UNAVAILABLE' });
      }
      facebookReceiptId = verified.receiptId;
      evidenceItem = {
        evidence_id: crypto.randomUUID(), method: 'facebook_page_control', status: 'verified', strength: 'strong',
        observed_at: now, verifier: 'meta_graph_api', public_reference: storedPage.pageUrl,
        metadata: { page_id: storedPage.id, page_name: storedPage.name, page_url: storedPage.pageUrl, page_tasks: storedPage.tasks, entity_page_match: facebookVerification.entityPageMatch(entity, storedPage.id), verified_at: now }
      };
    } catch (error) {
      return response(400, {
        error: error.name === 'TokenExpiredError' ? 'This Facebook Page verification expired. Connect Facebook again.' : 'Facebook Page verification does not match this claim.',
        code: error.code || 'INVALID_FACEBOOK_PAGE_RECEIPT'
      });
    }
  } else {
    evidenceItem = {
      evidence_id: crypto.randomUUID(), method: 'manual_explanation', status: 'submitted', strength: 'weak',
      observed_at: now, verifier: null, public_reference: supportingUrl || null,
      metadata: { explanation: relationshipExplanation, official_email: officialEmail || null }
    };
  }
  const currentOwnerUserId = entity.owner_user_id || entity.claimedByUserId || entity.claimedBy || null;
  const initialStatus = requestedRole === 'owner' && currentOwnerUserId && currentOwnerUserId !== userId ? 'conflict' : verificationMethod === 'facebook_page' ? 'verified_pending' : 'pending_review';

  const id = claimId(userId, entityType, entityId);
  const existing = await dynamodb.get({ TableName: CLAIMS_TABLE, Key: { claim_id: id } }).promise();
  if (existing.Item && ['pending','pending_review','verified_pending','conflict','approved'].includes(existing.Item.status)) {
    return response(200, { action: 'existing', claim: existing.Item });
  }
  if (existing.Item?.status === 'more_evidence_required') {
    if (facebookReceiptId && !await consumeFacebookReceipt(facebookReceiptId)) {
      return response(409, { error: 'This Facebook Page verification expired or was already used.', code: 'FACEBOOK_PAGE_RECEIPT_UNAVAILABLE' });
    }
    const nextStatus = requestedRole === 'owner' && currentOwnerUserId && currentOwnerUserId !== userId ? 'conflict' : verificationMethod === 'facebook_page' ? 'verified_pending' : 'pending_review';
    const evidenceSummary = verificationMethod === 'facebook_page' ? { strongest_strength: 'strong', verified_count: 1, methods: ['facebook_page_control'] } : { strongest_strength: 'weak', verified_count: 0, methods: ['manual_explanation'] };
    const updated = await dynamodb.update({
      TableName: CLAIMS_TABLE, Key: { claim_id: id },
      UpdateExpression: 'SET evidence = list_append(if_not_exists(evidence, :empty), :evidence), evidence_summary = :summary, #status = :status, requested_role = :role, relationship_kind = :kind, evidence_hints = :hints, verification_method = :method, updated_at = :now, evidence_revision = if_not_exists(evidence_revision, :zero) + :one REMOVE reviewed_at',
      ConditionExpression: '#status = :moreEvidence',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':empty': [], ':evidence': [evidenceItem], ':summary': evidenceSummary, ':status': nextStatus, ':role': requestedRole, ':kind': relationshipKind || null, ':hints': evidenceHints, ':method': verificationMethod, ':now': now, ':zero': 0, ':one': 1, ':moreEvidence': 'more_evidence_required' },
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
  if (facebookReceiptId && !await consumeFacebookReceipt(facebookReceiptId)) {
    return response(409, { error: 'This Facebook Page verification expired or was already used.', code: 'FACEBOOK_PAGE_RECEIPT_UNAVAILABLE' });
  }
  const evidenceSummary = verificationMethod === 'facebook_page' ? { strongest_strength: 'strong', verified_count: 1, methods: ['facebook_page_control'] } : { strongest_strength: 'weak', verified_count: 0, methods: ['manual_explanation'] };
  const item = {
    claim_id: id, entity_type: entityType, entity_id: entityId, entity_name: entity.name || '', user_id: userId,
    requested_role: requestedRole, relationship_kind: relationshipKind || null, status: initialStatus,
    verification_method: verificationMethod, evidence: [evidenceItem], evidence_hints: evidenceHints, source: 'join_bndy_v2',
    evidence_revision: 1, evidence_summary: evidenceSummary,
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
    if (method === 'GET' && path === '/api/claims/facebook/status') return await facebookVerificationStatus(event);
    if (method === 'GET' && path === '/api/claims/facebook/start') return await startFacebookVerification(event);
    if (method === 'GET' && path === '/api/claims/facebook/callback') return await finishFacebookVerification(event);
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
