/**
 * TDD tests for handleBatchEventsWithJoins
 * Shipped 2026-08-19 without tests - TDD debt remediation
 *
 * Tests:
 * - flat artistName/artistNames present
 * - collaborating artist ids included in the join
 * - private fee fields stripped
 * - nested artist and venue objects unchanged
 */

const { handleBatchEventsWithJoins } = require('./public');

function createMockDeps(dynamoOverrides = {}) {
  return {
    dynamodb: {
      get: jest.fn(() => ({ promise: () => Promise.resolve({ Item: null }) })),
      batchGet: jest.fn(() => ({
        promise: () => Promise.resolve({ Responses: {} })
      })),
      ...dynamoOverrides
    },
    getCorsHeaders: () => ({ 'Content-Type': 'application/json' })
  };
}

function createEvent(body) {
  return {
    body: JSON.stringify(body),
    headers: {}
  };
}

const mockArtist1 = { id: 'artist-1', name: 'The Headliners', genres: ['Rock'], profileImageUrl: 'https://example.com/artist1.jpg' };
const mockArtist2 = { id: 'artist-2', name: 'Support Act', genres: ['Pop'], profileImageUrl: 'https://example.com/artist2.jpg' };
const mockArtist3 = { id: 'artist-3', name: 'Guest DJ', genres: ['Electronic'], profileImageUrl: null };

const mockVenue = {
  id: 'venue-1',
  name: 'The Music Hall',
  address: '123 Music Street',
  city: 'Manchester',
  latitude: 53.4808,
  longitude: -2.2426,
  standardTicketed: true,
  standardTicketUrl: 'https://tickets.example.com'
};

const mockEventBasic = {
  id: 'event-1',
  artistId: 'artist-1',
  venueId: 'venue-1',
  date: '2026-07-11',
  startTime: '20:00',
  title: 'Rock Night',
  isPublic: true
};

const mockEventWithCollaborators = {
  id: 'event-2',
  artistId: 'artist-1',
  collaboratingArtistIds: ['artist-2', 'artist-3'],
  venueId: 'venue-1',
  date: '2026-07-12',
  startTime: '19:00',
  title: 'Multi-Act Night',
  isPublic: true
};

const mockEventWithFees = {
  id: 'event-3',
  artistId: 'artist-1',
  venueId: 'venue-1',
  date: '2026-07-13',
  startTime: '21:00',
  title: 'Private Fee Event',
  isPublic: true,
  // Private fields that should be stripped
  agreedFee: 500,
  actualFee: 450,
  datePaid: '2026-07-14',
  paymentMethod: 'bank_transfer',
  splitBetweenMembers: true,
  noFee: false,
  distributed: true
};

