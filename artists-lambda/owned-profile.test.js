'use strict';

const {
  hostMatches,
  pickOwnedProfileFields,
  validateUrlField
} = require('./lib/owned-profile');

describe('owned artist profile validation', () => {
  test('keeps only the owned-profile whitelist', () => {
    const result = pickOwnedProfileFields({
      bio: 'A live band',
      youtubeUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      name: 'Unauthorised rename',
      hidden: true
    });

    expect(result.errors).toEqual([]);
    expect(result.fields).toEqual({
      bio: 'A live band',
      youtubeUrl: 'https://www.youtube.com/watch?v=abcdefghijk'
    });
  });

  test('accepts provider subdomains and rejects lookalike hosts', () => {
    expect(hostMatches('m.youtube.com', ['youtube.com'])).toBe(true);
    expect(hostMatches('youtube.com.example.org', ['youtube.com'])).toBe(false);
    expect(validateUrlField('spotifyUrl', 'https://open.spotify.com/artist/123')).toBeNull();
    expect(validateUrlField('spotifyUrl', 'https://spotify.example.com/artist/123')).toMatch(/approved/);
  });

  test('requires HTTPS and rejects invalid phone and enum values', () => {
    const result = pickOwnedProfileFields({
      soundcloudUrl: 'http://soundcloud.com/example',
      phoneNumber: 'not a number',
      availabilityMode: 'always_free'
    });

    expect(result.errors).toEqual(expect.arrayContaining([
      'soundcloudUrl must use HTTPS',
      'phoneNumber must be a valid phone number',
      'availabilityMode is invalid'
    ]));
  });

  test('allows empty media and contact values to clear fields', () => {
    const result = pickOwnedProfileFields({ youtubeUrl: '', whatsappNumber: '' });
    expect(result.errors).toEqual([]);
    expect(result.fields).toEqual({ youtubeUrl: '', whatsappNumber: null });
  });
});
