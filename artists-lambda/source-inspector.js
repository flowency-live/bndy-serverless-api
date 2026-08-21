'use strict';

/**
 * Public, read-only Facebook source inspection for bndy community flows.
 *
 * This endpoint deliberately does NOT create or update artists/venues. It:
 *  - extracts a Facebook URL from pasted URL/share text
 *  - canonicalises identity using the existing artist identity implementation
 *  - returns an existing artist immediately when the FB identity is known
 *  - otherwise performs a tightly constrained, best-effort Facebook HTML fetch
 *    and returns only metadata actually observed in that response
 *
 * It is intentionally NOT a generic URL fetcher. User input can only resolve to
 * approved Facebook hostnames, redirects are revalidated, and bodies are capped.
 */

const AWS = require('aws-sdk');
const https = require('https');
const { facebookKey } = require('./lib/identity');

const keepAliveAgent = new https.Agent({ keepAlive: true });
const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: 'eu-west-2',
  httpOptions: { agent: keepAliveAgent },
});

const UNIQUE_KEYS_TABLE = process.env.UNIQUE_KEYS_TABLE || 'bndy-unique-keys';
const ARTISTS_TABLE = process.env.ARTISTS_TABLE || 'bndy-artists';
const MAX_INPUT_LENGTH = 5000;
const MAX_HTML_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 3;

const INPUT_HOSTS = new Set([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'mbasic.facebook.com',
  'web.facebook.com',
  'fb.com',
  'www.fb.com',
  'fb.me',
  'www.fb.me',
]);

const FETCH_HOSTS = new Set([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'mbasic.facebook.com',
  'web.facebook.com',
]);

function response(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function normaliseCandidate(candidate) {
  if (!candidate || typeof candidate !== 'string') return null;
  let value = candidate.trim();
  value = value.replace(/^[\s<'"([{]+/, '').replace(/[\s>'"\])},.!;:]+$/, '');
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (!INPUT_HOSTS.has(host)) return null;
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.port && parsed.port !== '443' && parsed.port !== '80') return null;
  return parsed.toString();
}

/** Extract the first Facebook URL from a pristine URL or messy share text. */
function extractFacebookUrl(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > MAX_INPUT_LENGTH) return null;

  // Domain is explicit rather than a generic URL regex: this endpoint must never
  // become an arbitrary server-side fetch primitive.
  const re = /(?:https?:\/\/)?(?:(?:www|m|mbasic|web)\.)?(?:facebook\.com|fb\.com|fb\.me)\/[^^\s<>"']+/ig;
  const candidates = text.match(re) || [];
  for (const candidate of candidates) {
    const normalised = normaliseCandidate(candidate);
    if (normalised) return normalised;
  }

  // Also allow a bare canonical host with no path only so validation can return
  // a useful Facebook-specific error rather than treating it as arbitrary text.
  const direct = normaliseCandidate(text);
  return direct;
}

function canonicalFacebookUrl(rawUrl) {
  const key = facebookKey(rawUrl);
  if (!key) return null;
  const path = key.replace(/^facebook\.com\//, '');
  if (!path) return null;
  return `https://www.facebook.com/${path}`;
}

function isSafeFetchUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    return parsed.protocol === 'https:'
      && FETCH_HOSTS.has(parsed.hostname.toLowerCase())
      && !parsed.username
      && !parsed.password
      && (!parsed.port || parsed.port === '443');
  } catch {
    return false;
  }
}

function fetchFacebookHtml(urlString, options = {}) {
  const timeoutMs = options.timeoutMs || FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes || MAX_HTML_BYTES;
  const redirectsLeft = options.redirectsLeft === undefined ? MAX_REDIRECTS : options.redirectsLeft;

  if (!isSafeFetchUrl(urlString)) {
    const err = new Error('Unsafe Facebook fetch URL');
    err.code = 'UNSAFE_URL';
    return Promise.reject(err);
  }

  return new Promise((resolve, reject) => {
    const request = https.get(urlString, {
      agent: keepAliveAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; bndy-source-inspector/1.0; +https://bndy.co.uk)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;

      if ([301, 302, 303, 307, 308].includes(status) && location) {
        res.resume();
        if (redirectsLeft <= 0) {
          const err = new Error('Too many Facebook redirects');
          err.code = 'TOO_MANY_REDIRECTS';
          reject(err);
          return;
        }

        let nextUrl;
        try {
          nextUrl = new URL(location, urlString).toString();
        } catch {
          const err = new Error('Invalid Facebook redirect');
          err.code = 'UNSAFE_REDIRECT';
          reject(err);
          return;
        }

        if (!isSafeFetchUrl(nextUrl)) {
          const err = new Error('Facebook redirected outside the allowed host set');
          err.code = 'UNSAFE_REDIRECT';
          reject(err);
          return;
        }

        fetchFacebookHtml(nextUrl, { timeoutMs, maxBytes, redirectsLeft: redirectsLeft - 1 })
          .then(resolve, reject);
        return;
      }

      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        res.resume();
        const err = new Error(`Unexpected Facebook content type: ${contentType || 'unknown'}`);
        err.code = 'UNEXPECTED_CONTENT_TYPE';
        reject(err);
        return;
      }

      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          res.destroy();
          const err = new Error('Facebook response exceeded size limit');
          err.code = 'RESPONSE_TOO_LARGE';
          reject(err);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          statusCode: status,
          finalUrl: urlString,
          contentType,
          html: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', reject);
    });

    request.setTimeout(timeoutMs, () => {
      const err = new Error('Facebook inspection timed out');
      err.code = 'FETCH_TIMEOUT';
      request.destroy(err);
    });
    request.on('error', reject);
  });
}

