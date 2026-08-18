/**
 * findPlaceFromGoogle query construction.
 *
 * THE DEFECT THIS PINS DOWN. Before 2026-08-14 the query was always
 * `${name}, ${city}`. The address the caller supplied, postcode and all, was
 * accepted by the route and then dropped. "The Kings, Heywood" returned Kings
 * Barber, a barber shop on a different street, and the importer created it as a
 * pub. Four wrong resolutions in one 191 record import traced to this line.
 *
 * These tests assert the QUERY STRING, not the Google response. The query is
 * the whole defect.
 */

const mockFindPlace = jest.fn();
const mockDetails = jest.fn();

jest.mock('@googlemaps/google-maps-services-js', () => ({
  Client: jest.fn(() => ({
    findPlaceFromText: (...a) => mockFindPlace(...a),
    placeDetails: (...a) => mockDetails(...a),
  })),
  PlaceInputType: { textQuery: 'textquery' },
}));

const { findPlaceFromGoogle } = require('./google-places');

const okPlace = {
  data: {
    status: 'OK',
    candidates: [
      {
        place_id: 'ChIJtest',
        name: 'The Kings',
        formatted_address: '11 Market Pl, Heywood OL10 1LA',
        geometry: { location: { lat: 53.59, lng: -2.22 } },
        types: ['bar', 'point_of_interest'],
      },
    ],
  },
};

const queryOf = () => mockFindPlace.mock.calls[0][0].params.input;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  mockFindPlace.mockResolvedValue(okPlace);
  mockDetails.mockResolvedValue({ data: { status: 'OK', result: { address_components: [], types: [] } } });
});

describe('the location half of the query', () => {
  it('uses the address when the caller supplies one', async () => {
    await findPlaceFromGoogle('The Kings', 'Heywood', '11 Market Place, Heywood, OL10 1LA');
    expect(queryOf()).toBe('The Kings, 11 Market Place, Heywood, OL10 1LA');
  });

  it('falls back to the city when there is no address', async () => {
    await findPlaceFromGoogle('The Kings', 'Heywood');
    expect(queryOf()).toBe('The Kings, Heywood');
  });

  it('falls back to the city when the address is empty or blank', async () => {
    await findPlaceFromGoogle('The Kings', 'Heywood', '   ');
    expect(queryOf()).toBe('The Kings, Heywood');
  });

  it('carries the postcode into the query, because a postcode is a building', async () => {
    await findPlaceFromGoogle('The Victory', 'Blackpool', '105 Caunce Street, Blackpool, FY1 3NE');
    expect(queryOf()).toContain('FY1 3NE');
  });

  it('never sends the town alone once a street is known', async () => {
    await findPlaceFromGoogle('Bridges', 'Warrington', 'Bridge Street, Howley, Warrington WA1');
    expect(queryOf()).not.toBe('Bridges, Warrington');
  });
});

describe('the rest of the contract is unchanged', () => {
  it('returns null when Google finds nothing', async () => {
    mockFindPlace.mockResolvedValue({ data: { status: 'ZERO_RESULTS', candidates: [] } });
    expect(await findPlaceFromGoogle('Nowhere', 'Nowhere', '1 Nowhere St')).toBeNull();
  });

  it('returns null when the candidate has no place_id', async () => {
    mockFindPlace.mockResolvedValue({
      data: { status: 'OK', candidates: [{ name: 'x', geometry: { location: { lat: 1, lng: 2 } } }] },
    });
    expect(await findPlaceFromGoogle('x', 'y', 'z')).toBeNull();
  });

  it('returns null when the candidate has no geometry', async () => {
    mockFindPlace.mockResolvedValue({
      data: { status: 'OK', candidates: [{ place_id: 'p', name: 'x' }] },
    });
    expect(await findPlaceFromGoogle('x', 'y', 'z')).toBeNull();
  });
});
