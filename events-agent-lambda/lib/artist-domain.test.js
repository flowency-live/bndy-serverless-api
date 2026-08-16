'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalRegionLabel,
  inferVenueRegion,
  inferBulkArtistRegion,
  buildCanonicalArtistPayload
} = require('./artist-domain');

test('venue towns collapse to broad UK operating regions', () => {
  assert.equal(canonicalRegionLabel('Stoke-on-Trent, Staffordshire, UK'), 'West Midlands');
  assert.equal(canonicalRegionLabel('Manchester, UK'), 'North West');
  assert.equal(canonicalRegionLabel('Portsmouth, Hampshire, UK'), 'South East');
  assert.equal(canonicalRegionLabel('Leeds, West Yorkshire, UK'), 'Yorkshire and the Humber');
  assert.equal(canonicalRegionLabel('Cardiff, Wales, UK'), 'Wales');
});

test('venue address wins over source context for artist region inference', async () => {
  const region = await inferVenueRegion({
    venueResolution: {
      enrichments: { address: '1 High Street, Stoke-on-Trent, Staffordshire, UK' },
      location: { lat: 53.0, lng: -2.18 }
    },
    venueName: 'Example Venue',
    fallbackContext: 'Greater Manchester, UK'
  });
  assert.equal(region, 'West Midlands');
});

test('reverse geocode is used when venue text alone is not enough', async () => {
  const fakeAxios = {
    get: async () => ({
      data: {
        status: 'OK',
        results: [{
          formatted_address: 'Somewhere, UK',
          address_components: [
            { long_name: 'Essex', short_name: 'Essex' },
            { long_name: 'England', short_name: 'England' }
          ]
        }]
      }
    })
  };
  const region = await inferVenueRegion({
    venueResolution: { location: { lat: 51.8, lng: 0.5 } },
    venueName: 'Unrecognised Venue Name',
    axios: fakeAxios,
    googlePlacesApiKey: 'test-key'
  });
  assert.equal(region, 'East of England');
});

test('bulk artist with no own location inherits linked gig venue region', async () => {
  const region = await inferBulkArtistRegion({
    localArtistId: 'artist-1',
    artistData: { name: 'Test Band' },
    venues: {
      'venue-1': { name: 'The Venue', location: { town: 'Macclesfield' } }
    },
    events: {
      'event-1': { artist_id: 'artist-1', venue_id: 'venue-1' }
    },
    locationContext: 'UK'
  });
  assert.equal(region, 'North West');
});

test('canonical artist payload stores region and keeps acoustic separate from act type', () => {
  const result = buildCanonicalArtistPayload({
    name: 'The Test Band',
    region: 'North West',
    artistData: {
      artistType: 'Band',
      genres: ['Classic Rock', 'RNB', 'Made Up Genre'],
      actType: ['Covers', 'Acoustic']
    },
    source: 'agentic_ingest'
  });

  assert.equal(result.payload.location, 'North West');
  assert.equal(result.payload.locationType, 'region');
  assert.equal(result.payload.artistType, 'band');
  assert.deepEqual(result.payload.genres, ['Rock', 'R&B']);
  assert.deepEqual(result.payload.actType, ['covers']);
  assert.equal(result.payload.acoustic, true);
  assert.ok(result.warnings.some((warning) => warning.includes('Made Up Genre')));
});
