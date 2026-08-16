'use strict';

/**
 * Events Agent domain boundary.
 *
 * The historical ingest implementation lives unchanged in handler-legacy.js.
 * This wrapper removes its artist/venue admission bypasses while preserving the
 * extraction, queue UI and event publishing flow:
 *
 * - new venues are admitted through Venues Lambda find-or-create;
 * - every named artist is resolved/created through Artists Lambda;
 * - missing artist location is inferred from the gig venue as a BROAD UK REGION;
 * - bulk import pre-resolves artists then delegates the existing venue/event phases;
 * - open mics are artist-less events and never manufacture an "Open Mic" artist.
 */

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const legacy = require('./handler-legacy');
const {
  inferVenueRegion,
  inferBulkArtistRegion,
  resolveArtistViaApi
} = require('./lib/artist-domain');

const client = new DynamoDBClient({ region: 'eu-west-2' });
const dynamodb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true }
});

const QUEUE_TABLE = 'bndy-ingest-queue';
const API_BASE = process.env.BNDY_API_BASE || 'https://api.bndy.co.uk';
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

function methodOf(event) {
  return event.requestContext?.http?.method || event.httpMethod || '';
}

function pathOf(event) {
  return event.requestContext?.http?.path || event.rawPath || event.path || '';
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [key, value] = cookie.trim().split('=');
    if (key && value) cookies[key] = value;
    return cookies;
  }, {});
}

function requireAuth(event) {
  try {
    let cookieHeader = event.headers?.Cookie || event.headers?.cookie;
    if (!cookieHeader && Array.isArray(event.cookies)) cookieHeader = event.cookies.join('; ');
    const token = parseCookies(cookieHeader).bndy_session;
    if (!token) return { error: 'No session token', statusCode: 401 };
    if (!JWT_SECRET) return { error: 'JWT secret unavailable', statusCode: 500 };
    return { user: jwt.verify(token, JWT_SECRET) };
  } catch {
    return { error: 'Invalid session', statusCode: 401 };
  }
}

function parseBody(event) {
  try {
    return { body: event.body ? JSON.parse(event.body) : null };
  } catch {
    return { error: response(400, { error: 'Invalid JSON in request body' }) };
  }
}

async function getQueueItem(queueId) {
  const result = await dynamodb.send(new GetCommand({
    TableName: QUEUE_TABLE,
    Key: { queue_id: queueId }
  }));
  return result.Item || null;
}

async function updateQueueResolution(queueId, venueResolution, artistResolution) {
  const names = { '#venueResolution': 'venueResolution' };
  const values = { ':venueResolution': venueResolution };
  let expression = 'SET #venueResolution = :venueResolution';
  if (artistResolution) {
    names['#artistResolution'] = 'artistResolution';
    values[':artistResolution'] = artistResolution;
    expression += ', #artistResolution = :artistResolution';
  }
  await dynamodb.send(new UpdateCommand({
    TableName: QUEUE_TABLE,
    Key: { queue_id: queueId },
    UpdateExpression: expression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values
  }));
}

async function resolveVenueViaApi(queueItem) {
  const current = queueItem.venueResolution || {};
  if (current.venue_id && current.action === 'MATCH_EXISTING') {
    return { venueId: current.venue_id, created: false, resolution: current };
  }

  const payload = {
    name: queueItem.venueName,
    googlePlaceId: current.enrichments?.googlePlaceId,
    address: current.enrichments?.address,
    city: current.matched_venue?.city,
    latitude: current.location?.lat ?? current.enrichments?.latitude,
    longitude: current.location?.lng ?? current.enrichments?.longitude,
    source: 'agentic_ingest'
  };

  const result = await axios.post(`${API_BASE}/api/community/venues/find-or-create`, payload, {
    validateStatus: () => true,
    timeout: 12000
  });
  const body = result.data && typeof result.data === 'object' ? result.data : {};
  const venue = body.venue && typeof body.venue === 'object' ? body.venue : {};
  const venueId = venue.id || body.venueId || body.existingVenueId || body.existingId;

  if ((result.status === 200 || result.status === 201 || result.status === 409) && venueId) {
    return {
      venueId,
      created: result.status === 201,
      resolution: {
        ...current,
        action: 'MATCH_EXISTING',
        venue_id: venueId,
        confidence: 1,
        reasons: [...new Set([...(current.reasons || []), 'venue_domain_find_or_create'])],
        matched_venue: {
          ...(current.matched_venue || {}),
          id: venueId,
          name: venue.name || queueItem.venueName,
          city: venue.city || current.matched_venue?.city,
          address: venue.address || current.enrichments?.address
        }
      }
    };
  }

  return {
    error: body.error || body.message || `Venue domain returned ${result.status}`,
    status: result.status,
    raw: body
  };
}

