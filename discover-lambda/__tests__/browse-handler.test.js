/**
 * Tests for /api/artists/browse endpoint
 *
 * Provides faceted search for artists with filtering, sorting, and pagination.
 */

const { filterArtists, buildFacets, sortArtists, parseQuery, paginateResults } = require('../lib/browse-handler');

describe('filterArtists', () => {
  const artists = [
    { id: '1', name: 'Rock Band', genres: ['Rock'], artistType: 'band', actType: 'originals', acoustic: false, location: 'London' },
    { id: '2', name: 'Jazz Duo', genres: ['Jazz'], artistType: 'duo', actType: 'originals', acoustic: true, location: 'Manchester' },
    { id: '3', name: 'Acoustic Act', genres: ['Folk', 'Rock'], artistType: 'solo', actType: 'covers', acoustic: true, location: 'London' },
    { id: '4', name: 'Metal Band', genres: ['Metal', 'Rock'], artistType: 'band', actType: 'originals', acoustic: false, location: 'Birmingham' },
  ];

  test('returns all artists when no filters', () => {
    const result = filterArtists(artists, {});
    expect(result).toHaveLength(4);
  });

  test('filters by genre', () => {
    const result = filterArtists(artists, { genre: ['Rock'] });
    expect(result).toHaveLength(3);
    expect(result.map(a => a.id)).toEqual(['1', '3', '4']);
  });

  test('filters by multiple genres (OR)', () => {
    const result = filterArtists(artists, { genre: ['Jazz', 'Metal'] });
    expect(result).toHaveLength(2);
    expect(result.map(a => a.id)).toEqual(['2', '4']);
  });

  test('filters by artistType', () => {
    const result = filterArtists(artists, { artistType: ['band'] });
    expect(result).toHaveLength(2);
  });

  test('filters by actType', () => {
    const result = filterArtists(artists, { actType: ['covers'] });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('3');
  });

  test('filters by acoustic', () => {
    const result = filterArtists(artists, { acoustic: true });
    expect(result).toHaveLength(2);
    expect(result.map(a => a.id)).toEqual(['2', '3']);
  });

  test('filters by area (location)', () => {
    const result = filterArtists(artists, { area: ['London'] });
    expect(result).toHaveLength(2);
    expect(result.map(a => a.id)).toEqual(['1', '3']);
  });

  test('combines multiple filters (AND)', () => {
    const result = filterArtists(artists, { genre: ['Rock'], acoustic: true });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('3');
  });

  test('filters by text search (name)', () => {
    const result = filterArtists(artists, { q: 'band' });
    expect(result).toHaveLength(2);
    expect(result.map(a => a.id)).toEqual(['1', '4']);
  });

  test('text search is case insensitive', () => {
    const result = filterArtists(artists, { q: 'JAZZ' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('2');
  });
});

describe('buildFacets', () => {
  const artists = [
    { id: '1', genres: ['Rock'], artistType: 'band', actType: 'originals', acoustic: false, location: 'London' },
    { id: '2', genres: ['Jazz'], artistType: 'duo', actType: 'originals', acoustic: true, location: 'Manchester' },
    { id: '3', genres: ['Folk', 'Rock'], artistType: 'solo', actType: 'covers', acoustic: true, location: 'London' },
  ];

  test('builds genre facet counts', () => {
    const facets = buildFacets(artists);
    expect(facets.genre).toEqual({ Rock: 2, Jazz: 1, Folk: 1 });
  });

  test('builds artistType facet counts', () => {
    const facets = buildFacets(artists);
    expect(facets.artistType).toEqual({ band: 1, duo: 1, solo: 1 });
  });

  test('builds actType facet counts', () => {
    const facets = buildFacets(artists);
    expect(facets.actType).toEqual({ originals: 2, covers: 1 });
  });

  test('builds acoustic facet counts', () => {
    const facets = buildFacets(artists);
    expect(facets.acoustic).toEqual({ true: 2, false: 1 });
  });

  test('builds area facet counts', () => {
    const facets = buildFacets(artists);
    expect(facets.area).toEqual({ London: 2, Manchester: 1 });
  });

  test('handles empty artists array', () => {
    const facets = buildFacets([]);
    expect(facets.genre).toEqual({});
    expect(facets.artistType).toEqual({});
  });
});

describe('sortArtists', () => {
  const artists = [
    { id: '1', name: 'Zephyr', createdAt: '2026-08-01', giggingUntil: '2026-12-01' },
    { id: '2', name: 'Alpha', createdAt: '2026-08-15', giggingUntil: '2026-09-01' },
    { id: '3', name: 'Monkey', createdAt: '2026-07-01', giggingUntil: '2026-10-15' },
  ];

  test('sorts by name A-Z (default)', () => {
    const result = sortArtists(artists, 'name');
    expect(result.map(a => a.name)).toEqual(['Alpha', 'Monkey', 'Zephyr']);
  });

  test('sorts by newest (createdAt desc)', () => {
    const result = sortArtists(artists, 'newest');
    expect(result.map(a => a.id)).toEqual(['2', '1', '3']);
  });

  test('sorts by soonest (giggingUntil asc)', () => {
    const result = sortArtists(artists, 'soonest');
    expect(result.map(a => a.id)).toEqual(['2', '3', '1']);
  });

  test('handles missing sort field gracefully', () => {
    const artistsNoGig = [
      { id: '1', name: 'Zephyr', createdAt: '2026-08-01' },
      { id: '2', name: 'Alpha', createdAt: '2026-08-15', giggingUntil: '2026-09-01' },
    ];
    const result = sortArtists(artistsNoGig, 'soonest');
    expect(result).toHaveLength(2);
  });
});

describe('parseQuery', () => {
  test('parses genre from query', () => {
    const result = parseQuery('rock');
    expect(result.genre).toContain('Rock');
    expect(result.text).toBe('');
  });

  test('parses acoustic from query', () => {
    const result = parseQuery('acoustic');
    expect(result.acoustic).toBe(true);
    expect(result.text).toBe('');
  });

  test('parses actType from query', () => {
    const result = parseQuery('covers');
    expect(result.actType).toContain('Covers');
    expect(result.text).toBe('');
  });

  test('leaves unrecognised tokens as text', () => {
    const result = parseQuery('monkey rock');
    expect(result.genre).toContain('Rock');
    expect(result.text).toBe('monkey');
  });

  test('handles empty query', () => {
    const result = parseQuery('');
    expect(result.text).toBe('');
    expect(result.genre).toEqual([]);
  });
});

describe('paginateResults', () => {
  const artists = Array.from({ length: 50 }, (_, i) => ({ id: `${i + 1}`, name: `Artist ${i + 1}` }));

  test('returns first page with limit', () => {
    const { results, nextCursor } = paginateResults(artists, null, 10);
    expect(results).toHaveLength(10);
    expect(results[0].id).toBe('1');
    expect(nextCursor).toBeTruthy();
  });

  test('returns next page from cursor', () => {
    const { results: page1, nextCursor: cursor1 } = paginateResults(artists, null, 10);
    const { results: page2, nextCursor: cursor2 } = paginateResults(artists, cursor1, 10);
    expect(page2).toHaveLength(10);
    expect(page2[0].id).toBe('11');
    expect(cursor2).toBeTruthy();
  });

  test('returns null cursor on last page', () => {
    const { nextCursor } = paginateResults(artists.slice(0, 5), null, 10);
    expect(nextCursor).toBeNull();
  });

  test('handles empty results', () => {
    const { results, nextCursor } = paginateResults([], null, 10);
    expect(results).toEqual([]);
    expect(nextCursor).toBeNull();
  });
});
