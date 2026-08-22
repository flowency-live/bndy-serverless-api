'use strict';

/**
 * Thin enrichment wrapper around source-inspector.js.
 *
 * The base inspector owns URL safety, identity resolution and DynamoDB lookup.
 * This wrapper only adds deterministic, source-backed fallbacks when Facebook's
 * primary anonymous HTML is too sparse to expose useful Open Graph metadata:
 *  - a second read from Facebook's mbasic surface for a real page <title>
 *  - the long-standing Graph profile-picture redirect for artist artwork
 *  - a clearly-labelled handle-derived name hint as a last resort
 *
 * None of these fallbacks create or update entities. Handle-derived names are
 * deliberately marked as hints so callers must not treat them as verified data.
 */

const https = require('https');
const base = require('./source-inspector');

const FALLBACK_TIMEOUT_MS = 2200;
const FALLBACK_HTML_BYTES = 256 * 1024;
const MAX_IMAGE_REDIRECTS = 3;

function response(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function handleFromFacebookKey(key) {
  if (!key || typeof key !== 'string') return null;
  const prefix = 'facebook.com/';
  if (!key.startsWith(prefix)) return null;
  const handle = key.slice(prefix.length);
  if (!handle || handle.includes('/')) return null;
  return /^[a-z0-9.]{2,}$/i.test(handle) ? handle : null;
}

function nameHintFromHandle(handle) {
  if (!handle || /^\d+$/.test(handle)) return null;
  const words = handle
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!words.length) return null;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

function readHtmlTitle(html) {
  const match = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? base.cleanFacebookTitle(match[1]) : null;
}

async function fetchBasicFacebookMetadata(handle, fetchHtml = base.fetchFacebookHtml) {
  const url = `https://mbasic.facebook.com/${encodeURIComponent(handle)}`;
  const fetched = await fetchHtml(url, {
    timeoutMs: FALLBACK_TIMEOUT_MS,
    maxBytes: FALLBACK_HTML_BYTES,
    redirectsLeft: 2,
  });

  if (fetched.statusCode < 200 || fetched.statusCode >= 300) return null;
  const parsed = base.parseFacebookMetadata(fetched.html, fetched.finalUrl || url);
  if (!parsed.observed.name) {
    const title = readHtmlTitle(fetched.html);
    if (title) {
      parsed.observed.name = title;
      parsed.evidence.name = 'facebook_basic_html';
    }
  }
  if (parsed.observed.description && !parsed.evidence.description) {
    parsed.evidence.description = 'facebook_basic_html';
  }
  return parsed;
}

function isAllowedImageUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'graph.facebook.com'
      || host === 'facebook.com'
      || host.endsWith('.facebook.com')
      || host === 'fbcdn.net'
      || host.endsWith('.fbcdn.net')
      || host === 'fbsbx.com'
      || host.endsWith('.fbsbx.com');
  } catch {
    return false;
  }
}

function fetchGraphProfilePicture(handle, redirectsLeft = MAX_IMAGE_REDIRECTS) {
  const startUrl = `https://graph.facebook.com/${encodeURIComponent(handle)}/picture?type=large`;

  const visit = (urlString, remaining) => new Promise((resolve) => {
    if (!isAllowedImageUrl(urlString)) {
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const request = https.get(urlString, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; bndy-source-inspector/1.2; +https://bndy.co.uk)',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;

      if ([301, 302, 303, 307, 308].includes(status) && location && remaining > 0) {
        res.resume();
        let next;
        try {
          next = new URL(location, urlString).toString();
        } catch {
          finish(null);
          return;
        }
        if (!isAllowedImageUrl(next)) {
          finish(null);
          return;
        }
        visit(next, remaining - 1).then(finish);
        return;
      }

      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      res.resume();
      finish(status >= 200 && status < 300 && contentType.startsWith('image/') ? urlString : null);
    });

    request.setTimeout(FALLBACK_TIMEOUT_MS, () => request.destroy());
    request.on('error', () => finish(null));
  });

  return visit(startUrl, redirectsLeft);
}

async function enrichInspectionResult(result, { expectedType = null, fetchHtml = base.fetchFacebookHtml, fetchPicture = fetchGraphProfilePicture } = {}) {
  if (!result?.valid || result.existing || !result.identityResolved || !result.facebookKey) return result;

  const handle = handleFromFacebookKey(result.facebookKey);
  if (!handle) return result;

  const observed = { ...(result.observed || {}) };
  const evidence = { ...(result.evidence || {}) };

  if (!observed.name || !observed.imageUrl || !observed.description) {
    try {
      const fallback = await fetchBasicFacebookMetadata(handle, fetchHtml);
      if (fallback) {
        if (!observed.name && fallback.observed.name) {
          observed.name = fallback.observed.name;
          evidence.name = fallback.evidence.name || 'facebook_basic_html';
        }
        if (!observed.imageUrl && fallback.observed.imageUrl) {
          observed.imageUrl = fallback.observed.imageUrl;
          evidence.imageUrl = fallback.evidence.imageUrl || 'facebook_basic_html';
        }
        if (!observed.description && fallback.observed.description) {
          observed.description = fallback.observed.description;
          evidence.description = fallback.evidence.description || 'facebook_basic_html';
        }
      }
    } catch {
      // Optional fallback only. The base result remains valid and usable.
    }
  }

  if (expectedType === 'artist' && !observed.imageUrl) {
    const picture = await fetchPicture(handle);
    if (picture) {
      observed.imageUrl = picture;
      evidence.imageUrl = 'facebook_graph_picture';
    }
  }

  if (!observed.name) {
    const hint = nameHintFromHandle(handle);
    if (hint) {
      observed.name = hint;
      evidence.name = 'facebook_handle_hint';
    }
  }

  return {
    ...result,
    observed,
    evidence,
  };
}

async function inspectFacebookSourceV2({ input, expectedType = null, client, fetchHtml, fetchPicture } = {}) {
  const result = await base.inspectFacebookSource({ input, expectedType, client, fetchHtml });
  return enrichInspectionResult(result, { expectedType, fetchHtml, fetchPicture });
}

async function handler(event) {
  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {});
  } catch {
    return response(400, { error: 'Invalid JSON body', code: 'INVALID_JSON' });
  }

  try {
    const result = await inspectFacebookSourceV2({
      input: body.input,
      expectedType: body.expectedType ?? null,
    });
    return response(200, result);
  } catch (error) {
    console.warn('[source-inspector-v2] request rejected:', error.code || error.message);
    return response(error.statusCode || 500, {
      error: error.statusCode ? error.message : 'Could not inspect that Facebook page right now',
      code: error.code || 'INSPECTION_FAILED',
    });
  }
}

module.exports = {
  handler,
  handleFromFacebookKey,
  nameHintFromHandle,
  readHtmlTitle,
  fetchBasicFacebookMetadata,
  fetchGraphProfilePicture,
  enrichInspectionResult,
  inspectFacebookSourceV2,
};