async function approveOpenMic(queueItem, queueId, userId, venueResult) {
  const eventResult = await axios.post(`${API_BASE}/api/community/events`, {
    venueId: venueResult.venueId,
    date: queueItem.date,
    startTime: queueItem.time || '20:00',
    endTime: '23:00',
    title: `Open Mic @ ${queueItem.venueName}`,
    isOpenMic: true,
    isPublic: true,
    source: 'agentic_ingest',
    description: queueItem.notes || undefined
  }, {
    validateStatus: () => true,
    timeout: 12000
  });

  const body = eventResult.data && typeof eventResult.data === 'object' ? eventResult.data : {};
  const eventId = body.eventId || body.id || body.event?.id || body.existingEventId || body.existingId;
  if (![200, 201, 409].includes(eventResult.status)) {
    return response(eventResult.status >= 400 && eventResult.status < 500 ? eventResult.status : 502, {
      error: body.error || body.message || `Events domain returned ${eventResult.status}`,
      code: 'OPEN_MIC_EVENT_CREATE_FAILED'
    });
  }

  await dynamodb.send(new UpdateCommand({
    TableName: QUEUE_TABLE,
    Key: { queue_id: queueId },
    UpdateExpression: 'SET #status = :approved, approvedAt = :now, approvedBy = :userId, eventId = :eventId, venueResolution = :venueResolution',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':approved': 'approved',
      ':now': new Date().toISOString(),
      ':userId': userId,
      ':eventId': eventId || 'duplicate',
      ':venueResolution': venueResult.resolution
    }
  }));

  return response(200, {
    success: true,
    openMic: true,
    duplicate: eventResult.status === 409,
    eventId,
    venueId: venueResult.venueId,
    artistId: null,
    venueCreated: venueResult.created,
    artistCreated: false
  });
}

async function handleApprove(event, context) {
  const auth = requireAuth(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error });

  const queueId = event.pathParameters?.id || pathOf(event).split('/').slice(-2, -1)[0];
  if (!queueId) return response(400, { error: 'Missing queue ID' });

  const queueItem = await getQueueItem(queueId);
  if (!queueItem) return response(404, { error: 'Queue item not found' });
  if (queueItem.status !== 'pending') return response(400, { error: 'Queue item already processed' });

  // Theme events (TBC/Karaoke/Quiz) retain the existing rejection path.
  if (queueItem.artistResolution?.action === 'SKIP') {
    return legacy.handler(event, context || {});
  }

  const venueResult = await resolveVenueViaApi(queueItem);
  if (venueResult.error) {
    return response(409, {
      error: venueResult.error,
      code: 'VENUE_ADMISSION_FAILED',
      queueId
    });
  }

  // Open mic is an event property, not an Artist record. This deliberately
  // removes the old synthetic artist_type='event' write.
  if (queueItem.artistResolution?.action === 'OPEN_MIC') {
    return approveOpenMic(queueItem, queueId, auth.user.userId, venueResult);
  }

  const region = await inferVenueRegion({
    venueResolution: venueResult.resolution,
    venueName: queueItem.venueName,
    explicitArtistLocation: queueItem.artistResolution?.artist_data?.location,
    axios,
    googlePlacesApiKey: GOOGLE_PLACES_API_KEY
  });

  if (!region) {
    return response(409, {
      error: `Could not infer a canonical UK region from ${queueItem.venueName}`,
      code: 'VENUE_REGION_UNRESOLVED',
      queueId
    });
  }

  const artist = await resolveArtistViaApi({
    name: queueItem.artistName,
    region,
    artistData: {
      ...(queueItem.artistResolution?.artist_data || {}),
      artistType: queueItem.artistResolution?.artist_data?.artistType || 'band'
    },
    source: 'agentic_ingest',
    dryRun: false,
    axios,
    apiBase: API_BASE
  });

  if (artist.kind === 'review') {
    return response(409, {
      error: artist.reason,
      code: artist.code || 'ARTIST_REVIEW_REQUIRED',
      inferredRegion: region,
      candidates: artist.candidates,
      warnings: artist.warnings,
      queueId
    });
  }
  if (!artist.artistId || !['matched', 'created'].includes(artist.kind)) {
    return response(502, {
      error: artist.reason || 'Artist domain resolution failed',
      code: artist.code || 'ARTIST_ADMISSION_FAILED',
      inferredRegion: region,
      warnings: artist.warnings,
      queueId
    });
  }

  const artistResolution = {
    ...(queueItem.artistResolution || {}),
    action: 'MATCH_EXISTING',
    artist_id: artist.artistId,
    confidence: 1,
    reasons: [...new Set([...(queueItem.artistResolution?.reasons || []), 'artist_domain_find_or_create', 'venue_region_inferred'])],
    inferred_region: region,
    matched_artist: {
      id: artist.artistId,
      name: artist.artistName || queueItem.artistName,
      location: region
    }
  };

  await updateQueueResolution(queueId, venueResult.resolution, artistResolution);
  return legacy.handler(event, context || {});
}

