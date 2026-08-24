'use strict';

const AWS = require('aws-sdk');

const secrets = new AWS.SecretsManager();
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const EVIDENCE = 'backline_grounded_search';
const ARTIST_TYPES = ['Band', 'Solo Act', 'Duo', 'Trio', 'Group', 'DJ', 'Collective'];
const ACT_TYPES = ['Originals', 'Covers', 'Tribute Act'];
const GENRES = [
  'Rock', 'Rock n Roll', 'Grunge', 'Metal', 'Punk', 'Alternative', 'New Wave', 'Pop',
  'Indie', 'Britpop', 'Mod', 'Blues', 'R&B', 'Country', 'Americana', 'Folk', 'Soul',
  'Funk', 'Motown', 'Electronic', 'Dance', 'Jazz', 'Classical', 'Reggae', 'Latin', 'Other',
];

let cachedApiKey;

function shouldUseBacklineAssist(result, expectedType) {
  if (expectedType !== 'artist' || !result || !result.identityResolved || !result.facebookUrl) return false;
  if (result.existing || result.existingEntity) return false;
  const observed = result.observed || {};
  const evidence = result.evidence || {};
  return !observed.name || evidence.name === 'facebook_handle_hint' ||
    !observed.location || !observed.description || !observed.websiteUrl || !observed.artistType;
}

async function getApiKey() {
  if (cachedApiKey) return cachedApiKey;
  const arn = process.env.GEMINI_SECRET_ARN;
  if (!arn) throw new Error('GEMINI_SECRET_ARN is not configured');
  const value = await secrets.getSecretValue({ SecretId: arn }).promise();
  const raw = value.SecretString || Buffer.from(value.SecretBinary || '', 'base64').toString('utf8');
  const parsed = JSON.parse(raw);
  cachedApiKey = parsed.apiKey || parsed.GEMINI_API_KEY || parsed.key;
  if (!cachedApiKey) throw new Error('Gemini secret has no API key');
  return cachedApiKey;
}

function extractOutputText(raw) {
  if (typeof raw?.output_text === 'string') return raw.output_text;
  if (typeof raw?.outputText === 'string') return raw.outputText;
  const texts = [];
  for (const step of raw?.steps || []) {
    if (step?.type !== 'model_output') continue;
    for (const item of step?.content || []) {
      if (item?.type === 'text' && typeof item.text === 'string') texts.push(item.text);
    }
  }
  return texts.at(-1);
}

const responseSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    location: { type: 'string' },
    bio: { type: 'string' },
    websiteUrl: { type: 'string' },
    artistType: { type: 'string', enum: ARTIST_TYPES },
    actTypes: { type: 'array', items: { type: 'string', enum: ACT_TYPES } },
    genres: { type: 'array', items: { type: 'string', enum: GENRES } },
    acoustic: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    nameEvidenceUrls: { type: 'array', items: { type: 'string' } },
    locationEvidenceUrls: { type: 'array', items: { type: 'string' } },
    bioEvidenceUrls: { type: 'array', items: { type: 'string' } },
    websiteEvidenceUrls: { type: 'array', items: { type: 'string' } },
    classificationEvidenceUrls: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'name', 'location', 'bio', 'websiteUrl', 'artistType', 'actTypes', 'genres', 'acoustic',
    'confidence', 'nameEvidenceUrls', 'locationEvidenceUrls', 'bioEvidenceUrls',
    'websiteEvidenceUrls', 'classificationEvidenceUrls',
  ],
};

function promptFor(facebookUrl) {
  return `You are BNDY Backline, a careful music-data researcher. Enrich exactly this public Facebook artist page:

${facebookUrl}

Use Google Search grounding to find indexed Facebook About snippets and corroborating official artist, venue,
promoter, music platform, or press pages. The Facebook URL is the identity anchor. Never substitute a similarly
named act. Return the artist's properly spaced/styled name, UK home town or region, concise factual bio, official
non-Facebook website, and controlled classifications. Every non-empty field must have at least one supporting URL
in its matching evidence array. If a fact cannot be verified, return an empty string/array. Use at most three genres.
Set confidence below 0.75 if identity is not strongly corroborated. Do not infer location from a gig venue alone.`;
}

