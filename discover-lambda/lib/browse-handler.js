/**
 * Browse handler for /api/artists/browse endpoint
 *
 * Provides faceted search with filtering, sorting, and pagination.
 * Data is loaded from S3 index into memory for fast filtering.
 */

// Genre taxonomy for query parsing
const GENRES = [
  'Rock', 'Pop', 'Jazz', 'Blues', 'Folk', 'Country', 'Metal', 'Punk',
  'Ska', 'Reggae', 'Soul', 'Funk', 'R&B', 'Hip Hop', 'Electronic',
  'Indie', 'Alternative', 'Classical', 'World',
];

const ACT_TYPES = ['Originals', 'Covers', 'Tribute'];
const ARTIST_TYPES = ['Solo', 'Duo', 'Trio', 'Band', 'Choir', 'Orchestra'];

/**
 * Filter artists by the given criteria.
 * All filters are AND'd together; within a filter (e.g. multiple genres), it's OR.
 */
function filterArtists(artists, filters) {
  return artists.filter((artist) => {
    // Text search on name
    if (filters.q) {
      const searchTerm = filters.q.toLowerCase();
      if (!artist.name?.toLowerCase().includes(searchTerm)) {
        return false;
      }
    }

    // Genre filter (OR within genres)
    if (filters.genre?.length > 0) {
      const artistGenres = (artist.genres || []).map(g => g.toLowerCase());
      const hasMatchingGenre = filters.genre.some(g =>
        artistGenres.includes(g.toLowerCase())
      );
      if (!hasMatchingGenre) return false;
    }

    // Artist type filter
    if (filters.artistType?.length > 0) {
      const type = (artist.artistType || '').toLowerCase();
      if (!filters.artistType.some(t => t.toLowerCase() === type)) {
        return false;
      }
    }

    // Act type filter
    if (filters.actType?.length > 0) {
      const type = (artist.actType || '').toLowerCase();
      if (!filters.actType.some(t => t.toLowerCase() === type)) {
        return false;
      }
    }

    // Acoustic filter
    if (filters.acoustic !== undefined) {
      if (artist.acoustic !== filters.acoustic) return false;
    }

    // Area (location) filter
    if (filters.area?.length > 0) {
      const location = (artist.location || '').toLowerCase();
      if (!filters.area.some(a => location.includes(a.toLowerCase()))) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Build facet counts from a list of artists.
 */
function buildFacets(artists) {
  const facets = {
    genre: {},
    artistType: {},
    actType: {},
    acoustic: {},
    area: {},
  };

  for (const artist of artists) {
    // Genres
    for (const genre of artist.genres || []) {
      facets.genre[genre] = (facets.genre[genre] || 0) + 1;
    }

    // Artist type
    if (artist.artistType) {
      facets.artistType[artist.artistType] = (facets.artistType[artist.artistType] || 0) + 1;
    }

    // Act type
    if (artist.actType) {
      facets.actType[artist.actType] = (facets.actType[artist.actType] || 0) + 1;
    }

    // Acoustic
    const acousticKey = String(artist.acoustic ?? false);
    facets.acoustic[acousticKey] = (facets.acoustic[acousticKey] || 0) + 1;

    // Area (location)
    if (artist.location) {
      facets.area[artist.location] = (facets.area[artist.location] || 0) + 1;
    }
  }

  return facets;
}

/**
 * Sort artists by the given sort key.
 */
function sortArtists(artists, sort) {
  const sorted = [...artists];

  switch (sort) {
    case 'newest':
      sorted.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      break;
    case 'soonest':
      sorted.sort((a, b) => (a.giggingUntil || 'z').localeCompare(b.giggingUntil || 'z'));
      break;
    case 'name':
    default:
      sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      break;
  }

  return sorted;
}

/**
 * Parse a free-text query into structured filters.
 * Order: genre, act type, artist type, acoustic, then leftover text.
 */
function parseQuery(query) {
  const result = {
    genre: [],
    actType: [],
    artistType: [],
    acoustic: undefined,
    text: '',
  };

  if (!query) return result;

  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const remaining = [];

  for (const token of tokens) {
    // Check for acoustic first (before genres, since "Acoustic" is also a genre)
    if (token === 'acoustic') {
      result.acoustic = true;
      continue;
    }

    // Check for genre match
    const genreMatch = GENRES.find(g => g.toLowerCase() === token);
    if (genreMatch) {
      result.genre.push(genreMatch);
      continue;
    }

    // Check for act type match
    const actMatch = ACT_TYPES.find(a => a.toLowerCase() === token);
    if (actMatch) {
      result.actType.push(actMatch);
      continue;
    }

    // Check for artist type match
    const artistMatch = ARTIST_TYPES.find(a => a.toLowerCase() === token);
    if (artistMatch) {
      result.artistType.push(artistMatch);
      continue;
    }

    // Unrecognised - keep as text
    remaining.push(token);
  }

  result.text = remaining.join(' ');
  return result;
}

/**
 * Paginate results using cursor-based pagination.
 * Cursor is base64-encoded offset.
 */
function paginateResults(artists, cursor, limit = 24) {
  let offset = 0;

  if (cursor) {
    try {
      offset = parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10);
    } catch {
      offset = 0;
    }
  }

  const results = artists.slice(offset, offset + limit);
  const hasMore = offset + limit < artists.length;
  const nextCursor = hasMore
    ? Buffer.from(String(offset + limit)).toString('base64')
    : null;

  return { results, nextCursor };
}

module.exports = {
  filterArtists,
  buildFacets,
  sortArtists,
  parseQuery,
  paginateResults,
};
