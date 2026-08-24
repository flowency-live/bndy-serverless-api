'use strict';

/**
 * Production transport wrapper for the Facebook source inspector.
 *
 * v2 owns all identity, trust and parsing behaviour. This wrapper only changes
 * the anonymous HTML representation we ask Facebook for. The previous
 * bndy-specific bot User-Agent is frequently served Facebook's generic
 * Error/login shell, even when public page metadata is available. Facebook's
 * link-preview representation exposes the public Open Graph / embedded page
 * payload without requiring a user account or cookies.
 *
 * Security invariants remain the same as the base inspector:
 *  - HTTPS only
 *  - exact Facebook host allow-list via base.isSafeFetchUrl()
 *  - every redirect revalidated
 *  - bounded response size and timeout
 *  - no cookies or authenticated Facebook session
 */

const https = require('https');
const base = require('./source-inspector');
const v2 = require('./source-inspector-v2');

const keepAliveAgent = new https.Agent({ keepAlive: true });
const PREVIEW_USER_AGENT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_REDIRECTS = 3;

function response(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function appendBoundedChunk(chunks, chunk, total, maxBytes) {
  const remaining = Math.max(0, maxBytes - total);
  if (chunk.length <= remaining) {
    chunks.push(chunk);
    return { total: total + chunk.length, truncated: false };
  }

  // Facebook pages can exceed the transport cap, but their public Open Graph
  // and structured metadata is normally near the start of the document. Keep
  // that bounded prefix instead of discarding every useful byte.
  if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
  return { total: maxBytes, truncated: true };
}

function fetchFacebookPreviewHtml(urlString, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const redirectsLeft = options.redirectsLeft === undefined ? DEFAULT_REDIRECTS : options.redirectsLeft;

  if (!base.isSafeFetchUrl(urlString)) {
    const err = new Error('Unsafe Facebook fetch URL');
    err.code = 'UNSAFE_URL';
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const request = https.get(urlString, {
      agent: keepAliveAgent,
      headers: {
        'User-Agent': PREVIEW_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
    }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;

      if ([301, 302, 303, 307, 308].includes(status) && location) {
        res.resume();
        if (redirectsLeft <= 0) {
          const err = new Error('Too many Facebook redirects');
          err.code = 'TOO_MANY_REDIRECTS';
          done(reject, err);
          return;
        }

        let nextUrl;
        try {
          nextUrl = new URL(location, urlString).toString();
        } catch {
          const err = new Error('Invalid Facebook redirect');
          err.code = 'UNSAFE_REDIRECT';
          done(reject, err);
          return;
        }

        if (!base.isSafeFetchUrl(nextUrl)) {
          const err = new Error('Facebook redirected outside the allowed host set');
          err.code = 'UNSAFE_REDIRECT';
          done(reject, err);
          return;
        }

        fetchFacebookPreviewHtml(nextUrl, {
          timeoutMs,
          maxBytes,
          redirectsLeft: redirectsLeft - 1,
        }).then(
          (value) => done(resolve, value),
          (error) => done(reject, error),
        );
        return;
      }

      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        res.resume();
        const err = new Error(`Unexpected Facebook content type: ${contentType || 'unknown'}`);
        err.code = 'UNEXPECTED_CONTENT_TYPE';
        done(reject, err);
        return;
      }

      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        if (settled) return;
        const appended = appendBoundedChunk(chunks, chunk, total, maxBytes);
        total = appended.total;
        if (appended.truncated) {
          done(resolve, {
            statusCode: status,
            finalUrl: urlString,
            contentType,
            html: Buffer.concat(chunks).toString('utf8'),
            truncated: true,
          });
          res.destroy();
        }
      });
      res.on('end', () => {
        if (settled) return;
        done(resolve, {
          statusCode: status,
          finalUrl: urlString,
          contentType,
          html: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', (error) => done(reject, error));
    });

    request.setTimeout(timeoutMs, () => {
      const err = new Error('Facebook inspection timed out');
      err.code = 'FETCH_TIMEOUT';
      request.destroy(err);
    });
    request.on('error', (error) => done(reject, error));
  });
}

async function handler(event) {
  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {});
  } catch {
    return response(400, { error: 'Invalid JSON body', code: 'INVALID_JSON' });
  }

  try {
    const result = await v2.inspectFacebookSourceV2({
      input: body.input,
      expectedType: body.expectedType ?? null,
      fetchHtml: fetchFacebookPreviewHtml,
    });
    return response(200, result);
  } catch (error) {
    console.warn('[source-inspector-v3] request rejected:', error.code || error.message);
    return response(error.statusCode || 500, {
      error: error.statusCode ? error.message : 'Could not inspect that Facebook page right now',
      code: error.code || 'INSPECTION_FAILED',
    });
  }
}

module.exports = {
  handler,
  PREVIEW_USER_AGENT,
  appendBoundedChunk,
  fetchFacebookPreviewHtml,
};
