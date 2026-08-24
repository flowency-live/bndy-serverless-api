'use strict';

/**
 * Enrichment wrapper around source-inspector.js.
 *
 * The base inspector owns URL safety, core identity resolution and DynamoDB
 * lookup. This wrapper adds deterministic, source-backed fallbacks for the
 * messy reality of anonymous Facebook pages:
 *  - reject Facebook system/login routes as entity identity
 *  - preserve stable input identity when Facebook redirects anonymous users to login
 *  - inspect mbasic profile and About surfaces in parallel
 *  - parse conservative structured fields embedded in Facebook HTML
 *  - reuse the long-standing Graph profile-picture redirect for artist artwork
 *  - use a clearly-labelled handle-derived name hint only as the final fallback
 *
 * None of these fallbacks create or update entities. Handle-derived names are
 * deliberately marked as hints so callers must not treat them as verified data.
 */

const https = require('https');
const base = require('./source-inspector');

const FALLBACK_TIMEOUT_MS = 2200;
const FALLBACK_HTML_BYTES = 384 * 1024;
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
  return /^[a-z0-9._-]{2,}$/i.test(handle) ? handle : null;
}

function isFacebookSystemIdentityKey(key) {
  const handle = handleFromFacebookKey(key);
  if (!handle) return false;
  return /^(?:login(?:\.php)?|home(?:\.php)?|recover(?:\/.*)?|checkpoint|help|privacy|policies|settings|notifications|friends|marketplace|gaming)$/i.test(handle);
}

function nameHintFromHandle(handle) {
  if (!handle || /^\d+$/.test(handle) || isFacebookSystemIdentityKey(`facebook.com/${handle}`)) return null;

  const separated = handle
    .replace(/[._-]+/g, ' ')
    .trim();
  if (!separated) return null;

  const words = separated.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }

  // A very common band-page convention is a compact vanity handle such as
  // "thecurrantsband". This remains an UNVERIFIED hint, but splitting the
  // explicit The…Band wrapper is materially more useful than "Thecurrantsband".
  const compactBand = separated.match(/^the([a-z0-9]{2,})band$/i);
  if (compactBand) {
    const middle = compactBand[1];
    return `The ${middle.charAt(0).toUpperCase()}${middle.slice(1)} Band`;
  }
  const bandSuffix = separated.match(/^([a-z0-9]{3,})band$/i);
  if (bandSuffix) {
    const stem = bandSuffix[1];
    return `${stem.charAt(0).toUpperCase()}${stem.slice(1)} Band`;
  }

  return separated.charAt(0).toUpperCase() + separated.slice(1);
}

