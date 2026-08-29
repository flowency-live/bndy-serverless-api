const fs=require('fs');
const p='claims-lambda/handler.js';
let s=fs.readFileSync(p,'utf8');
const replace=(re,value,label)=>{if(!re.test(s))throw new Error('Missing '+label);s=s.replace(re,value)};
replace(/async function createClaim\(event\) \{[\s\S]*?\n\}\n\nasync function listMyClaims/,`async function createClaim(event) {
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
  const facebookEvidence = body.facebookEvidence && typeof body.facebookEvidence === 'object' ? body.facebookEvidence : null;

  if (verificationMethod === 'manual' && !relationshipExplanation) {
    return response(400, { error: 'Tell us how you are connected to this artist or venue.', code: 'EVIDENCE_REQUIRED' });
  }
  if (verificationMethod === 'facebook_page' && !facebookEvidence?.verifiedPageId) {
    return response(400, { error: 'Facebook Page control has not been verified.', code: 'FACEBOOK_PAGE_NOT_VERIFIED' });
  }

  const evidence = [];
  if (verificationMethod === 'manual') evidence.push({ type: 'manual_explanation', explanation: relationshipExplanation, supporting_url: supportingUrl || null, official_email: officialEmail || null, supplied_at: new Date().toISOString() });
  if (verificationMethod === 'facebook_page') evidence.push({ type: 'facebook_page_control', page_id: String(facebookEvidence.verifiedPageId), page_name: String(facebookEvidence.pageName || ''), page_url: String(facebookEvidence.pageUrl || ''), verified_at: String(facebookEvidence.verifiedAt || new Date().toISOString()), reconciliation: String(facebookEvidence.reconciliation || 'unresolved') });
  const strongFacebook = evidence.some((item) => item.type === 'facebook_page_control' && item.reconciliation === 'exact');
  const initialStatus = strongFacebook ? 'verified_pending' : 'pending_review';

  const id = claimId(userId, entityType, entityId);
  const existing = await dynamodb.get({ TableName: CLAIMS_TABLE, Key: { claim_id: id } }).promise();
  if (existing.Item && ['pending','pending_review','verified_pending','approved'].includes(existing.Item.status)) {
    return response(200, { action: 'existing', claim: existing.Item });
  }

  const now = new Date().toISOString();
  const item = {
    claim_id: id, entity_type: entityType, entity_id: entityId, entity_name: entity.name || '', user_id: userId,
    requested_role: requestedRole, relationship_kind: relationshipKind || null, status: initialStatus,
    verification_method: verificationMethod, evidence, evidence_hints: evidenceHints, source: 'join_bndy_v2',
    created_at: now, updated_at: now, entity_key: entityType+'#'+entityId, user_key: userId
  };

  await dynamodb.put({ TableName: CLAIMS_TABLE, Item: item,
    ConditionExpression: 'attribute_not_exists(claim_id) OR #status IN (:rejected, :cancelled)',
    ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':rejected': 'rejected', ':cancelled': 'cancelled' }
  }).promise().catch(async (error) => { if (error.code !== 'ConditionalCheckFailedException') throw error; });

  const saved = await dynamodb.get({ TableName: CLAIMS_TABLE, Key: { claim_id: id } }).promise();
  return response(201, { action: 'created', claim: saved.Item || item });
}

async function listMyClaims`, 'createClaim');
replace(/async function listPendingClaims\(event\) \{[\s\S]*?\n\}\n\nasync function cancelClaim/,`async function listPendingClaims(event) {
  const auth = await requirePlatformAdmin(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error });
  const result = await dynamodb.scan({ TableName: CLAIMS_TABLE }).promise();
  const reviewable = new Set(['pending','pending_review','verified_pending','more_evidence_required','conflict']);
  return response(200, { claims: (result.Items || []).filter((item) => reviewable.has(item.status)).sort((a,b) => String(a.created_at).localeCompare(String(b.created_at))) });
}

async function cancelClaim`, 'listPendingClaims');
s=s.replace("if (current.Item.status !== 'pending') return response(409, { error: 'Only pending claims can be cancelled', status: current.Item.status });","if (!['pending','pending_review','verified_pending','more_evidence_required'].includes(current.Item.status)) return response(409, { error: 'Only reviewable claims can be cancelled', status: current.Item.status });");
s=s.replace("const role = claim.requested_role === 'admin' ? 'admin' : 'owner';","const role = ['owner','admin','member'].includes(claim.requested_role) ? claim.requested_role : 'admin';");
s=s.replace("if (role === 'owner') transactItems.push({ Update: {\n      TableName: 'bndy-artists'", "if (role === 'owner') transactItems.push({ Update: {\n      TableName: 'bndy-artists'");
s=s.replace("if (current.Item.status !== 'pending') return response(409, { error: 'Claim has already been reviewed', status: current.Item.status });","if (!['pending','pending_review','verified_pending','more_evidence_required','conflict'].includes(current.Item.status)) return response(409, { error: 'Claim has already been reviewed', status: current.Item.status });");
s=s.replace("ConditionExpression: '#status = :pending',\n      ExpressionAttributeNames: { '#status': 'status' },\n      ExpressionAttributeValues: { ':rejected': 'rejected', ':pending': 'pending', ':now': now, ':reviewer': auth.user.userId, ':note': String(body.note || '') },","ConditionExpression: '#status IN (:pending, :pendingReview, :verifiedPending, :moreEvidence, :conflict)',\n      ExpressionAttributeNames: { '#status': 'status' },\n      ExpressionAttributeValues: { ':rejected': 'rejected', ':pending': 'pending', ':pendingReview': 'pending_review', ':verifiedPending': 'verified_pending', ':moreEvidence': 'more_evidence_required', ':conflict': 'conflict', ':now': now, ':reviewer': auth.user.userId, ':note': String(body.note || '') },");
s=s.replace("ConditionExpression: '#status = :pending',\n    ExpressionAttributeNames: { '#status': 'status' },\n    ExpressionAttributeValues: { ':approved': 'approved', ':pending': 'pending', ':now': now, ':reviewer': reviewerId }","ConditionExpression: '#status IN (:pending, :pendingReview, :verifiedPending, :moreEvidence, :conflict)',\n    ExpressionAttributeNames: { '#status': 'status' },\n    ExpressionAttributeValues: { ':approved': 'approved', ':pending': 'pending', ':pendingReview': 'pending_review', ':verifiedPending': 'verified_pending', ':moreEvidence': 'more_evidence_required', ':conflict': 'conflict', ':now': now, ':reviewer': reviewerId }");
fs.writeFileSync(p,s);
console.log('Claim V2 backend patched');