function decodeHtml(value) {
  if (!value) return '';
  return String(value)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function readAttribute(tag, attrName) {
  const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match ? decodeHtml(match[2]) : '';
}

function readMeta(html) {
  const meta = new Map();
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const key = (readAttribute(tag, 'property') || readAttribute(tag, 'name')).toLowerCase();
    const content = readAttribute(tag, 'content');
    if (key && content && !meta.has(key)) meta.set(key, content);
  }
  return meta;
}

function readCanonicalLink(html) {
  const tags = String(html || '').match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = readAttribute(tag, 'rel').toLowerCase();
    if (rel.split(/\s+/).includes('canonical')) return readAttribute(tag, 'href') || null;
  }
  return null;
}

function cleanFacebookTitle(title) {
  if (!title) return null;
  let value = decodeHtml(title)
    .replace(/\s*[|–—-]\s*Facebook\s*$/i, '')
    .trim();

  const generic = value.toLowerCase();
  if (!value
      || generic === 'facebook'
      || generic.includes('log in or sign up')
      || generic.includes('log into facebook')
      || generic.includes('facebook – log in')) {
    return null;
  }
  return value;
}

function safeObservedImage(urlString) {
  if (!urlString) return null;
  try {
    const parsed = new URL(urlString);
    const host = parsed.hostname.toLowerCase();
    const allowed = host === 'facebook.com'
      || host.endsWith('.facebook.com')
      || host === 'fbcdn.net'
      || host.endsWith('.fbcdn.net')
      || host === 'fbsbx.com'
      || host.endsWith('.fbsbx.com');
    return parsed.protocol === 'https:' && allowed ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function parseFacebookMetadata(html, finalUrl) {
  const meta = readMeta(html);
  const rawTitle = meta.get('og:title') || meta.get('twitter:title') || '';
  const rawImage = meta.get('og:image') || meta.get('twitter:image') || '';
  const rawDescription = meta.get('og:description') || meta.get('description') || '';
  const rawCanonical = meta.get('og:url') || readCanonicalLink(html) || finalUrl || '';

  const title = cleanFacebookTitle(rawTitle);
  const imageUrl = safeObservedImage(rawImage);
  const canonical = normaliseCandidate(rawCanonical) || normaliseCandidate(finalUrl);

  return {
    observed: {
      name: title,
      imageUrl,
      description: rawDescription ? decodeHtml(rawDescription).slice(0, 1000) : null,
      canonicalUrl: canonical,
      location: null,
      address: null,
      websiteUrl: null,
    },
    evidence: {
      ...(title ? { name: 'facebook_html_meta' } : {}),
      ...(imageUrl ? { imageUrl: 'facebook_html_meta' } : {}),
      ...(rawDescription ? { description: 'facebook_html_meta' } : {}),
      ...(canonical ? { canonicalUrl: 'facebook_html_meta' } : {}),
    },
  };
}

async function findExistingArtistByFacebookKey(key, client = dynamodb) {
  if (!key) return null;
  const sentinel = await client.get({
    TableName: UNIQUE_KEYS_TABLE,
    Key: { key: `artist#fb#${key}` },
  }).promise();

  const artistId = sentinel.Item?.refId;
  if (!artistId) return null;

  const artistResult = await client.get({
    TableName: ARTISTS_TABLE,
    Key: { id: artistId },
    ProjectionExpression: 'id, #name, #location, profileImageUrl, facebookUrl, websiteUrl, hidden, deleted',
    ExpressionAttributeNames: {
      '#name': 'name',
      '#location': 'location',
    },
  }).promise();

  const artist = artistResult.Item;
  if (!artist || artist.hidden || artist.deleted) return null;
  return artist;
}

async function inspectFacebookSource({ input, expectedType = null, client = dynamodb, fetchHtml = fetchFacebookHtml }) {
  if (typeof input !== 'string' || !input.trim()) {
    const err = new Error('Paste a Facebook page URL');
    err.statusCode = 400;
    err.code = 'INPUT_REQUIRED';
    throw err;
  }
  if (input.length > MAX_INPUT_LENGTH) {
    const err = new Error('Pasted text is too long');
    err.statusCode = 413;
    err.code = 'INPUT_TOO_LONG';
    throw err;
  }
  if (expectedType !== null && expectedType !== 'artist' && expectedType !== 'venue') {
    const err = new Error('expectedType must be artist or venue');
    err.statusCode = 400;
    err.code = 'INVALID_EXPECTED_TYPE';
    throw err;
  }

  const extractedUrl = extractFacebookUrl(input);
  const key = extractedUrl ? facebookKey(extractedUrl) : '';
  const canonicalUrl = extractedUrl ? canonicalFacebookUrl(extractedUrl) : null;

  if (!extractedUrl || !key || !canonicalUrl) {
    const err = new Error('That does not look like a Facebook profile or page URL');
    err.statusCode = 422;
    err.code = 'NOT_FACEBOOK_URL';
    throw err;
  }

  // Artist Facebook identity is already a hard uniqueness key. Resolve it first
  // and avoid hitting Facebook at all when bndy already knows this page.
  if (expectedType !== 'venue') {
    const existing = await findExistingArtistByFacebookKey(key, client);
    if (existing) {
      return {
        source: 'facebook',
        input,
        facebookUrl: canonicalUrl,
        facebookKey: key,
        valid: true,
        inspected: false,
        existing: {
          entityType: 'artist',
          id: existing.id,
          name: existing.name,
        },
        observed: {
          name: existing.name || null,
          imageUrl: existing.profileImageUrl || null,
          description: null,
          canonicalUrl: canonicalUrl,
          location: existing.location || null,
          address: null,
          websiteUrl: existing.websiteUrl || null,
        },
        evidence: {
          name: 'bndy_existing_artist',
          ...(existing.profileImageUrl ? { imageUrl: 'bndy_existing_artist' } : {}),
          ...(existing.location ? { location: 'bndy_existing_artist' } : {}),
          ...(existing.websiteUrl ? { websiteUrl: 'bndy_existing_artist' } : {}),
        },
        warnings: [],
      };
    }
  }

  const warnings = [];
  let parsed = {
    observed: {
      name: null,
      imageUrl: null,
      description: null,
      canonicalUrl,
      location: null,
      address: null,
      websiteUrl: null,
    },
    evidence: { canonicalUrl: 'facebook_identity' },
  };

  try {
    const fetched = await fetchHtml(canonicalUrl);
    if (fetched.statusCode >= 200 && fetched.statusCode < 300) {
      parsed = parseFacebookMetadata(fetched.html, fetched.finalUrl || canonicalUrl);
      if (!parsed.observed.canonicalUrl) parsed.observed.canonicalUrl = canonicalUrl;
    } else {
      warnings.push(`facebook_http_${fetched.statusCode || 'unknown'}`);
    }
  } catch (error) {
    // Facebook frequently changes anonymous-page behaviour. Inspection is an
    // accelerator, not a blocker: retain the canonical URL and let the user
    // continue with the normal bndy form.
    warnings.push(error.code || 'facebook_fetch_failed');
  }

  return {
    source: 'facebook',
    input,
    facebookUrl: canonicalUrl,
    facebookKey: key,
    valid: true,
    inspected: true,
    existing: null,
    observed: parsed.observed,
    evidence: parsed.evidence,
    warnings,
  };
}

async function handler(event) {
  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {});
  } catch {
    return response(400, { error: 'Invalid JSON body', code: 'INVALID_JSON' });
  }

  try {
    const result = await inspectFacebookSource({
      input: body.input,
      expectedType: body.expectedType ?? null,
    });
    return response(200, result);
  } catch (error) {
    console.warn('[source-inspector] request rejected:', error.code || error.message);
    return response(error.statusCode || 500, {
      error: error.statusCode ? error.message : 'Could not inspect that Facebook page right now',
      code: error.code || 'INSPECTION_FAILED',
    });
  }
}

module.exports = {
  handler,
  extractFacebookUrl,
  canonicalFacebookUrl,
  isSafeFetchUrl,
  fetchFacebookHtml,
  parseFacebookMetadata,
  cleanFacebookTitle,
  inspectFacebookSource,
  findExistingArtistByFacebookKey,
};