function unwrapGroupMemberProfileInput(input) {
  if (typeof input !== 'string') return null;
  const match = input.match(/(?:https?:\/\/)?(?:(?:www|m|mbasic)\.)?facebook\.com\/groups\/[^\s/]+\/user\/(\d{6,})(?:[/?#][^\s]*)?/i);
  if (!match) return null;
  return `https://www.facebook.com/${match[1]}`;
}

function isGenericFacebookName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!name) return true;
  return name === 'error'
    || name === 'facebook error'
    || name === 'facebook'
    || name === 'login'
    || name === 'log in'
    || name === 'content not available'
    || name === 'this content isn\'t available'
    || name === 'this content is not available';
}

function isGenericFacebookDescription(value) {
  const description = String(value || '').trim().toLowerCase();
  if (!description) return false;
  return description === 'see posts, photos and more on facebook.'
    || description === 'see posts, photos and more on facebook'
    || description === 'log into facebook to start sharing and connecting with your friends, family, and people you know.'
    || description === 'log into facebook to start sharing and connecting with your friends, family, and people you know';
}

function cleanFacebookDescription(value, pageName) {
  const original = String(value || '').replace(/\s+/g, ' ').trim();
  const name = String(pageName || '').replace(/\s+/g, ' ').trim();
  if (!original || !name) return original || null;

  // Facebook's public OG description commonly starts with:
  //   "<page name>. <likes> likes · <people> talking about this. <real bio>"
  // Only strip when the exact observed page name AND an anchored engagement
  // block are present, so ordinary bios containing numbers remain untouched.
  const namePrefix = new RegExp(
    `^${escapeRegExp(name)}\\s*(?:[.·•|:\\-–—]+)\\s*`,
    'i',
  );
  const namedRemainder = original.match(namePrefix)
    ? original.replace(namePrefix, '')
    : null;
  if (namedRemainder === null) return original;

  const count = '[0-9][0-9,.]*\\s*[KMB]?';
  const primaryMetric = `${count}\\s+(?:likes?|followers?)`;
  const secondaryMetric = `${count}\\s+(?:talking about this|(?:people?\\s+)?talking about this|were here|followers?|following|likes?)`;
  const engagementPrefix = new RegExp(
    `^${primaryMetric}(?:\\s*[·•|]\\s*${secondaryMetric})*\\s*(?:[.]\\s*|$)`,
    'i',
  );

  if (!engagementPrefix.test(namedRemainder)) return original;
  return namedRemainder.replace(engagementPrefix, '').trim() || null;
}

function isFacebookCrawlerImageUrl(urlString) {
  if (!urlString) return false;
  try {
    const parsed = new URL(urlString);
    const host = parsed.hostname.toLowerCase();
    return (host === 'lookaside.fbsbx.com' || host.endsWith('.lookaside.fbsbx.com'))
      && parsed.pathname.startsWith('/lookaside/crawler/');
  } catch {
    return false;
  }
}

function sanitiseFacebookBoilerplate(result) {
  if (!result?.observed) return result;
  if (result.existing) return result;

  const observed = { ...result.observed };
  const evidence = { ...(result.evidence || {}) };

  if (isGenericFacebookName(observed.name)) {
    observed.name = null;
    delete evidence.name;
  }
  if (isGenericFacebookDescription(observed.description)) {
    observed.description = null;
    delete evidence.description;
  }

  return { ...result, observed, evidence };
}

function restoreStableInputIdentity(result, input) {
  if (!result?.valid || !isFacebookSystemIdentityKey(result.facebookKey)) return result;

  const inputIdentity = base.stableFacebookIdentity(input);
  if (!inputIdentity || isFacebookSystemIdentityKey(inputIdentity.key)) {
    return {
      ...result,
      facebookUrl: null,
      facebookKey: null,
      identityResolved: false,
    };
  }

  return {
    ...result,
    facebookUrl: inputIdentity.url,
    facebookKey: inputIdentity.key,
    identityResolved: true,
    observed: {
      ...(result.observed || {}),
      canonicalUrl: inputIdentity.url,
    },
    evidence: {
      ...(result.evidence || {}),
      canonicalUrl: 'facebook_input_identity_restored',
    },
    warnings: [...new Set([...(result.warnings || []), 'facebook_redirected_to_system_route'])],
  };
}

function readHtmlTitle(html) {
  const match = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = match ? base.cleanFacebookTitle(match[1]) : null;
  return isGenericFacebookName(title) ? null : title;
}

function decodeJsonString(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.parse(`"${value}"`).replace(/\s+/g, ' ').trim() || null;
  } catch {
    return String(value)
      .replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/\\n|\\r|\\t/g, ' ')
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"')
      .replace(/\s+/g, ' ')
      .trim() || null;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findJsonString(html, keys) {
  const text = String(html || '');
  for (const key of keys) {
    const pattern = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i');
    const match = text.match(pattern);
    if (match) {
      const decoded = decodeJsonString(match[1]);
      if (decoded) return decoded;
    }
  }
  return null;
}

function findNestedObjectName(html, keys) {
  const text = String(html || '');
  for (const key of keys) {
    const pattern = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*\\{[\\s\\S]{0,900}?"name"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i');
    const match = text.match(pattern);
    if (match) {
      const decoded = decodeJsonString(match[1]);
      if (decoded) return decoded;
    }
  }
  return null;
}

function safeExternalWebsite(urlString) {
  if (!urlString) return null;
  let value = String(urlString).trim();
  if (!/^https?:\/\//i.test(value) && /^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(value)) {
    value = `https://${value}`;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const host = parsed.hostname.toLowerCase();
    if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.me' || host.endsWith('.fb.me')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseJsonLd(html) {
  const text = String(html || '');
  const tags = text.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const tag of tags) {
    const open = tag.match(/^<script\b[^>]*>/i)?.[0] || '';
    if (!/application\/ld\+json/i.test(open)) continue;
    const raw = tag.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const address = item.address && typeof item.address === 'object' ? item.address : null;
        const website = safeExternalWebsite(item.url);
        const name = typeof item.name === 'string' && !isGenericFacebookName(item.name) ? item.name.trim() : null;
        const description = typeof item.description === 'string' && !isGenericFacebookDescription(item.description) ? item.description.trim() : null;
        const location = address && typeof address.addressLocality === 'string' ? address.addressLocality.trim() : null;
        const addressText = address
          ? [address.streetAddress, address.addressLocality, address.addressRegion, address.postalCode]
            .filter((part) => typeof part === 'string' && part.trim())
            .map((part) => part.trim())
            .join(', ') || null
          : null;
        if (name || description || location || addressText || website) {
          return { name, description, location, address: addressText, websiteUrl: website };
        }
      }
    } catch {
      // Facebook pages often include non-JSON scripts; ignore malformed JSON-LD.
    }
  }
  return null;
}

