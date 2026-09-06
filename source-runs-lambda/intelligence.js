// BNDY Godmode Intelligence
//
// GET /api/source-runs/intelligence (platform admin only)
//
// One payload for the Godmode Control Room: network totals, growth, daily
// intake by source, gigs by date, geography and data health. Everything is
// derived from the canonical tables (bndy-artists, bndy-venues, bndy-events,
// bndy-users) using createdAt, created_source and external_ids. It replaces
// the browser-side computation that fetched every table into the client and
// the S3 run-file readers that stopped receiving writes on 27/07/2026.
//
// The four scans run once per cold container every ten minutes. The result is
// cached in memory for that window.

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');

const REGION = 'eu-west-2';
const USERS_TABLE = 'bndy-users';
const CACHE_TTL_MS = 10 * 60 * 1000;
const INTAKE_DAYS = 90;
const GIGS_BACK_DAYS = 30;
const GIGS_AHEAD_DAYS = 90;
const GEOGRAPHY_LIMIT = 40;

const TABLES = {
  artists: {
    name: 'bndy-artists',
    projection: 'id, createdAt, created_at, created_source, #src, external_ids, #loc, genres, artistType, facebookUrl, instagramUrl, websiteUrl, youtubeUrl, spotifyUrl, socialMediaUrls, needs_review, enrichment_status, #hidden, publicationScopes',
    names: { '#src': 'source', '#loc': 'location', '#hidden': 'hidden' },
  },
  venues: {
    name: 'bndy-venues',
    projection: 'id, createdAt, created_at, created_source, external_ids, city, town, postcode, latitude, longitude, location_object, google_place_id, website, social_media_urls, validated, enrichment_status, #hidden, publicationScopes',
    names: { '#hidden': 'hidden' },
  },
  events: {
    name: 'bndy-events',
    projection: 'id, createdAt, created_at, created_source, external_ids, #date, venueId, artistId, collaboratingArtistIds, isPublic, #type, #hidden, publicationScopes',
    names: { '#date': 'date', '#type': 'type', '#hidden': 'hidden' },
  },
  users: {
    name: 'bndy-users',
    projection: 'cognito_id, createdAt, created_at',
  },
};

let dynamodb;
let ssm;
let jwtSecret;

function docClient() {
  if (!dynamodb) dynamodb = new AWS.DynamoDB.DocumentClient({ region: REGION });
  return dynamodb;
}

async function getJwtSecret() {
  if (jwtSecret) return jwtSecret;
  if (!ssm) ssm = new AWS.SSM({ region: REGION });
  const result = await ssm.getParameter({ Name: '/bndy/auth/jwt-secret', WithDecryption: true }).promise();
  jwtSecret = result.Parameter.Value;
  return jwtSecret;
}