async function handleBulkImport(event, context) {
  const auth = requireAuth(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error });

  const parsed = parseBody(event);
  if (parsed.error) return parsed.error;
  if (!parsed.body) return response(400, { error: 'Request body required' });

  const body = parsed.body;
  const artists = body.artists || {};
  const venues = body.venues || {};
  const events = body.events || {};
  const options = body.options || {};
  const locationContext = options.locationContext || 'Greater Manchester, UK';
  const dryRun = options.dryRun === true;
  const artistIdMap = { ...(options.artistIdMap || {}) };
  const artistResults = { created: [], matched: [], failed: [] };

  for (const [localId, artistData] of Object.entries(artists)) {
    if (artistIdMap[localId]) {
      artistResults.matched.push({
        localId,
        bndyId: artistIdMap[localId],
        name: artistData.name,
        precomputed: true
      });
      continue;
    }

    const region = await inferBulkArtistRegion({
      localArtistId: localId,
      artistData,
      venues,
      events,
      locationContext,
      axios,
      googlePlacesApiKey: GOOGLE_PLACES_API_KEY
    });

    if (!region) {
      artistResults.failed.push({
        localId,
        name: artistData.name,
        reason: 'Could not infer UK region from artist or linked gig venue'
      });
      continue;
    }

    const resolution = await resolveArtistViaApi({
      name: artistData.name,
      region,
      artistData,
      source: 'bulk_import',
      dryRun,
      axios,
      apiBase: API_BASE
    });

    if (resolution.kind === 'matched' && resolution.artistId) {
      artistIdMap[localId] = resolution.artistId;
      artistResults.matched.push({
        localId,
        bndyId: resolution.artistId,
        name: artistData.name,
        matchedName: resolution.artistName,
        region,
        warnings: resolution.warnings
      });
    } else if (dryRun && resolution.kind === 'clear') {
      artistIdMap[localId] = `DRY_RUN_${localId}`;
      artistResults.created.push({
        localId,
        name: artistData.name,
        region,
        dryRun: true,
        warnings: resolution.warnings
      });
    } else if (resolution.kind === 'created' && resolution.artistId) {
      artistIdMap[localId] = resolution.artistId;
      artistResults.created.push({
        localId,
        bndyId: resolution.artistId,
        name: artistData.name,
        region,
        warnings: resolution.warnings
      });
    } else {
      artistResults.failed.push({
        localId,
        name: artistData.name,
        region,
        reason: resolution.reason || 'Artist resolution failed',
        code: resolution.code,
        candidates: resolution.candidates,
        warnings: resolution.warnings
      });
    }
  }

  // The legacy bulk importer can now safely do its existing venue and event
  // phases. Emptying artists is what prevents any direct bndy-artists PutItem;
  // the precomputed map supplies the canonical IDs instead.
  const delegatedBody = {
    ...body,
    artists: {},
    options: {
      ...options,
      artistIdMap
    }
  };
  const delegated = await legacy.handler({ ...event, body: JSON.stringify(delegatedBody) }, context || {});
  if (!delegated || delegated.statusCode !== 200) return delegated;

  let output;
  try { output = JSON.parse(delegated.body || '{}'); }
  catch { return delegated; }

  output.artistIdMap = artistIdMap;
  output.results = output.results || {};
  output.results.artists = artistResults;
  output.summary = output.summary || {};
  output.summary.artists = {
    total: Object.keys(artists).length,
    created: artistResults.created.length,
    matched: artistResults.matched.length,
    failed: artistResults.failed.length
  };

  return { ...delegated, body: JSON.stringify(output) };
}

exports.handler = async (event, context) => {
  const method = methodOf(event);
  const path = pathOf(event);

  if (method === 'POST' && /^\/api\/ingest\/queue\/[^/]+\/approve$/.test(path)) {
    return handleApprove(event, context);
  }

  if (method === 'POST' && path === '/api/ingest/bulk-import') {
    return handleBulkImport(event, context);
  }

  return legacy.handler(event, context || {});
};