/**
 * Extract only fields with recognisable semantic keys from Facebook's embedded
 * page payload. We deliberately do not use a generic "name" or "description"
 * search because the document contains many unrelated Facebook objects.
 */
function parseEmbeddedFacebookDetails(html) {
  const jsonLd = parseJsonLd(html) || {};

  // Only profile_name is sufficiently entity-specific in Facebook's embedded
  // payload. Generic page_name/display_name keys also describe UI language and
  // navigation objects (for example "Afrikaans"), not the inspected artist.
  const name = jsonLd.name || findJsonString(html, [
    'profile_name',
  ]);

  const description = jsonLd.description || findJsonString(html, [
    'bio_text',
    'biography',
    'about_text',
    'page_description',
  ]);

  const location = jsonLd.location
    || findJsonString(html, ['hometown_name', 'current_city_name', 'city_name', 'location_name'])
    || findNestedObjectName(html, ['hometown', 'current_city', 'city']);

  const address = jsonLd.address || findJsonString(html, [
    'single_line_address',
    'full_address',
  ]);

  const websiteUrl = jsonLd.websiteUrl || safeExternalWebsite(findJsonString(html, [
    'website_url',
    'external_url',
    'website',
  ]));

  return {
    name: name && !isGenericFacebookName(name) ? name : null,
    description: description && !isGenericFacebookDescription(description) ? description.slice(0, 1000) : null,
    location: location ? location.slice(0, 200) : null,
    address: address ? address.slice(0, 500) : null,
    websiteUrl,
  };
}

function parseRichFacebookMetadata(html, finalUrl, evidenceLabel) {
  let parsed = sanitiseFacebookBoilerplate(base.parseFacebookMetadata(html, finalUrl));
  const observed = { ...(parsed.observed || {}) };
  const evidence = { ...(parsed.evidence || {}) };
  const embedded = parseEmbeddedFacebookDetails(html);

  if (!observed.name) {
    const title = readHtmlTitle(html);
    const name = embedded.name || title;
    if (name) {
      observed.name = name;
      evidence.name = embedded.name ? evidenceLabel : 'facebook_basic_html';
    }
  }
  if (!observed.description && embedded.description) {
    observed.description = embedded.description;
    evidence.description = evidenceLabel;
  }
  if (!observed.location && embedded.location) {
    observed.location = embedded.location;
    evidence.location = evidenceLabel;
  }
  if (!observed.address && embedded.address) {
    observed.address = embedded.address;
    evidence.address = evidenceLabel;
  }
  if (!observed.websiteUrl && embedded.websiteUrl) {
    observed.websiteUrl = embedded.websiteUrl;
    evidence.websiteUrl = evidenceLabel;
  }

  return { ...parsed, observed, evidence };
}

async function fetchBasicFacebookMetadata(handle, fetchHtml = base.fetchFacebookHtml) {
  const url = `https://mbasic.facebook.com/${encodeURIComponent(handle)}`;
  const fetched = await fetchHtml(url, {
    timeoutMs: FALLBACK_TIMEOUT_MS,
    maxBytes: FALLBACK_HTML_BYTES,
    redirectsLeft: 2,
  });

  if (fetched.statusCode < 200 || fetched.statusCode >= 300) return null;
  return parseRichFacebookMetadata(fetched.html, fetched.finalUrl || url, 'facebook_structured_html');
}

