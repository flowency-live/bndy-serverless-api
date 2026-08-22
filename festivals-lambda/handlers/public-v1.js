/**
 * Public festival read contract for bndy-app V1.
 *
 * Production's bndy-events table predates the current SAM stack and has been
 * retained through migrations. Prefer the intended GSIs, but a missing index
 * must not turn every festival page into a 500. The fallback scans are bounded
 * to public festival reads and can be removed once table ownership is unified.
 */

const FESTIVALS_TABLE = process.env.FESTIVALS_TABLE || 'bndy-events';
const EVENTS_TABLE = process.env.EVENTS_TABLE || 'bndy-events';
const ARTISTS_TABLE = process.env.ARTISTS_TABLE || 'bndy-artists';
const VENUES_TABLE = process.env.VENUES_TABLE || 'bndy-venues';
const { isPublishedInEdition } = require('../lib/edition-domain');

function sanitizeFestival(festival) {
  if (!festival) return festival;
  const { PK, SK, ...rest } = festival;
  return rest;
}

function allVenueIds(festival) {
  return [...new Set([festival.primaryVenueId, ...(festival.venueIds || [])].filter(Boolean))];
}

function isMissingIndex(error) {
  const message = String(error?.message || '');
  return error?.code === 'ResourceNotFoundException'
    || error?.code === 'ValidationException'
    || /index|schema|key element/i.test(message);
}

async function scanAll(dynamodb, params) {
  const items = [];
  let lastEvaluatedKey;
  do {
    const result = await dynamodb.scan({
      ...params,
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {})
    }).promise();
    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return items;
}

/**
 * Public festival summaries used to scan the whole bndy-events table even
 * though festivals are a tiny subset of it. Production already has the bySlug
 * GSI used by detail reads; it is sparse because only slug-bearing rows are in
 * the index and it projects the festival records needed by those reads. Scan
 * that small index for listings, retaining the table scan only as a compatibility
 * fallback for environments where the legacy index has not been provisioned.
 */
async function scanFestivalSummaries(dynamodb, params) {
  try {
    return await scanAll(dynamodb, { ...params, IndexName: 'bySlug' });
  } catch (error) {
    if (!isMissingIndex(error)) throw error;
    console.warn('[FESTIVALS_PUBLIC] bySlug unavailable for listing; using compatibility table scan', { message: error.message });
    return scanAll(dynamodb, params);
  }
}

/**
 * Resolve only the tiny bit of venue data festival discovery needs. This keeps
 * /gigs and /festivals from downloading the complete public venue catalogue just
 * to calculate proximity. One batched read covers all venues referenced by the
 * returned festival window; hidden/non-live/invalid-coordinate venues are
 * deliberately omitted to match the public venue list contract.
 */
async function loadVenuePoints(dynamodb, festivals) {
  const ids = [...new Set(festivals.flatMap(allVenueIds))];
  if (!ids.length) return new Map();

  const venues = [];
  for (let i = 0; i < ids.length; i += 100) {
    const result = await dynamodb.batchGet({
      RequestItems: {
        [VENUES_TABLE]: {
          Keys: ids.slice(i, i + 100).map((id) => ({ id })),
          ProjectionExpression: 'id, city, latitude, longitude, hidden, publicationScopes'
        }
      }
    }).promise();
    venues.push(...(result.Responses?.[VENUES_TABLE] || []));
  }

  const points = new Map();
  for (const venue of venues) {
    if (venue.hidden === true || !isPublishedInEdition(venue, 'live')) continue;
    const lat = Number(venue.latitude);
    const lng = Number(venue.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat === 0 || lng === 0) continue;
    points.set(venue.id, {
      id: venue.id,
      city: venue.city || undefined,
      lat,
      lng
    });
  }
  return points;
}

async function findFestivalBySlug(dynamodb, slug) {
  try {
    const result = await dynamodb.query({
      TableName: FESTIVALS_TABLE,
      IndexName: 'bySlug',
      KeyConditionExpression: 'slug = :slug',
      ExpressionAttributeValues: { ':slug': slug }
    }).promise();
    return result.Items?.find((item) => item.entityType === 'festival') || null;
  } catch (error) {
    if (!isMissingIndex(error)) throw error;
    console.warn('[FESTIVALS_PUBLIC] bySlug unavailable; using compatibility scan', { message: error.message });
    const items = await scanAll(dynamodb, {
      TableName: FESTIVALS_TABLE,
      FilterExpression: 'entityType = :festival AND slug = :slug',
      ExpressionAttributeValues: { ':festival': 'festival', ':slug': slug }
    });
    return items[0] || null;
  }
}

