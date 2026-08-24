jest.mock('aws-sdk', () => {
  const promise = jest.fn();
  return {
    DynamoDB: Object.assign(
      jest.fn(() => ({ listTables: jest.fn(() => ({ promise })) })),
      { DocumentClient: jest.fn(() => ({})) },
    ),
  };
});

const {
  SOURCE_ID,
  buildUserCreatedArtistClaims,
} = require('./backline-user-claims');

describe('user-created artist Backline claims', () => {
  test('records submitted artist fields as high-confidence claims', () => {
    const claims = buildUserCreatedArtistClaims({
      id: 'artist-123',
      name: 'A Hundred Endings',
      facebookUrl: 'https://www.facebook.com/ahundredendings',
      websiteUrl: 'https://example.com',
      instagramUrl: '',
      location: 'Stoke-on-Trent',
      artist_type: 'band',
      actType: 'original',
      bio: 'Heavy music.',
      genres: ['Rock', 'Metal'],
    }, '2026-08-24T12:00:00.000Z');

    expect(SOURCE_ID).toBe('frontstage-user-created-artist');
    expect(claims).toHaveLength(9);
    expect(claims.every((claim) => claim.confidence === 0.99)).toBe(true);
    expect(claims.every((claim) => claim.subject.type === 'artist')).toBe(true);
    expect(claims.every((claim) => claim.subject.key === 'artist-123')).toBe(true);

    expect(claims).toEqual(expect.arrayContaining([
      expect.objectContaining({
        predicate: 'hasName',
        value: 'A Hundred Endings',
      }),
      expect.objectContaining({
        predicate: 'hasFacebookUrl',
        value: 'https://www.facebook.com/ahundredendings',
        evidence: expect.objectContaining({
          sourceUrl: 'https://www.facebook.com/ahundredendings',
        }),
      }),
      expect.objectContaining({ predicate: 'hasLocation', value: 'Stoke-on-Trent' }),
      expect.objectContaining({ predicate: 'hasGenre', value: 'Rock' }),
      expect.objectContaining({ predicate: 'hasGenre', value: 'Metal' }),
    ]));
  });

  test('omits blank optional values', () => {
    const claims = buildUserCreatedArtistClaims({
      id: 'artist-456',
      name: 'Editable Name',
      facebookUrl: '',
      websiteUrl: '   ',
      location: 'Staffordshire',
      artist_type: 'solo',
      genres: [],
    }, '2026-08-24T12:00:00.000Z');

    expect(claims.map((claim) => claim.predicate)).toEqual([
      'hasName',
      'hasLocation',
      'hasArtistType',
    ]);
  });

  test('uses stable ids for a retry of the same saved observation', () => {
    const artist = {
      id: 'artist-789',
      name: 'Retry Artist',
      facebookUrl: 'https://www.facebook.com/retryartist',
      location: 'Birmingham',
      artist_type: 'band',
    };

    const first = buildUserCreatedArtistClaims(artist, '2026-08-24T12:00:00.000Z');
    const second = buildUserCreatedArtistClaims(artist, '2026-08-24T12:05:00.000Z');

    expect(second.map((claim) => claim.id)).toEqual(first.map((claim) => claim.id));
  });
});