async function discoverFacebookArtist(facebookUrl, options = {}) {
  const apiKey = options.apiKey || await getApiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 14000);
  try {
    const res = await (options.fetch || fetch)(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        model: MODEL,
        input: promptFor(facebookUrl),
        tools: [{ type: 'google_search' }],
        response_format: { type: 'text', mime_type: 'application/json', schema: responseSchema },
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const text = extractOutputText(await res.json());
    if (!text) throw new Error('Gemini response contained no text');
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function hasEvidence(value, urls) {
  return !!(typeof value === 'string' ? value.trim() : value) && Array.isArray(urls) && urls.length > 0;
}

function mergeBacklineEnrichment(result, found) {
  const observed = { ...(result.observed || {}) };
  const evidence = { ...(result.evidence || {}) };
  const allUrls = [...new Set([
    ...(found.nameEvidenceUrls || []), ...(found.locationEvidenceUrls || []),
    ...(found.bioEvidenceUrls || []), ...(found.websiteEvidenceUrls || []),
    ...(found.classificationEvidenceUrls || []),
  ].filter((url) => /^https?:\/\//i.test(url)))];

  if (hasEvidence(found.name, found.nameEvidenceUrls) && evidence.name === 'facebook_handle_hint') {
    observed.name = found.name.trim();
    evidence.name = EVIDENCE;
  }
  if (!observed.location && hasEvidence(found.location, found.locationEvidenceUrls)) {
    observed.location = found.location.trim();
    evidence.location = EVIDENCE;
  }
  if (!observed.description && hasEvidence(found.bio, found.bioEvidenceUrls)) {
    observed.description = found.bio.trim();
    evidence.description = EVIDENCE;
  }
  if (!observed.websiteUrl && hasEvidence(found.websiteUrl, found.websiteEvidenceUrls)) {
    observed.websiteUrl = found.websiteUrl.trim();
    evidence.websiteUrl = EVIDENCE;
  }
  if (Array.isArray(found.classificationEvidenceUrls) && found.classificationEvidenceUrls.length) {
    if (ARTIST_TYPES.includes(found.artistType)) {
      observed.artistType = found.artistType;
      evidence.artistType = EVIDENCE;
    }
    observed.actTypes = (found.actTypes || []).filter((v) => ACT_TYPES.includes(v));
    observed.genres = (found.genres || []).filter((v) => GENRES.includes(v)).slice(0, 3);
    observed.acoustic = found.acoustic === true;
    evidence.actTypes = EVIDENCE;
    evidence.genres = EVIDENCE;
    evidence.acoustic = EVIDENCE;
  }

  return {
    ...result,
    observed,
    evidence,
    backlineAssist: {
      status: allUrls.length ? 'enriched' : 'no_evidence',
      confidence: Number(found.confidence) || 0,
      evidenceUrls: allUrls,
    },
  };
}

async function enrichSparseFacebookResult(result, options = {}) {
  if (!shouldUseBacklineAssist(result, options.expectedType)) return result;
  try {
    const found = await (options.discover || discoverFacebookArtist)(result.facebookUrl);
    return mergeBacklineEnrichment(result, found);
  } catch (error) {
    console.warn('[source-inspector-backline] assist failed:', error.name || error.message);
    return {
      ...result,
      warnings: [...new Set([...(result.warnings || []), 'backline_assist_failed'])],
      backlineAssist: { status: 'failed' },
    };
  }
}

module.exports = {
  ACT_TYPES,
  ARTIST_TYPES,
  GENRES,
  discoverFacebookArtist,
  enrichSparseFacebookResult,
  mergeBacklineEnrichment,
  shouldUseBacklineAssist,
};
