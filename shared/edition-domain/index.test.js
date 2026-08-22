'use strict';

const {
  normaliseEdition,
  getPublicationScopes,
  isPublishedInEdition,
  getDiscoveryScopes,
  canDriveDiscovery,
  brassVenueDefaults
} = require('./index');

describe('edition-domain', () => {
  test('legacy records remain live by default', () => {
    const legacy = { id: 'legacy' };
    expect(getPublicationScopes(legacy)).toEqual(['live']);
    expect(isPublishedInEdition(legacy, 'live')).toBe(true);
    expect(isPublishedInEdition(legacy, 'brass')).toBe(false);
    expect(getDiscoveryScopes(legacy)).toEqual(['live']);
    expect(canDriveDiscovery(legacy, 'live')).toBe(true);
  });

  test('unknown edition values fall back to live', () => {
    expect(normaliseEdition('unknown')).toBe('live');
    expect(normaliseEdition(undefined)).toBe('live');
  });

  test('brass records are isolated from live publication', () => {
    const brass = { publicationScopes: ['brass'], discoveryScopes: [] };
    expect(isPublishedInEdition(brass, 'live')).toBe(false);
    expect(isPublishedInEdition(brass, 'brass')).toBe(true);
    expect(canDriveDiscovery(brass, 'live')).toBe(false);
    expect(canDriveDiscovery(brass, 'brass')).toBe(false);
  });

  test('new brass venue defaults cannot drive discovery anywhere', () => {
    const venue = brassVenueDefaults();
    expect(venue).toEqual({ publicationScopes: ['brass'], discoveryScopes: [] });
    expect(canDriveDiscovery(venue, 'live')).toBe(false);
    expect(canDriveDiscovery(venue, 'brass')).toBe(false);
  });

  test('shared venue publication does not imply discovery eligibility', () => {
    const venue = {
      publicationScopes: ['live', 'brass'],
      discoveryScopes: ['live']
    };
    expect(isPublishedInEdition(venue, 'live')).toBe(true);
    expect(isPublishedInEdition(venue, 'brass')).toBe(true);
    expect(canDriveDiscovery(venue, 'live')).toBe(true);
    expect(canDriveDiscovery(venue, 'brass')).toBe(false);
  });
});
