const AWS = require('aws-sdk');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const TABLE = process.env.JOIN_ANALYTICS_TABLE || 'bndy-join-analytics';

const ALLOWED_EVENTS = new Set([
  'join_opened',
  'entity_type_selected',
  'identity_search_submitted',
  'existing_candidate_shown',
  'candidate_accepted',
  'candidate_rejected',
  'claim_branch_entered',
  'claim_requested',
  'create_new_confirmed',
  'auth_gate_shown',
  'entity_creation_completed',
  'entity_creation_duplicate_gated',
  'entity_creation_failed',
  'profile_step_completed',
  'profile_step_skipped',
  'join_completed',
  'delegate_invitation_created',
  'delegate_invitation_accepted',
  'delegate_revoked',
  'ownership_transferred',
]);

function response(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function cleanString(value, max = 120) {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (!v) return undefined;
  return v.slice(0, max);
}

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  if (method !== 'POST') return response(405, { error: 'Method not allowed' });

  let body;
  try { body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {}); }
  catch { return response(400, { error: 'Invalid JSON body' }); }

  const eventName = cleanString(body.event, 80);
  if (!eventName || !ALLOWED_EVENTS.has(eventName)) return response(400, { error: 'Unsupported Join analytics event' });

  const entityType = body.entityType === 'artist' || body.entityType === 'venue' ? body.entityType : undefined;
  const sessionId = cleanString(body.sessionId, 80) || crypto.randomUUID();
  const now = new Date();
  const ttl = Math.floor(now.getTime() / 1000) + (90 * 24 * 60 * 60);

  // Deliberately small and non-sensitive. No artist/venue names, emails, bios,
  // addresses or free-text form contents are accepted into funnel telemetry.
  const item = {
    id: crypto.randomUUID(),
    event: eventName,
    session_id: sessionId,
    entity_type: entityType,
    step: cleanString(body.step, 60),
    result: cleanString(body.result, 60),
    source: 'join-bndy',
    created_at: now.toISOString(),
    expires_at: ttl,
  };

  Object.keys(item).forEach((key) => item[key] === undefined && delete item[key]);

  try {
    await dynamodb.put({ TableName: TABLE, Item: item }).promise();
    return response(202, { accepted: true });
  } catch (error) {
    console.error('[JOIN_ANALYTICS] write failed', error);
    // Analytics must never break onboarding.
    return response(202, { accepted: false });
  }
};
