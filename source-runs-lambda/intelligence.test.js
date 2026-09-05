const test = require('node:test');
const assert = require('node:assert/strict');
const { __test, createHandler } = require('./intelligence');

const TODAY = '2026-09-06';

function artist(overrides = {}) {
  return {
    id: `artist-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Artist',
    createdAt: '2026-09-01T10:00:00.000Z',
    location: 'Stoke-on-Trent, UK',
    genres: ['Rock'],
    facebookUrl: 'https://facebook.com/x',
    artistType: 'band',
    ...overrides,
  };
}

function venue(overrides = {}) {
  return {
    id: `venue-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Venue',
    createdAt: '2026-08-20T10:00:00.000Z',
    city: 'Stoke-on-Trent',
    postcode: 'ST1 1AA',
    latitude: 53.0,
    longitude: -2.18,
    google_place_id: 'place',
    website: 'https://venue.example',
    validated: true,
    ...overrides,
  };
}

function gig(overrides = {}) {
  return {
    id: `event-${Math.random().toString(36).slice(2, 8)}`,
    isPublic: true,
    type: 'public_gig',
    date: TODAY,
    createdAt: '2026-09-05T09:00:00.000Z',
    artistId: 'artist-a',
    venueId: 'venue-a',
    ...overrides,
  };
}

function build(parts = {}) {
  return __test.buildIntelligence({
    artists: parts.artists || [],
    venues: parts.venues || [],
    events: parts.events || [],
    users: parts.users || [],
    today: TODAY,
    now: new Date('2026-09-06T09:00:00.000Z'),
  });
}

test('sourceOf reads external ids first, then created_source, then unknown', () => {
  assert.equal(__test.sourceOf({ external_ids: [{ source: 'lemonrock', id: 'x' }], created_source: 'mcp_ai_import' }), 'lemonrock');
  assert.equal(__test.sourceOf({ external_ids: ['klma-stoke-gig-list:123'] }), 'klma-stoke-gig-list');
  assert.equal(__test.sourceOf({ created_source: 'join_bndy' }), 'join_bndy');
  assert.equal(__test.sourceOf({ source: 'frontstage' }), 'frontstage');
  assert.equal(__test.sourceOf({}), 'unknown');
});

test('growth is cumulative per day and includes venues, artists and gigs', () => {
  const result = build({
    artists: [artist({ createdAt: '2026-09-04T00:00:00.000Z' }), artist({ createdAt: '2026-09-06T00:00:00.000Z' })],
    venues: [venue({ createdAt: '2026-09-04T12:00:00.000Z' }), venue({ createdAt: '2026-09-05T12:00:00.000Z' })],
    events: [gig({ createdAt: '2026-09-05T00:00:00.000Z' })],
  });
  assert.deepEqual(result.growth, [
    { date: '2026-09-04', artists: 1, venues: 1, gigs: 0 },
    { date: '2026-09-05', artists: 1, venues: 2, gigs: 1 },
    { date: '2026-09-06', artists: 2, venues: 2, gigs: 1 },
  ]);
});

test('totals exclude hidden records and records not published to the live edition', () => {
  const result = build({
    artists: [artist(), artist({ hidden: true }), artist({ publicationScopes: ['brass'] })],
    venues: [venue(), venue({ hidden: true })],
    events: [gig(), gig({ hidden: true }), gig({ isPublic: false }), gig({ date: '2026-12-01' })],
    users: [{ cognito_id: 'u1', created_at: '2026-09-01T00:00:00.000Z' }, { cognito_id: 'u2', createdAt: '2025-01-01T00:00:00.000Z' }],
  });
  assert.equal(result.totals.artists, 1);
  assert.equal(result.totals.venues, 1);
  assert.equal(result.totals.users, 2);
  assert.equal(result.totals.gigsTonight, 1);
  assert.equal(result.totals.gigsAhead, 2);
});

test('deltas count records created this week and this month', () => {
  const result = build({
    artists: [
      artist({ createdAt: '2026-09-06T00:00:00.000Z' }),
      artist({ createdAt: '2026-09-02T00:00:00.000Z' }),
      artist({ createdAt: '2026-08-20T00:00:00.000Z' }),
    ],
    venues: [venue({ createdAt: '2026-09-01T00:00:00.000Z' })],
    events: [gig({ createdAt: '2026-09-06T00:00:00.000Z', date: '2026-10-10' }), gig({ createdAt: '2026-07-01T00:00:00.000Z' })],
    users: [{ cognito_id: 'u1', created_at: '2026-09-03T00:00:00.000Z' }],
  });
  assert.deepEqual(result.deltas.artists, { week: 2, month: 2 });
  assert.deepEqual(result.deltas.venues, { week: 1, month: 1 });
  assert.deepEqual(result.deltas.gigs, { week: 1, month: 1 });
  assert.deepEqual(result.deltas.users, { week: 1, month: 1 });
});