async function findChildEvents(dynamodb, festivalId) {
  try {
    const result = await dynamodb.query({
      TableName: EVENTS_TABLE,
      IndexName: 'byFestival',
      KeyConditionExpression: 'festivalId = :festivalId',
      ExpressionAttributeValues: { ':festivalId': festivalId }
    }).promise();
    return result.Items || [];
  } catch (error) {
    if (!isMissingIndex(error)) throw error;
    console.warn('[FESTIVALS_PUBLIC] byFestival unavailable; using compatibility scan', { message: error.message });
    return scanAll(dynamodb, {
      TableName: EVENTS_TABLE,
      FilterExpression: 'festivalId = :festivalId',
      ExpressionAttributeValues: { ':festivalId': festivalId }
    });
  }
}

async function handleGetPublicFestivals(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const { startDate, endDate } = event.queryStringParameters || {};
  const filters = ['entityType = :festival', 'isPublic = :true'];
  const values = { ':festival': 'festival', ':true': true };

  if (startDate) {
    filters.push('endDate >= :startDate');
    values[':startDate'] = startDate;
  }
  if (endDate) {
    filters.push('startDate <= :endDate');
    values[':endDate'] = endDate;
  }

  const allItems = await scanFestivalSummaries(dynamodb, {
    TableName: FESTIVALS_TABLE,
    FilterExpression: filters.join(' AND '),
    ExpressionAttributeValues: values
  });

  const publicItems = allItems.filter(f => f.hidden !== true && isPublishedInEdition(f, 'live'));
  const venuePointsById = await loadVenuePoints(dynamodb, publicItems);
  const festivals = publicItems.map((f) => {
    const venueIds = allVenueIds(f);
    return {
      id: f.id,
      slug: f.slug,
      name: f.name,
      startDate: f.startDate,
      endDate: f.endDate || f.startDate,
      location: f.location || f.town,
      // Keep town during the transition for older consumers.
      town: f.town || f.location,
      venueIds,
      venuePoints: venueIds.map((id) => venuePointsById.get(id)).filter(Boolean),
      venueCount: venueIds.length,
      posterImageUrl: f.posterImageUrl,
      heroImageUrl: f.heroImageUrl,
      price: f.price,
      ticketed: f.ticketed,
      actCount: (f.lineup || []).length
    };
  }).sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));

  return {
    statusCode: 200,
    headers: { ...getCorsHeaders(event), 'Cache-Control': 'public, max-age=60' },
    body: JSON.stringify({ festivals })
  };
}

async function handleGetFestivalBySlug(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const { slug } = event.pathParameters || {};
  if (!slug) {
    return { statusCode: 400, headers: getCorsHeaders(event), body: JSON.stringify({ error: 'Slug is required' }) };
  }

  const festival = await findFestivalBySlug(dynamodb, slug);
  if (!festival || festival.isPublic !== true || festival.hidden === true || !isPublishedInEdition(festival, 'live')) {
    return { statusCode: 404, headers: getCorsHeaders(event), body: JSON.stringify({ error: 'Festival not found' }) };
  }

  const childEvents = (await findChildEvents(dynamodb, festival.id))
    .filter((item) => item.entityType !== 'festival' && item.isPublic === true && item.hidden !== true && isPublishedInEdition(item, 'live'))
    .sort((a, b) => `${a.date || ''}${a.startTime || ''}`.localeCompare(`${b.date || ''}${b.startTime || ''}`));

  const artistIds = new Set();
  (festival.lineup || []).forEach((slot) => { if (slot.artistId) artistIds.add(slot.artistId); });
  childEvents.forEach((e) => {
    if (e.artistId) artistIds.add(e.artistId);
    (e.collaboratingArtistIds || []).forEach((id) => artistIds.add(id));
  });

  let artistMap = {};
  if (artistIds.size) {
    // DynamoDB BatchGet has a 100-key cap. Festival schedules can exceed it,
    // so batch in safe chunks and merge the results.
    const ids = [...artistIds];
    const artists = [];
    for (let i = 0; i < ids.length; i += 100) {
      const result = await dynamodb.batchGet({
        RequestItems: { [ARTISTS_TABLE]: { Keys: ids.slice(i, i + 100).map((id) => ({ id })) } }
      }).promise();
      artists.push(...(result.Responses?.[ARTISTS_TABLE] || []));
    }
    artistMap = Object.fromEntries(artists.map((artist) => [artist.id, artist]));
  }

  const lineup = (festival.lineup || []).map((slot) => ({
    ...slot,
    artistName: slot.artistId ? artistMap[slot.artistId]?.name : undefined
  }));
  const venueIds = allVenueIds(festival);

  return {
    statusCode: 200,
    headers: { ...getCorsHeaders(event), 'Cache-Control': 'public, max-age=60' },
    body: JSON.stringify({
      festival: sanitizeFestival({
        ...festival,
        location: festival.location || festival.town,
        venueIds,
        venueCount: venueIds.length,
        lineup,
        gigCount: childEvents.length
      }),
      childEvents
    })
  };
}

module.exports = {
  handleGetPublicFestivals,
  handleGetFestivalBySlug,
  scanFestivalSummaries,
  loadVenuePoints,
  // exported to test index-fallback behaviour directly
  findFestivalBySlug,
  findChildEvents,
  isMissingIndex
};