describe('handleBatchEventsWithJoins', () => {
  describe('Validation', () => {
    it('returns 400 when eventIds is missing', async () => {
      const deps = createMockDeps();
      const event = createEvent({});

      const res = await handleBatchEventsWithJoins(deps, event);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/eventIds.*required/i);
    });

    it('returns 400 when eventIds is empty', async () => {
      const deps = createMockDeps();
      const event = createEvent({ eventIds: [] });

      const res = await handleBatchEventsWithJoins(deps, event);
      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when eventIds exceeds 100', async () => {
      const deps = createMockDeps();
      const manyIds = Array.from({ length: 101 }, (_, i) => `event-${i}`);
      const event = createEvent({ eventIds: manyIds });

      const res = await handleBatchEventsWithJoins(deps, event);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/100/);
    });
  });

  describe('Flat Fields', () => {
    it('returns artistName for single-artist event', async () => {
      const deps = createMockDeps({
        batchGet: jest.fn((params) => ({
          promise: () => {
            const responses = {};
            for (const [table, spec] of Object.entries(params.RequestItems)) {
              if (table === 'bndy-events') {
                responses[table] = [mockEventBasic];
              } else if (table === 'bndy-artists') {
                responses[table] = [mockArtist1];
              } else if (table === 'bndy-venues') {
                responses[table] = [mockVenue];
              }
            }
            return Promise.resolve({ Responses: responses });
          }
        }))
      });

      const event = createEvent({ eventIds: ['event-1'] });
      const res = await handleBatchEventsWithJoins(deps, event);
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.events).toHaveLength(1);
      expect(body.events[0].artistName).toBe('The Headliners');
    });

    it('returns artistIds and artistNames arrays including collaborators', async () => {
      const deps = createMockDeps({
        batchGet: jest.fn((params) => ({
          promise: () => {
            const responses = {};
            for (const [table, spec] of Object.entries(params.RequestItems)) {
              if (table === 'bndy-events') {
                responses[table] = [mockEventWithCollaborators];
              } else if (table === 'bndy-artists') {
                responses[table] = [mockArtist1, mockArtist2, mockArtist3];
              } else if (table === 'bndy-venues') {
                responses[table] = [mockVenue];
              }
            }
            return Promise.resolve({ Responses: responses });
          }
        }))
      });

      const event = createEvent({ eventIds: ['event-2'] });
      const res = await handleBatchEventsWithJoins(deps, event);
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.events).toHaveLength(1);

      const resultEvent = body.events[0];
      // artistIds should include primary + collaborating
      expect(resultEvent.artistIds).toEqual(['artist-1', 'artist-2', 'artist-3']);
      // artistNames should be parallel array
      expect(resultEvent.artistNames).toEqual(['The Headliners', 'Support Act', 'Guest DJ']);
      // artistName is primary artist only
      expect(resultEvent.artistName).toBe('The Headliners');
    });

    it('returns venueName flat field', async () => {
      const deps = createMockDeps({
        batchGet: jest.fn((params) => ({
          promise: () => {
            const responses = {};
            for (const [table] of Object.entries(params.RequestItems)) {
              if (table === 'bndy-events') {
                responses[table] = [mockEventBasic];
              } else if (table === 'bndy-artists') {
                responses[table] = [mockArtist1];
              } else if (table === 'bndy-venues') {
                responses[table] = [mockVenue];
              }
            }
            return Promise.resolve({ Responses: responses });
          }
        }))
      });

      const event = createEvent({ eventIds: ['event-1'] });
      const res = await handleBatchEventsWithJoins(deps, event);

      const body = JSON.parse(res.body);
      expect(body.events[0].venueName).toBe('The Music Hall');
    });
  });

  describe('Private Fee Fields Stripped', () => {
    it('strips agreedFee, actualFee, datePaid, paymentMethod, splitBetweenMembers, noFee, distributed', async () => {
      const deps = createMockDeps({
        batchGet: jest.fn((params) => ({
          promise: () => {
            const responses = {};
            for (const [table] of Object.entries(params.RequestItems)) {
              if (table === 'bndy-events') {
                responses[table] = [mockEventWithFees];
              } else if (table === 'bndy-artists') {
                responses[table] = [mockArtist1];
              } else if (table === 'bndy-venues') {
                responses[table] = [mockVenue];
              }
            }
            return Promise.resolve({ Responses: responses });
          }
        }))
      });

      const event = createEvent({ eventIds: ['event-3'] });
      const res = await handleBatchEventsWithJoins(deps, event);
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      const resultEvent = body.events[0];

      // All private fee fields should be stripped
      expect(resultEvent.agreedFee).toBeUndefined();
      expect(resultEvent.actualFee).toBeUndefined();
      expect(resultEvent.datePaid).toBeUndefined();
      expect(resultEvent.paymentMethod).toBeUndefined();
      expect(resultEvent.splitBetweenMembers).toBeUndefined();
      expect(resultEvent.noFee).toBeUndefined();
      expect(resultEvent.distributed).toBeUndefined();

      // But public fields remain
      expect(resultEvent.title).toBe('Private Fee Event');
      expect(resultEvent.date).toBe('2026-07-13');
    });
  });

  describe('Nested Objects', () => {
    it('returns nested artist object with expected fields', async () => {
      const deps = createMockDeps({
        batchGet: jest.fn((params) => ({
          promise: () => {
            const responses = {};
            for (const [table] of Object.entries(params.RequestItems)) {
              if (table === 'bndy-events') {
                responses[table] = [mockEventBasic];
              } else if (table === 'bndy-artists') {
                responses[table] = [mockArtist1];
              } else if (table === 'bndy-venues') {
                responses[table] = [mockVenue];
              }
            }
            return Promise.resolve({ Responses: responses });
          }
        }))
      });

      const event = createEvent({ eventIds: ['event-1'] });
      const res = await handleBatchEventsWithJoins(deps, event);

      const body = JSON.parse(res.body);
      const artist = body.events[0].artist;

      expect(artist).toEqual({
        id: 'artist-1',
        name: 'The Headliners',
        genres: ['Rock'],
        profileImageUrl: 'https://example.com/artist1.jpg'
      });
    });

    it('returns nested venue object with expected fields', async () => {
      const deps = createMockDeps({
        batchGet: jest.fn((params) => ({
          promise: () => {
            const responses = {};
            for (const [table] of Object.entries(params.RequestItems)) {
              if (table === 'bndy-events') {
                responses[table] = [mockEventBasic];
              } else if (table === 'bndy-artists') {
                responses[table] = [mockArtist1];
              } else if (table === 'bndy-venues') {
                responses[table] = [mockVenue];
              }
            }
            return Promise.resolve({ Responses: responses });
          }
        }))
      });

      const event = createEvent({ eventIds: ['event-1'] });
      const res = await handleBatchEventsWithJoins(deps, event);

      const body = JSON.parse(res.body);
      const venue = body.events[0].venue;

      expect(venue).toEqual({
        id: 'venue-1',
        name: 'The Music Hall',
        address: '123 Music Street',
        city: 'Manchester',
        latitude: 53.4808,
        longitude: -2.2426,
        standardTicketed: true,
        standardTicketUrl: 'https://tickets.example.com'
      });
    });

    it('returns null artist when artistId is missing', async () => {
      const eventNoArtist = { ...mockEventBasic, artistId: null };
      const deps = createMockDeps({
        batchGet: jest.fn((params) => ({
          promise: () => {
            const responses = {};
            for (const [table] of Object.entries(params.RequestItems)) {
              if (table === 'bndy-events') {
                responses[table] = [eventNoArtist];
              } else if (table === 'bndy-venues') {
                responses[table] = [mockVenue];
              }
            }
            return Promise.resolve({ Responses: responses });
          }
        }))
      });

      const event = createEvent({ eventIds: ['event-1'] });
      const res = await handleBatchEventsWithJoins(deps, event);

      const body = JSON.parse(res.body);
      expect(body.events[0].artist).toBeNull();
    });

    it('returns null venue when venueId is missing', async () => {
      const eventNoVenue = { ...mockEventBasic, venueId: null };
      const deps = createMockDeps({
        batchGet: jest.fn((params) => ({
          promise: () => {
            const responses = {};
            for (const [table] of Object.entries(params.RequestItems)) {
              if (table === 'bndy-events') {
                responses[table] = [eventNoVenue];
              } else if (table === 'bndy-artists') {
                responses[table] = [mockArtist1];
              }
            }
            return Promise.resolve({ Responses: responses });
          }
        }))
      });

      const event = createEvent({ eventIds: ['event-1'] });
      const res = await handleBatchEventsWithJoins(deps, event);

      const body = JSON.parse(res.body);
      expect(body.events[0].venue).toBeNull();
    });
  });

  describe('Multiple Events', () => {
    it('batches multiple events efficiently', async () => {
      const batchGetMock = jest.fn((params) => ({
        promise: () => {
          const responses = {};
          for (const [table] of Object.entries(params.RequestItems)) {
            if (table === 'bndy-events') {
              responses[table] = [mockEventBasic, mockEventWithCollaborators];
            } else if (table === 'bndy-artists') {
              responses[table] = [mockArtist1, mockArtist2, mockArtist3];
            } else if (table === 'bndy-venues') {
              responses[table] = [mockVenue];
            }
          }
          return Promise.resolve({ Responses: responses });
        }
      }));

      const deps = createMockDeps({ batchGet: batchGetMock });
      const event = createEvent({ eventIds: ['event-1', 'event-2'] });

      const res = await handleBatchEventsWithJoins(deps, event);
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.events).toHaveLength(2);
    });
  });

  describe('Ticketing Resolution', () => {
    it('includes ticketing object in response', async () => {
      const deps = createMockDeps({
        batchGet: jest.fn((params) => ({
          promise: () => {
            const responses = {};
            for (const [table] of Object.entries(params.RequestItems)) {
              if (table === 'bndy-events') {
                responses[table] = [mockEventBasic];
              } else if (table === 'bndy-artists') {
                responses[table] = [mockArtist1];
              } else if (table === 'bndy-venues') {
                responses[table] = [mockVenue];
              }
            }
            return Promise.resolve({ Responses: responses });
          }
        }))
      });

      const event = createEvent({ eventIds: ['event-1'] });
      const res = await handleBatchEventsWithJoins(deps, event);

      const body = JSON.parse(res.body);
      expect(body.events[0].ticketing).toBeDefined();
    });
  });
});
