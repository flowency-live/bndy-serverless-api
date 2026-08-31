'use strict';

const AWS = require('aws-sdk');
const { requirePlatformAdmin } = require('./godmode-access');

const CAPTURE_API_BASE = process.env.CAPTURE_API_BASE || 'https://capture.bndy.co.uk';
const CAPTURE_TOKEN = process.env.CAPTURE_TOKEN || '';

function emailClient() {
  if (!AWS.SES) throw new Error('Email transport is unavailable');
  return new AWS.SES({ region: process.env.AWS_REGION || 'eu-west-2' });
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  try { return JSON.parse(event.body || '{}'); }
  catch { return null; }
}

async function captureRequest(path, options = {}) {
  if (!CAPTURE_TOKEN) throw new Error('Capture service token is not configured');
  const result = await fetch(`${CAPTURE_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${CAPTURE_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  let body = {};
  try { body = await result.json(); } catch { /* status is enough */ }
  if (!result.ok) {
    const error = new Error(body.message || body.error || `Capture returned ${result.status}`);
    error.status = result.status;
    error.body = body;
    throw error;
  }
  return body;
}

function reviewItem(item, followUp) {
  return {
    id: item.id,
    receivedAt: item.receivedAt || item.capturedAt,
    updatedAt: item.updatedAt,
    sourceApp: item.sourceApp,
    status: item.status,
    state: item.publicOutcome?.state,
    publicMessage: item.publicOutcome?.message,
    sharedText: item.sharedText || null,
    note: item.note || null,
    media: item.media ? {
      available: true,
      mimeType: item.media.mimeType,
      originalName: item.media.originalName || null,
    } : { available: false },
    processingAttempt: item.processingAttempt || 0,
    reviewedAt: item.reviewedAt || null,
    reviewedBy: item.reviewedBy || null,
    followUp: followUp?.recordType === 'capture_follow_up' ? {
      method: followUp.method,
      contact: followUp.contact,
      consentedAt: followUp.consentedAt,
      notificationStatus: followUp.notificationStatus,
      notifiedAt: followUp.notifiedAt || null,
    } : null,
  };
}

async function requireAdmin(event) {
  const admin = await requirePlatformAdmin(event);
  if (admin.error) return { errorResponse: response(admin.statusCode, { error: admin.error }) };
  return { admin };
}

async function listReviews(event) {
  const gate = await requireAdmin(event);
  if (gate.errorResponse) return gate.errorResponse;
  const requested = Number(event.queryStringParameters?.limit || 50);
  const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 50, 100));
  const result = await captureRequest(`/v1/captures?status=failed&limit=${limit}`);
  const pending = (result.items || []).filter((item) => item.publicOutcome?.state === 'needs_review');
  const items = await Promise.all(pending.map(async (item) => {
    const followUp = await captureRequest(`/v1/captures/${encodeURIComponent(item.id)}/follow-up`);
    return reviewItem(item, followUp);
  }));
  return response(200, { items });
}

async function getReview(event) {
  const gate = await requireAdmin(event);
  if (gate.errorResponse) return gate.errorResponse;
  const id = event.pathParameters?.id;
  if (!id) return response(400, { error: 'Capture ID is required' });
  const encoded = encodeURIComponent(id);
  const [item, followUp, media] = await Promise.all([
    captureRequest(`/v1/captures/${encoded}`),
    captureRequest(`/v1/captures/${encoded}/follow-up`),
    captureRequest(`/v1/captures/${encoded}/media`),
  ]);
  return response(200, { ...reviewItem(item, followUp), media });
}

function outcomeMessage(outcome) {
  if (outcome.state === 'added') return outcome.result?.event?.url
    ? `Good news. The gig you sent is now on bndy: ${outcome.result.event.url}`
    : 'Good news. The gig you sent has now been added to bndy.';
  if (outcome.state === 'already_exists') return outcome.result?.event?.url
    ? `Thanks for sending it. That gig is already on bndy: ${outcome.result.event.url}`
    : 'Thanks for sending it. That gig was already on bndy.';
  if (outcome.state === 'ignored') return 'We checked your submission, but could not find a live music event in it.';
  return 'We checked your submission but could not add it safely. Thanks for helping bndy.';
}

async function markNotification(id, notificationStatus, notificationError) {
  return captureRequest(`/v1/captures/${encodeURIComponent(id)}/follow-up`, {
    method: 'PATCH',
    body: JSON.stringify({ notificationStatus, ...(notificationError ? { notificationError } : {}) }),
  });
}

async function notifyFollowUp(id, followUp, outcome) {
  if (!followUp?.contact || !followUp?.method) return { status: 'not_requested' };
  const message = outcomeMessage(outcome);
  if (followUp.method === 'email') {
    try {
      await emailClient().sendEmail({
        Source: 'noreply@bndy.co.uk',
        Destination: { ToAddresses: [followUp.contact] },
        Message: {
          Subject: { Data: 'An update on your bndy gig submission' },
          Body: {
            Text: { Data: `${message}\n\nSubmission reference: ${id}` },
          },
        },
      }).promise();
      await markNotification(id, 'sent');
      return { status: 'sent', method: 'email' };
    } catch (error) {
      await markNotification(id, 'failed', error.message);
      return { status: 'failed', method: 'email' };
    }
  }

  try {
    await captureRequest(`/v1/captures/${encodeURIComponent(id)}/notify`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    return { status: 'sent', method: 'whatsapp' };
  } catch (error) {
    const status = error.status === 409 && ['whatsapp_disabled', 'whatsapp_follow_up_not_configured'].includes(error.body?.error)
      ? 'transport_unavailable'
      : 'failed';
    await markNotification(id, status, error.message);
    return { status, method: 'whatsapp' };
  }
}

async function review(event) {
  const gate = await requireAdmin(event);
  if (gate.errorResponse) return gate.errorResponse;
  const body = parseBody(event);
  if (!body) return response(400, { error: 'Invalid JSON body' });
  const id = event.pathParameters?.id;
  if (!id) return response(400, { error: 'Capture ID is required' });
  const reviewer = gate.admin.dbUser.display_name || gate.admin.dbUser.email || gate.admin.session.userId;
  const reviewed = await captureRequest(`/v1/captures/${encodeURIComponent(id)}/review`, {
    method: 'POST',
    body: JSON.stringify({ ...body, reviewer }),
  });
  if (body.action !== 'resolve') return response(200, reviewed);
  const notification = await notifyFollowUp(id, reviewed.followUp, body.publicOutcome);
  return response(200, { ...reviewed, notification });
}

async function handle(event) {
  try {
    const method = (event.requestContext?.http?.method || event.httpMethod || '').toUpperCase();
    const path = event.requestContext?.http?.path || event.rawPath || event.path || '';
    if (method === 'GET' && path === '/api/admin/captures') return listReviews(event);
    if (method === 'GET' && /^\/api\/admin\/captures\/[^/]+$/.test(path)) return getReview(event);
    if (method === 'POST' && /^\/api\/admin\/captures\/[^/]+\/review$/.test(path)) return review(event);
    return response(404, { error: 'Not found' });
  } catch (error) {
    console.error('[CAPTURE REVIEW] request failed', { name: error.name, status: error.status });
    return response(error.status && error.status < 500 ? error.status : 502, {
      error: error.status === 404 ? 'Capture not found' : 'Capture review service is temporarily unavailable',
    });
  }
}

module.exports = { handle, reviewItem, outcomeMessage };
