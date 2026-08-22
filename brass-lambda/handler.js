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
  return { statusCode, headers: cors(event), body: JSON.stringify(body) };
}

function hasScope(item, scope) {
  return Array.isArray(item?.publicationScopes) && item.publicationScopes.includes(scope);
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
    locationLat: item.locationLat ?? null,
    locationLng: item.locationLng ?? null,
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
    createdAt: item.createdAt || null,
    updatedAt: item.updated_at || item.updatedAt || null
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
    publicationScopes: ['brass'],
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

async function getBands(event) {
  const items = await scanAll({
    TableName: ARTISTS_TABLE,
    ProjectionExpression: 'id,#name,artist_type,artistType,performerKind,publicationScopes,#names,name_variants,#location,locationLat,locationLng,locationType,profileImageUrl,bio,websiteUrl,facebookUrl,instagramUrl,socialMediaUrls,domainProfiles,claimStatus,owner_user_id,isVerified,#source,createdAt,updated_at,updatedAt,hidden,acts',
    ExpressionAttributeNames: {
      '#name': 'name',
      '#names': 'names',
      '#location': 'location',
      '#source': 'source'
    }
  });
  const bands = items
    .filter((item) => item.hidden !== true && item.performerKind === 'brass_band' && hasScope(item, 'brass'))
    .map(publicBand)
    .sort((a, b) => a.name.localeCompare(b.name, 'en-GB', { sensitivity: 'base' }));
  return response(event, 200, bands);
}

async function getConcerts(event) {
  const params = event.queryStringParameters || {};
  const today = new Date().toISOString().slice(0, 10);
  const startDate = params.startDate || today;
  const endDate = params.endDate || null;

  const items = await scanAll({ TableName: EVENTS_TABLE });
  let concerts = items.filter((item) => {
    if (item.entityType === 'festival') return false;
    if (item.isPublic !== true) return false;
    if (!hasScope(item, 'brass')) return false;
    if (!item.date || item.date < startDate) return false;
    if (endDate && item.date > endDate) return false;
    if (item.hidden === true) return false;
    return true;
  });

  const venueIds = [...new Set(concerts.map((item) => item.venueId).filter(Boolean))];
  const artistIds = [...new Set(concerts.flatMap((item) => [item.artistId, item.artist_id]).filter(Boolean))];

  const [venues, artists] = await Promise.all([
    venueIds.length ? scanAll({ TableName: VENUES_TABLE }) : Promise.resolve([]),
    artistIds.length ? scanAll({ TableName: ARTISTS_TABLE }) : Promise.resolve([])
  ]);
  const venueById = new Map(venues.filter((v) => venueIds.includes(v.id)).map((v) => [v.id, v]));
  const artistById = new Map(artists.filter((a) => artistIds.includes(a.id)).map((a) => [a.id, a]));

  concerts = concerts.map((item) => {
    const artistId = item.artistId || item.artist_id || null;
    const artist = artistId ? artistById.get(artistId) : null;
    const venue = item.venueId ? venueById.get(item.venueId) : null;
    const productionId = item.productionId || item.actId || item.act_id || null;
    const act = productionId && Array.isArray(artist?.acts) ? artist.acts.find((candidate) => candidate.id === productionId) : null;
    return {
      id: item.id,
      title: item.title || item.name || artist?.name || 'Concert',
      artistId,
      artistName: item.artistName || artist?.name || null,
      venueId: item.venueId,
      venueName: item.venueName || venue?.name || '',
      venueCity: item.venueCity || venue?.city || '',
      date: item.date,
      startTime: item.startTime || null,
      endTime: item.endTime || null,
      geoLat: item.geoLat ?? venue?.location?.lat ?? venue?.latitude ?? null,
      geoLng: item.geoLng ?? venue?.location?.lng ?? venue?.longitude ?? null,
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
    .filter((item) => item.entityType === 'festival' && item.isPublic === true && item.hidden !== true && hasScope(item, 'brass'))
    .map(publicFestival)
    .sort((a, b) => String(a.startDate || '').localeCompare(String(b.startDate || '')));
  return response(event, 200, festivals);
}

async function getProductions(event) {
  const bandId = event.queryStringParameters?.bandId;
  const artists = await scanAll({
    TableName: ARTISTS_TABLE,
    ProjectionExpression: 'id,performerKind,publicationScopes,hidden,acts'
  });
  const productions = artists
    .filter((artist) => artist.hidden !== true && artist.performerKind === 'brass_band' && hasScope(artist, 'brass') && (!bandId || artist.id === bandId))
    .flatMap((artist) => (Array.isArray(artist.acts) ? artist.acts : [])
      .filter((act) => act && act.id && act.name && act.status !== 'inactive')
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
