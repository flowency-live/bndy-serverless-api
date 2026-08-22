'use strict';

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => ({ scan: jest.fn(() => ({ promise: async () => ({ Items: [] }) })) })) }
}));

const { __test } = require('./handler');

describe('brass read API helpers', () => {
  test('requires explicit brass publication scope', () => {
    expect(__test.hasBrassScope({})).toBe(false);
    expect(__test.hasBrassScope({ publicationScopes: [] })).toBe(false);
    expect(__test.hasBrassScope({ publicationScopes: ['live'] })).toBe(false);
    expect(__test.hasBrassScope({ publicationScopes: ['brass'] })).toBe(true);
    expect(__test.hasBrassScope({ publicationScopes: ['live', 'brass'] })).toBe(true);
  });

  test('maps band coordinates without inventing them', () => {
    expect(__test.publicBand({ id: 'b1', name: 'Band', performerKind: 'brass_band', publicationScopes: ['brass'], locationLat: 53.4, locationLng: -2.1 }))
      .toMatchObject({ locationLat: 53.4, locationLng: -2.1 });
    expect(__test.publicBand({ id: 'b2', name: 'Band 2', performerKind: 'brass_band', publicationScopes: ['brass'] }))
      .toMatchObject({ locationLat: null, locationLng: null });
  });

  test('accepts canonical event and venue coordinate shapes', () => {
    expect(__test.venueCoordinates({ locationLat: 51.5, locationLng: -0.1 }, {})).toEqual({ lat: 51.5, lng: -0.1 });
    expect(__test.venueCoordinates({ location: { lat: 52, lng: -1 } }, {})).toEqual({ lat: 52, lng: -1 });
    expect(__test.venueCoordinates({ latitude: 53, longitude: -2 }, {})).toEqual({ lat: 53, lng: -2 });
    expect(__test.venueCoordinates({}, { geoLat: 54, geoLng: -3 })).toEqual({ lat: 54, lng: -3 });
  });

  test('publishes productions from embedded Artist acts', () => {
    expect(__test.publicProduction({ id: 'a1', name: 'The Snowman', productionKind: 'live_cinema', publicationScopes: ['brass'] }, 'band1'))
      .toMatchObject({ id: 'a1', performerId: 'band1', name: 'The Snowman', productionKind: 'live_cinema', publicationScopes: ['brass'] });
  });
});
