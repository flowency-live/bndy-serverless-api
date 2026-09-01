'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const RECEIPT_ISSUER = 'bndy-claims';
const RECEIPT_AUDIENCE = 'bndy-facebook-page-claim';
const RECEIPT_LIFETIME_SECONDS = 5 * 60;
const STATE_LIFETIME_SECONDS = 5 * 60;
const ALLOWED_TARGET_ORIGINS = new Set([
  'https://bndy.live',
  'https://stage.bndy.live',
  'http://localhost:3000',
  'http://localhost:3001',
]);

function validateTargetOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const origin = new URL(value).origin;
    return ALLOWED_TARGET_ORIGINS.has(origin) ? origin : null;
  } catch {
    return null;
  }
}

function normaliseEntity(entityType, entityId) {
  const type = entityType === 'artist' || entityType === 'venue' ? entityType : null;
  const id = String(entityId || '').trim();
  if (!type || !id || id.length > 200) return null;
  return { entityType: type, entityId: id };
}

function sanitisePage(rawPage) {
  const id = String(rawPage?.id || '').trim();
  const name = String(rawPage?.name || '').trim().slice(0, 200);
  if (!/^\d{3,32}$/.test(id) || !name) return null;
  const tasks = Array.isArray(rawPage.tasks)
    ? [...new Set(rawPage.tasks.map((task) => String(task).trim().toUpperCase()).filter(Boolean))].slice(0, 30)
    : [];
  return { id, name, tasks, pageUrl: `https://www.facebook.com/${id}` };
}

function sanitisePages(rawPages) {
  if (!Array.isArray(rawPages)) return [];
  const pages = [];
  const seen = new Set();
  for (const rawPage of rawPages) {
    const page = sanitisePage(rawPage);
    if (!page || seen.has(page.id)) continue;
    seen.add(page.id);
    pages.push(page);
    if (pages.length === 100) break;
  }
  return pages;
}

function generateOpaqueState() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateReceiptId() {
  return crypto.randomUUID();
}

function stateRecord({ state, userId, entityType, entityId, targetOrigin, callbackUri, now = Date.now() }) {
  return {
    state,
    record_kind: 'facebook_page_oauth_state',
    user_id: userId,
    entity_type: entityType,
    entity_id: entityId,
    target_origin: targetOrigin,
    callback_uri: callbackUri,
    created_at: new Date(now).toISOString(),
    ttl: Math.floor(now / 1000) + STATE_LIFETIME_SECONDS,
  };
}

function receiptRecord({ receiptId, userId, entityType, entityId, pages, now = Date.now() }) {
  return {
    state: `facebook-page-receipt#${receiptId}`,
    record_kind: 'facebook_page_receipt',
    user_id: userId,
    entity_type: entityType,
    entity_id: entityId,
    pages,
    created_at: new Date(now).toISOString(),
    ttl: Math.floor(now / 1000) + RECEIPT_LIFETIME_SECONDS,
  };
}

function signReceipt({ receiptId, userId, entityType, entityId, pages, secret }) {
  return jwt.sign({
    type: 'facebook_page_verification',
    userId,
    entityType,
    entityId,
    pageIds: pages.map((page) => page.id),
  }, secret, {
    algorithm: 'HS256',
    expiresIn: RECEIPT_LIFETIME_SECONDS,
    issuer: RECEIPT_ISSUER,
    audience: RECEIPT_AUDIENCE,
    jwtid: receiptId,
  });
}

function verifyReceipt({ token, selectedPageId, userId, entityType, entityId, secret }) {
  const claims = jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer: RECEIPT_ISSUER,
    audience: RECEIPT_AUDIENCE,
  });
  const pageId = String(selectedPageId || '').trim();
  if (
    claims.type !== 'facebook_page_verification' ||
    claims.userId !== userId ||
    claims.entityType !== entityType ||
    claims.entityId !== entityId ||
    typeof claims.jti !== 'string' ||
    !Array.isArray(claims.pageIds) ||
    !claims.pageIds.includes(pageId)
  ) {
    throw Object.assign(new Error('Facebook Page verification does not match this claim.'), {
      code: 'FACEBOOK_PAGE_RECEIPT_MISMATCH',
    });
  }
  return { receiptId: claims.jti, pageId };
}

function appSecretProof(appSecret, accessToken) {
  return crypto.createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

function facebookPageIdsFromEntity(entity) {
  const values = [entity?.facebookUrl, entity?.facebook_url];
  for (const collection of [entity?.socialMediaUrls, entity?.social_media_urls]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (typeof item === 'string' && /facebook\.com/i.test(item)) values.push(item);
      if (item && typeof item === 'object' && String(item.platform || '').toLowerCase() === 'facebook') values.push(item.url);
    }
  }
  const ids = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    try {
      const url = new URL(value.trim());
      if (!/(^|\.)facebook\.com$/i.test(url.hostname)) continue;
      const firstPathPart = url.pathname.split('/').filter(Boolean)[0];
      if (/^\d{3,32}$/.test(firstPathPart || '')) ids.add(firstPathPart);
      const idParam = url.searchParams.get('id');
      if (/^\d{3,32}$/.test(idParam || '')) ids.add(idParam);
    } catch {
      // Ignore malformed legacy values. A name or handle is not stable proof.
    }
  }
  return ids;
}

function entityPageMatch(entity, pageId) {
  return facebookPageIdsFromEntity(entity).has(String(pageId)) ? 'stable_page_id' : 'review_required';
}

function serialiseForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function callbackHtml(targetOrigin, payload) {
  const safeOrigin = validateTargetOrigin(targetOrigin) || 'https://bndy.live';
  const serialisedPayload = serialiseForInlineScript({
    type: 'bndy:facebook-page-verification',
    ...payload,
  });
  const serialisedOrigin = serialiseForInlineScript(safeOrigin);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Facebook Page verification</title></head>
<body><p>Facebook Page verification is complete. You can return to bndy.</p>
<script>if(window.opener){window.opener.postMessage(${serialisedPayload},${serialisedOrigin});}window.close();</script>
</body>
</html>`;
}

module.exports = {
  RECEIPT_LIFETIME_SECONDS,
  STATE_LIFETIME_SECONDS,
  appSecretProof,
  callbackHtml,
  entityPageMatch,
  generateOpaqueState,
  generateReceiptId,
  normaliseEntity,
  receiptRecord,
  sanitisePages,
  signReceipt,
  stateRecord,
  validateTargetOrigin,
  verifyReceipt,
};