test('intake lists the last 90 days with per-source breakdown of created records', () => {
  const result = build({
    artists: [
      artist({ createdAt: '2026-09-05T08:00:00.000Z', external_ids: [{ source: 'lemonrock', id: 'a1' }] }),
      artist({ createdAt: '2026-09-05T09:00:00.000Z', external_ids: [{ source: 'lemonrock', id: 'a2' }] }),
      artist({ createdAt: '2026-09-05T10:00:00.000Z', source: 'frontstage' }),
    ],
    venues: [venue({ createdAt: '2026-09-05T11:00:00.000Z', created_source: 'mcp_ai_import' })],
    events: [gig({ createdAt: '2026-09-05T12:00:00.000Z', external_ids: ['klma-stoke-gig-list:e1'] })],
  });
  assert.equal(result.intake.length, 90);
  assert.equal(result.intake[0].date, '2026-06-09');
  assert.equal(result.intake[89].date, TODAY);
  const day = result.intake.find((point) => point.date === '2026-09-05');
  assert.equal(day.artists, 3);
  assert.equal(day.venues, 1);
  assert.equal(day.gigs, 1);
  assert.deepEqual(day.sources, [
    { source: 'lemonrock', artists: 2, venues: 0, gigs: 0 },
    { source: 'frontstage', artists: 1, venues: 0, gigs: 0 },
    { source: 'klma-stoke-gig-list', artists: 0, venues: 0, gigs: 1 },
    { source: 'mcp_ai_import', artists: 0, venues: 1, gigs: 0 },
  ]);
  const quiet = result.intake.find((point) => point.date === '2026-07-01');
  assert.deepEqual(quiet, { date: '2026-07-01', artists: 0, venues: 0, gigs: 0, sources: [] });
});

test('gigsByDate covers 30 days back and 90 days ahead by event date', () => {
  const result = build({
    events: [gig({ date: '2026-09-06' }), gig({ date: '2026-09-06' }), gig({ date: '2026-09-12' }), gig({ date: '2027-01-01' })],
  });
  assert.equal(result.gigsByDate.length, 121);
  assert.equal(result.gigsByDate[0].date, '2026-08-07');
  assert.equal(result.gigsByDate[120].date, '2026-12-05');
  assert.equal(result.gigsByDate.find((point) => point.date === '2026-09-06').gigs, 2);
  assert.equal(result.gigsByDate.find((point) => point.date === '2026-09-12').gigs, 1);
});

test('tonight and geography group gigs by venue area', () => {
  const stoke = venue({ id: 'venue-a', city: 'Stoke-on-Trent', latitude: 53.0, longitude: -2.18 });
  const stoke2 = venue({ id: 'venue-b', city: 'Stoke-on-Trent', latitude: 53.1, longitude: -2.2 });
  const torquay = venue({ id: 'venue-c', city: 'Torquay', latitude: 50.46, longitude: -3.52 });
  const result = build({
    venues: [stoke, stoke2, torquay],
    events: [
      gig({ venueId: 'venue-a', artistId: 'artist-1', createdAt: '2026-09-06T08:00:00.000Z' }),
      gig({ venueId: 'venue-b', artistId: 'artist-2', collaboratingArtistIds: ['artist-3'] }),
      gig({ venueId: 'venue-c', artistId: 'artist-4' }),
      gig({ venueId: 'venue-c', artistId: 'artist-4', date: '2026-09-20' }),
    ],
  });
  assert.deepEqual(result.tonight, { gigs: 3, venues: 3, artists: 4, areas: 2, busiestArea: 'Stoke-on-Trent', addedToday: 1 });
  assert.equal(result.totals.activeAreas, 2);
  assert.deepEqual(result.geography[0], { area: 'Stoke-on-Trent', gigs: 2, venues: 2, artists: 3, latitude: 53.05, longitude: -2.19 });
  assert.deepEqual(result.geography[1], { area: 'Torquay', gigs: 2, venues: 1, artists: 1, latitude: 50.46, longitude: -3.52 });
});

test('health reports completeness, confidence and gap counts', () => {
  const result = build({
    artists: [artist(), artist({ location: undefined, genres: [], facebookUrl: '', needs_review: true })],
    venues: [venue(), venue({ google_place_id: undefined, website: '', postcode: '', validated: false })],
  });
  assert.equal(result.health.artists.completeness, 63);
  assert.equal(result.health.artists.confidence, 50);
  assert.deepEqual(result.health.artists.gaps, [
    { key: 'no-location', label: 'No location', count: 1 },
    { key: 'no-genres', label: 'No genres', count: 1 },
    { key: 'no-socials', label: 'No socials', count: 1 },
    { key: 'needs-review', label: 'Needs review', count: 1 },
  ]);
  assert.equal(result.health.venues.completeness, 63);
  assert.equal(result.health.venues.confidence, 50);
  assert.deepEqual(result.health.venues.gaps, [
    { key: 'no-place-id', label: 'No Place ID', count: 1 },
    { key: 'no-socials', label: 'No socials', count: 1 },
    { key: 'no-postcode', label: 'No postcode', count: 1 },
    { key: 'not-validated', label: 'Not validated', count: 1 },
  ]);
});

test('handler rejects non-admins and serves a cached payload to admins', async () => {
  let scans = 0;
  const scanTable = async (tableName) => {
    scans += 1;
    if (tableName === 'bndy-artists') return [artist()];
    if (tableName === 'bndy-venues') return [venue()];
    if (tableName === 'bndy-events') return [gig()];
    return [{ cognito_id: 'u1', created_at: '2026-09-01T00:00:00.000Z' }];
  };
  const denied = createHandler({ scanTable, requirePlatformAdmin: async () => ({ error: 'Not authenticated', status: 401 }) });
  const rejected = await denied({});
  assert.equal(rejected.statusCode, 401);

  const handler = createHandler({ scanTable, requirePlatformAdmin: async () => ({ user: { id: 'admin' } }), now: () => new Date('2026-09-06T09:00:00.000Z') });
  const first = await handler({});
  assert.equal(first.statusCode, 200);
  const body = JSON.parse(first.body);
  assert.equal(body.today, TODAY);
  assert.equal(body.totals.artists, 1);
  assert.equal(scans, 4);

  const second = await handler({});
  assert.equal(second.statusCode, 200);
  assert.equal(scans, 4, 'second call within the cache window does not rescan');
});