const parseCookies = (header = '') => header.split(';').reduce((out, pair) => {
  const index = pair.indexOf('=');
  if (index < 0) return out;
  out[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  return out;
}, {});

async function defaultRequirePlatformAdmin(event) {
  const arrayCookie = Array.isArray(event.cookies)
    ? event.cookies.find((value) => value.startsWith('bndy_session='))?.slice('bndy_session='.length)
    : undefined;
  const headerCookies = parseCookies(event.headers?.Cookie || event.headers?.cookie || '');
  const token = arrayCookie || headerCookies.bndy_session;
  if (!token) return { error: 'Not authenticated', status: 401 };
  try {
    const session = jwt.verify(token, await getJwtSecret(), { algorithms: ['HS256'] });
    const user = await docClient().get({ TableName: USERS_TABLE, Key: { cognito_id: session.userId } }).promise();
    if (!user.Item?.platformAdmin) return { error: 'Admin access required', status: 403 };
    return { userId: session.userId };
  } catch (error) {
    console.error('[INTELLIGENCE] auth error', error.message);
    return { error: 'Invalid session', status: 401 };
  }
}

async function defaultScanTable(tableName) {
  const spec = Object.values(TABLES).find((table) => table.name === tableName);
  const items = [];
  let lastEvaluatedKey;
  do {
    const params = {
      TableName: tableName,
      ProjectionExpression: spec.projection,
      ...(spec.names && { ExpressionAttributeNames: spec.names }),
      ...(lastEvaluatedKey && { ExclusiveStartKey: lastEvaluatedKey }),
    };
    const result = await docClient().scan(params).promise();
    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return items;
}

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// Pure derivation
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function ukDateString(date) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function utcDate(value) {
  return new Date(`${value}T12:00:00Z`);
}

function addDays(value, amount) {
  const date = utcDate(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function monthStart(value) {
  return `${value.slice(0, 7)}-01`;
}

function dateOnly(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  if (match) return match[0];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function createdOn(record) {
  return dateOnly(record.createdAt ?? record.created_at);
}

function liveRecord(record) {
  if (record.hidden === true) return false;
  const scopes = record.publicationScopes;
  return !Array.isArray(scopes) || scopes.length === 0 || scopes.includes('live');
}

function isGig(record) {
  if (!liveRecord(record) || record.isPublic === false) return false;
  return record.isPublic === true || record.type === 'gig' || record.type === 'public_gig';
}

function sourceOf(record) {
  const ids = Array.isArray(record.external_ids) ? record.external_ids : [];
  for (const entry of ids) {
    if (entry && typeof entry === 'object' && typeof entry.source === 'string' && entry.source) return entry.source;
    if (typeof entry === 'string') {
      const index = entry.indexOf(':');
      if (index > 0) return entry.slice(0, index);
    }
  }
  if (typeof record.created_source === 'string' && record.created_source) return record.created_source;
  if (typeof record.source === 'string' && record.source) return record.source;
  return 'unknown';
}

function eventArtistIds(event) {
  const ids = [event.artistId, ...(Array.isArray(event.collaboratingArtistIds) ? event.collaboratingArtistIds : [])];
  return [...new Set(ids.filter((id) => typeof id === 'string' && id))];
}

function venueArea(venue) {
  const named = venue.city ?? venue.town;
  if (typeof named === 'string' && named.trim()) return named.trim();
  const postcode = typeof venue.postcode === 'string' ? venue.postcode.trim().toUpperCase() : '';
  const match = postcode.match(/^[A-Z]{1,2}/);
  return match ? match[0] : 'Unknown';
}

function venueCoordinates(venue) {
  const lat = Number(venue.latitude ?? venue.location_object?.lat);
  const lng = Number(venue.longitude ?? venue.location_object?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function rangeDays(start, end) {
  const result = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) result.push(cursor);
  return result;
}

function inRange(value, start, end) {
  return Boolean(value && value >= start && value <= end);
}

function countCreated(records, start, end) {
  return records.filter((record) => inRange(createdOn(record), start, end)).length;
}

function percentage(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function hasArtistSocial(artist) {
  return Boolean(
    artist.facebookUrl || artist.instagramUrl || artist.websiteUrl || artist.youtubeUrl || artist.spotifyUrl
      || (Array.isArray(artist.socialMediaUrls) && artist.socialMediaUrls.length > 0),
  );
}

function hasVenueSocial(venue) {
  return Boolean(venue.website || (Array.isArray(venue.social_media_urls) && venue.social_media_urls.length > 0));
}

function cumulativeSeries(dates, sortedCreated) {
  let index = 0;
  return dates.map((date) => {
    while (index < sortedCreated.length && sortedCreated[index] <= date) index += 1;
    return index;
  });
}

function sortedCreatedDates(records) {
  return records.map(createdOn).filter(Boolean).sort();
}

function buildGrowth(artists, venues, gigs, today) {
  const artistDates = sortedCreatedDates(artists);
  const venueDates = sortedCreatedDates(venues);
  const gigDates = sortedCreatedDates(gigs);
  const earliest = [artistDates[0], venueDates[0], gigDates[0]].filter(Boolean).sort()[0] ?? today;
  const dates = rangeDays(earliest, today);
  const a = cumulativeSeries(dates, artistDates);
  const v = cumulativeSeries(dates, venueDates);
  const g = cumulativeSeries(dates, gigDates);
  return dates.map((date, i) => ({ date, artists: a[i], venues: v[i], gigs: g[i] }));
}

function buildIntake(artists, venues, gigs, today) {
  const start = addDays(today, -(INTAKE_DAYS - 1));
  const byDate = new Map(rangeDays(start, today).map((date) => [date, { date, artists: 0, venues: 0, gigs: 0, sources: new Map() }]));
  const add = (records, key) => {
    for (const record of records) {
      const date = createdOn(record);
      const point = date && byDate.get(date);
      if (!point) continue;
      point[key] += 1;
      const source = sourceOf(record);
      const row = point.sources.get(source) ?? { source, artists: 0, venues: 0, gigs: 0 };
      row[key] += 1;
      point.sources.set(source, row);
    }
  };
  add(artists, 'artists');
  add(venues, 'venues');
  add(gigs, 'gigs');
  return Array.from(byDate.values()).map((point) => ({
    ...point,
    sources: Array.from(point.sources.values()).sort((x, y) => (y.artists + y.venues + y.gigs) - (x.artists + x.venues + x.gigs) || x.source.localeCompare(y.source)),
  }));
}

function buildGigsByDate(gigs, today) {
  const start = addDays(today, -GIGS_BACK_DAYS);
  const end = addDays(today, GIGS_AHEAD_DAYS);
  const counts = new Map();
  for (const gig of gigs) {
    const date = dateOnly(gig.date);
    if (inRange(date, start, end)) counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return rangeDays(start, end).map((date) => ({ date, gigs: counts.get(date) ?? 0 }));
}

function groupByArea(gigs, venueById) {
  const areas = new Map();
  for (const gig of gigs) {
    const venue = gig.venueId && venueById.get(gig.venueId);
    if (!venue) continue;
    const area = venueArea(venue);
    const state = areas.get(area) ?? { area, gigs: 0, venueIds: new Set(), artistIds: new Set(), lat: 0, lng: 0, coords: 0 };
    state.gigs += 1;
    state.venueIds.add(venue.id);
    eventArtistIds(gig).forEach((id) => state.artistIds.add(id));
    const coords = venueCoordinates(venue);
    if (coords) {
      state.lat += coords.lat;
      state.lng += coords.lng;
      state.coords += 1;
    }
    areas.set(area, state);
  }
  return areas;
}

function buildGeography(monthGigs, venueById) {
  return Array.from(groupByArea(monthGigs, venueById).values())
    .filter((state) => state.coords > 0)
    .map((state) => ({
      area: state.area,
      gigs: state.gigs,
      venues: state.venueIds.size,
      artists: state.artistIds.size,
      latitude: round(state.lat / state.coords, 5),
      longitude: round(state.lng / state.coords, 5),
    }))
    .sort((x, y) => y.gigs - x.gigs || x.area.localeCompare(y.area))
    .slice(0, GEOGRAPHY_LIMIT);
}

function buildTonight(gigs, venueById, today) {
  const tonight = gigs.filter((gig) => dateOnly(gig.date) === today);
  const areas = groupByArea(tonight, venueById);
  const busiest = Array.from(areas.values()).sort((x, y) => y.gigs - x.gigs || x.area.localeCompare(y.area))[0];
  return {
    gigs: tonight.length,
    venues: new Set(tonight.map((gig) => gig.venueId).filter(Boolean)).size,
    artists: new Set(tonight.flatMap(eventArtistIds)).size,
    areas: areas.size,
    busiestArea: busiest ? busiest.area : null,
    addedToday: gigs.filter((gig) => createdOn(gig) === today).length,
  };
}

function artistHealth(artists) {
  const fields = artists.flatMap((artist) => [
    Boolean(artist.location),
    Array.isArray(artist.genres) && artist.genres.length > 0,
    hasArtistSocial(artist),
    Boolean(artist.artistType),
  ]);
  const confident = artists.filter((artist) => artist.needs_review !== true && artist.enrichment_status !== 'needs_review').length;
  return {
    completeness: percentage(fields.filter(Boolean).length, fields.length),
    confidence: percentage(confident, artists.length),
    gaps: [
      { key: 'no-location', label: 'No location', count: artists.filter((artist) => !artist.location).length },
      { key: 'no-genres', label: 'No genres', count: artists.filter((artist) => !Array.isArray(artist.genres) || artist.genres.length === 0).length },
      { key: 'no-socials', label: 'No socials', count: artists.filter((artist) => !hasArtistSocial(artist)).length },
      { key: 'needs-review', label: 'Needs review', count: artists.filter((artist) => artist.needs_review === true).length },
    ],
  };
}

function venueHealth(venues) {
  const fields = venues.flatMap((venue) => [
    Boolean(venue.google_place_id),
    hasVenueSocial(venue),
    venueCoordinates(venue) !== null,
    Boolean(venue.postcode),
  ]);
  const confident = venues.filter((venue) => venue.validated === true || ['high_confidence', 'reviewed'].includes(venue.enrichment_status)).length;
  return {
    completeness: percentage(fields.filter(Boolean).length, fields.length),
    confidence: percentage(confident, venues.length),
    gaps: [
      { key: 'no-place-id', label: 'No Place ID', count: venues.filter((venue) => !venue.google_place_id).length },
      { key: 'no-socials', label: 'No socials', count: venues.filter((venue) => !hasVenueSocial(venue)).length },
      { key: 'no-postcode', label: 'No postcode', count: venues.filter((venue) => !venue.postcode).length },
      { key: 'not-validated', label: 'Not validated', count: venues.filter((venue) => venue.validated !== true).length },
    ],
  };
}

function buildIntelligence({ artists: artistsInput, venues: venuesInput, events, users, today, now }) {
  const artists = artistsInput.filter(liveRecord);
  const venues = venuesInput.filter(liveRecord);
  const gigs = events.filter(isGig).filter((event) => Boolean(dateOnly(event.date)));
  const venueById = new Map(venues.map((venue) => [venue.id, venue]));

  const weekStart = addDays(today, -6);
  const month = monthStart(today);
  const monthEnd = addDays(monthStart(addDays(month, 32)), -1);
  const monthGigs = gigs.filter((gig) => inRange(dateOnly(gig.date), month, monthEnd));
  const tonight = buildTonight(gigs, venueById, today);
  const delta = (records) => ({ week: countCreated(records, weekStart, today), month: countCreated(records, month, today) });

  return {
    generatedAt: now.toISOString(),
    today,
    totals: {
      artists: artists.length,
      venues: venues.length,
      users: users.length,
      gigsAhead: gigs.filter((gig) => dateOnly(gig.date) >= today).length,
      gigsTonight: tonight.gigs,
      activeAreas: groupByArea(monthGigs, venueById).size,
    },
    deltas: { artists: delta(artists), venues: delta(venues), gigs: delta(gigs), users: delta(users) },
    growth: buildGrowth(artists, venues, gigs, today),
    intake: buildIntake(artists, venues, gigs, today),
    gigsByDate: buildGigsByDate(gigs, today),
    tonight,
    geography: buildGeography(monthGigs, venueById),
    health: { artists: artistHealth(artists), venues: venueHealth(venues) },
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function createHandler({ scanTable = defaultScanTable, requirePlatformAdmin = defaultRequirePlatformAdmin, now = () => new Date(), ttlMs = CACHE_TTL_MS } = {}) {
  let cache = null;
  return async function handle(event) {
    const auth = await requirePlatformAdmin(event);
    if (auth.error) return response(auth.status, { error: auth.error });

    const current = now();
    if (cache && cache.expiresAt > current.getTime()) return response(200, cache.payload);

    try {
      const [artists, venues, events, users] = await Promise.all([
        scanTable(TABLES.artists.name),
        scanTable(TABLES.venues.name),
        scanTable(TABLES.events.name),
        scanTable(TABLES.users.name),
      ]);
      const payload = buildIntelligence({ artists, venues, events, users, today: ukDateString(current), now: current });
      cache = { payload, expiresAt: current.getTime() + ttlMs };
      return response(200, payload);
    } catch (error) {
      console.error('[INTELLIGENCE] build failed', error);
      return response(500, { error: 'Failed to build intelligence' });
    }
  };
}

exports.handle = createHandler();
exports.createHandler = createHandler;
exports.__test = { buildIntelligence, sourceOf, isGig, liveRecord, venueArea, ukDateString };