async function fetchBasicFacebookAbout(handle, fetchHtml = base.fetchFacebookHtml) {
  const url = `https://mbasic.facebook.com/${encodeURIComponent(handle)}/about`;
  const fetched = await fetchHtml(url, {
    timeoutMs: FALLBACK_TIMEOUT_MS,
    maxBytes: FALLBACK_HTML_BYTES,
    redirectsLeft: 2,
  });

  if (fetched.statusCode < 200 || fetched.statusCode >= 300) return null;
  return parseRichFacebookMetadata(fetched.html, fetched.finalUrl || url, 'facebook_about_html');
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
        'User-Agent': 'Mozilla/5.0 (compatible; bndy-source-inspector/1.3; +https://bndy.co.uk)',
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

function mergeMissingObserved(observed, evidence, fallback) {
  if (!fallback?.observed) return;
  const fields = ['name', 'imageUrl', 'description', 'location', 'address', 'websiteUrl'];
  for (const field of fields) {
    if (!observed[field] && fallback.observed[field]) {
      observed[field] = fallback.observed[field];
      if (fallback.evidence?.[field]) evidence[field] = fallback.evidence[field];
    }
  }
}

async function enrichInspectionResult(result, { expectedType = null, fetchHtml = base.fetchFacebookHtml, fetchPicture = fetchGraphProfilePicture } = {}) {
  if (!result?.valid || result.existing) return result;

  result = sanitiseFacebookBoilerplate(result);
  if (!result.identityResolved || !result.facebookKey) return result;

  const handle = handleFromFacebookKey(result.facebookKey);
  if (!handle || isFacebookSystemIdentityKey(result.facebookKey)) return result;

  const observed = { ...(result.observed || {}) };
  const evidence = { ...(result.evidence || {}) };

  // Keep fallbacks parallel so the Lambda's total latency is one fallback timeout,
  // not root + About + image timeouts added together.
  const needsMetadata = !observed.name || !observed.description || !observed.location || !observed.websiteUrl;
  const basicPromise = needsMetadata
    ? fetchBasicFacebookMetadata(handle, fetchHtml)
    : Promise.resolve(null);
  const aboutPromise = needsMetadata
    ? fetchBasicFacebookAbout(handle, fetchHtml)
    : Promise.resolve(null);
  const needsDirectPicture = !observed.imageUrl || isFacebookCrawlerImageUrl(observed.imageUrl);
  const picturePromise = expectedType === 'artist' && needsDirectPicture
    ? fetchPicture(handle)
    : Promise.resolve(null);

  const [basicResult, aboutResult, pictureResult] = await Promise.allSettled([
    basicPromise,
    aboutPromise,
    picturePromise,
  ]);

  if (basicResult.status === 'fulfilled') mergeMissingObserved(observed, evidence, basicResult.value);
  if (aboutResult.status === 'fulfilled') mergeMissingObserved(observed, evidence, aboutResult.value);

  if (needsDirectPicture && pictureResult.status === 'fulfilled' && pictureResult.value) {
    observed.imageUrl = pictureResult.value;
    evidence.imageUrl = 'facebook_graph_picture';
  }

  if (!observed.name) {
    const hint = nameHintFromHandle(handle);
    if (hint) {
      observed.name = hint;
      evidence.name = 'facebook_handle_hint';
    }
  }

  if (observed.description) {
    const cleanedDescription = cleanFacebookDescription(observed.description, observed.name);
    observed.description = cleanedDescription;
    if (!cleanedDescription) delete evidence.description;
  }

  return {
    ...result,
    observed,
    evidence,
  };
}

async function inspectFacebookSourceV2({ input, expectedType = null, client, fetchHtml, fetchPicture } = {}) {
  const wrappedProfile = expectedType === 'venue' ? null : unwrapGroupMemberProfileInput(input);
  const inspectionInput = wrappedProfile || input;

  let result = await base.inspectFacebookSource({ input: inspectionInput, expectedType, client, fetchHtml });
  result = restoreStableInputIdentity(result, inspectionInput);

  // A group-member wrapper is provenance, not identity. The embedded numeric id
  // remains canonical even if anonymous Facebook redirects the probe to /login.
  if (wrappedProfile) {
    const wrappedIdentity = base.stableFacebookIdentity(wrappedProfile);
    if (wrappedIdentity) {
      result = {
        ...result,
        facebookUrl: wrappedIdentity.url,
        facebookKey: wrappedIdentity.key,
        identityResolved: true,
        observed: {
          ...(result.observed || {}),
          canonicalUrl: wrappedIdentity.url,
        },
        evidence: {
          ...(result.evidence || {}),
          canonicalUrl: 'facebook_group_member_profile',
        },
      };
    }
  }

  const enriched = await enrichInspectionResult(result, { expectedType, fetchHtml, fetchPicture });
  if (!wrappedProfile) return enriched;

  return {
    ...enriched,
    input,
    sourceUrl: input,
    evidence: {
      ...(enriched.evidence || {}),
      canonicalUrl: 'facebook_group_member_profile',
    },
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
  isFacebookSystemIdentityKey,
  nameHintFromHandle,
  unwrapGroupMemberProfileInput,
  isGenericFacebookName,
  isGenericFacebookDescription,
  cleanFacebookDescription,
  isFacebookCrawlerImageUrl,
  sanitiseFacebookBoilerplate,
  restoreStableInputIdentity,
  readHtmlTitle,
  parseEmbeddedFacebookDetails,
  parseRichFacebookMetadata,
  fetchBasicFacebookMetadata,
  fetchBasicFacebookAbout,
  fetchGraphProfilePicture,
  enrichInspectionResult,
  inspectFacebookSourceV2,
};
