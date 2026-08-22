'use strict';

const AWS = require('aws-sdk');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || 'eu-west-2' });
const ARTISTS_TABLE = process.env.ARTISTS_TABLE || 'bndy-artists';
const EVENTS_TABLE = process.env.EVENTS_TABLE || 'bndy-events';
const VENUES_TABLE = process.env.VENUES_TABLE || 'bndy-venues';

const ALLOWED_ORIGINS = new Set([
  'https://brass.bndy.live',
  'http://localhost:3000',
  'http://localhost:3001'
]);

function cors(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin;
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://brass.bndy.live',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=60'
  };
}

function response(event, statusCode, body) {
  return { statusCode, headers: cors(event), body: statusCode === 204 ? '' : JSON.stringify(body) };
}

function hasBrassScope(item) {
  return Array.isArray(item?.publicationScopes) && item.publicationScopes.includes('brass');
}

function numberValue(...values) {
  for (const value of values) if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

async function scanAll(params) {
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

function publicBand(item) {
  return {
    id: item.id,
    name: item.name,
    artistType: item.artist_type || item.artistType || 'band',
    performerKind: item.performerKind,
    publicationScopes: item.publicationScopes,
    names: item.names || [],
    nameVariants: item.name_variants || [],
    location: item.location || '',
    locationLat: numberValue(item.locationLat, item.location?.lat),
    locationLng: numberValue(item.locationLng, item.location?.lng),
    locationType: item.locationType || null,
    profileImageUrl: item.profileImageUrl || '',
    bio: item.bio || '',
    websiteUrl: item.websiteUrl || '',
    facebookUrl: item.facebookUrl || '',
    instagramUrl: item.instagramUrl || '',
    socialMediaUrls: item.socialMediaUrls || [],
    domainProfiles: item.domainProfiles || null,
    claimStatus: item.claimStatus || (item.owner_user_id ? 'claimed' : 'unclaimed'),
    isVerified: item.isVerified === true,
    source: item.source || null,
    createdAt: item.createdAt || item.created_at || null,
    updatedAt: item.updatedAt || item.updated_at || null
  };
}

function slugify(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function publicProduction(act, performerId) {
  return {
    id: act.id,
    performerId,
    name: act.name,
    slug: act.slug || slugify(act.name),
    productionKind: act.productionKind || act.kind || 'other',
    description: act.description || '',
    imageUrl: act.imageUrl || null,
    websiteUrl: act.websiteUrl || null,
    status: act.status || 'active',
    publicationScopes: Array.isArray(act.publicationScopes) ? act.publicationScopes : ['brass'],
    isDefault: act.isDefault === true,
    provenance: act.provenance || null
  };
}

function publicFestival(item) {
  return {
    id: item.id,
    slug: item.slug,
    name: item.name,
    description: item.description || '',
    startDate: item.startDate,
    endDate: item.endDate || item.startDate,
    location: item.location || item.town || '',
    primaryVenueId: item.primaryVenueId || null,
    venueIds: item.venueIds || [],
    posterImageUrl: item.posterImageUrl || null,
    heroImageUrl: item.heroImageUrl || null,
    ticketed: item.ticketed === true,
    price: item.price || null,
    ticketUrl: item.ticketUrl || null,
    websiteUrl: item.websiteUrl || null,
    publicationScopes: item.publicationScopes
  };
}

function venueCoordinates(venue, event) {
  return {
    lat: numberValue(
      event?.geoLat,
      event?.location?.lat,
      venue?.locationLat,
      venue?.location?.lat,
      venue?.latitude,
      venue?.lat
    ),
    lng: numberValue(
      event?.geoLng,
      event?.location?.lng,
      venue?.locationLng,
      venue?.location?.lng,
      venue?.longitude,
      venue?.lng
    )
  };
}

async function getBands(event) {
  const items = await scanAll({ TableName: ARTISTS_TABLE });
  const bands = items
    .filter((item) => item.hidden !== true && item.performerKind === 'brass_band' && hasBrassScope(item))
    .map(publicBand)
    .sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base' }));
  return response(event, 200, bands);
}

async function getConcerts(event) {
  const params = event.queryStringParameters || {};
  const today = new Date().toISOString().slice(0, 10);
  const startDate = params.startDate || today;
  const endDate = params.endDate || null;

  const allEvents = await scanAll({ TableName: EVENTS_TABLE });
  const sourceConcerts = allEvents.filter((item) => {
    if (item.entityType === 'festival') return false;
    if (item.isPublic !== true || item.hidden === true) return false;
    if (!hasBrassScope(item)) return false;
    if (!item.date || item.date < startDate) return false;
    if (endDate && item.date > endDate) return false;
    return true;
  });

  const venueIds = [...new Set(sourceConcerts.map((item) => item.venueId).filter(Boolean))];
  const artistIds = [...new Set(sourceConcerts.flatMap((item) => [
    item.artistId,
    item.artist_id,
    ...(Array.isArray(item.artistIds) ? item.artistIds : [])
  ]).filter(Boolean))];

  const [venues, artists] = await Promise.all([
    venueIds.length ? scanAll({ TableName: VENUES_TABLE }) : Promise.resolve([]),
    artistIds.length ? scanAll({ TableName: ARTISTS_TABLE }) : Promise.resolve([])
  ]);
  const venueById = new Map(venues.filter((venue) => venueIds.includes(venue.id)).map((venue) => [venue.id, venue]));
  const artistById = new Map(artists.filter((artist) => artistIds.includes(artist.id)).map((artist) => [artist.id, artist]));

  const concerts = sourceConcerts.map((item) => {
    const artistId = item.artistId || item.artist_id || (Array.isArray(item.artistIds) ? item.artistIds[0] : null) || null;
    const artist = artistId ? artistById.get(artistId) : null;
    const venue = item.venueId ? venueById.get(item.venueId) : null;
    const productionId = item.productionId || item.actId || item.act_id || null;
    const act = productionId && Array.isArray(artist?.acts) ? artist.acts.find((candidate) => candidate.id === productionId) : null;
    const coordinates = venueCoordinates(venue, item);

    return {
      id: item.id,
      title: item.title || item.name || artist?.name || 'Concert',
      eventKind: item.eventKind || 'concert',
      artistId,
      artistName: item.artistName || artist?.name || null,
      venueId: item.venueId,
      venueName: item.venueName || venue?.name || '',
      venueCity: item.venueCity || venue?.city || venue?.town || '',
      date: item.date,
      startTime: item.startTime || null,
      endTime: item.endTime || null,
      geoLat: coordinates.lat,
      geoLng: coordinates.lng,
      ticketed: item.ticketed === true,
      ticketUrl: item.ticketUrl || null,
      ticketing: item.ticketing || null,
      cancelled: item.cancelled === true,
      festivalId: item.festivalId || null,
      festivalName: item.festivalName || null,
      productionId,
      productionName: item.productionName || item.actName || act?.name || null,
      conductorName: item.conductorName || null,
      publicationScopes: item.publicationScopes,
      source: item.source || null,
      provenance: item.provenance || null
    };
  }).filter((item) => typeof item.geoLat === 'number' && typeof item.geoLng === 'number');

  concerts.sort((a, b) => `${a.date}${a.startTime || ''}`.localeCompare(`${b.date}${b.startTime || ''}`));
  return response(event, 200, concerts);
}

async function getFestivals(event) {
  const items = await scanAll({ TableName: EVENTS_TABLE });
  const festivals = items
    .filter((item) => item.entityType === 'festival' && item.isPublic === true && item.hidden !== true && hasBrassScope(item))
    .map(publicFestival)
    .sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')));
  return response(event, 200, festivals);
}

async function getProductions(event) {
  const bandId = event.queryStringParameters?.bandId;
  const artists = await scanAll({ TableName: ARTISTS_TABLE });
  const productions = artists
    .filter((artist) => artist.hidden !== true && artist.performerKind === 'brass_band' && hasBrassScope(artist) && (!bandId || artist.id === bandId))
    .flatMap((artist) => (Array.isArray(artist.acts) ? artist.acts : [])
      .filter((act) => act && act.id && act.name && act.status !== 'inactive' && (!Array.isArray(act.publicationScopes) || act.publicationScopes.includes('brass')))
      .map((act) => publicProduction(act, artist.id)))
    .sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base' }));
  return response(event, 200, productions);
}

exports.handler = async (event) => {
  if (event.requestContext?.http?.method === 'OPTIONS') return response(event, 204, {});
  const path = event.rawPath || event.path || '';
  const method = event.requestContext?.http?.method || event.httpMethod || 'GET';

  try {
    if (method === 'GET' && path === '/health') return response(event, 200, { ok: true, service: 'bndy-brass-api' });
    if (method === 'GET' && path === '/bands') return getBands(event);
    if (method === 'GET' && path === '/concerts') return getConcerts(event);
    if (method === 'GET' && path === '/festivals') return getFestivals(event);
    if (method === 'GET' && path === '/productions') return getProductions(event);
    return response(event, 404, { error: 'not_found' });
  } catch (error) {
    console.error('[BRASS_API]', error);
    return response(event, 500, { error: 'internal_error' });
  }
};

exports.__test = { hasBrassScope, numberValue, publicBand, publicProduction, publicFestival, venueCoordinates };
