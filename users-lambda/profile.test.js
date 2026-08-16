/**
 * Users Lambda - profile and saved gig-filter contract tests.
 */

process.env.JWT_SECRET = 'test-jwt-secret';

const mockDynamoDB = {
  get: jest.fn(),
  put: jest.fn(),
  scan: jest.fn(),
  query: jest.fn(),
  delete: jest.fn(),
  update: jest.fn()
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (params) => ({ promise: () => mockDynamoDB.get(params) }),
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      scan: (params) => ({ promise: () => mockDynamoDB.scan(params) }),
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      delete: (params) => ({ promise: () => mockDynamoDB.delete(params) }),
      update: (params) => ({ promise: () => mockDynamoDB.update(params) })
    }))
  },
  SSM: jest.fn(() => ({
    getParameter: () => ({
      promise: () => Promise.resolve({ Parameter: { Value: 'test-jwt-secret' } })
    })
  }))
}));

const jwt = require('jsonwebtoken');
const { handler } = require('./handler');

const createSessionToken = (userId = 'test-user-id') =>
  jwt.sign({ userId, email: 'test@example.com', username: 'testuser' }, 'test-jwt-secret', {
    expiresIn: '90d'
  });

const makeEvent = (method, path, body) => ({
  requestContext: { http: { method, path } },
  cookies: [`bndy_session=${createSessionToken()}`],
  headers: {},
  body: body === undefined ? undefined : JSON.stringify(body)
});

const baseUser = () => ({
  user_id: 'user-record-id',
  cognito_id: 'test-user-id',
  email: 'test@example.com',
  username: 'testuser',
  first_name: 'Test',
  last_name: 'Person',
  display_name: 'Test Person',
  hometown: 'Northwich',
  avatar_url: 'https://example.com/avatar.jpg',
  instrument: 'Guitar',
  profile_complete: true,
  role: 'user',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z'
});

describe('GET /users/profile gigFilter', () => {
  beforeEach(() => jest.clearAllMocks());

  test('exposes the empty rollout-safe default when no filter is stored', async () => {
    mockDynamoDB.get.mockResolvedValue({ Item: baseUser() });

    const response = await handler(makeEvent('GET', '/users/profile'), {});
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.user).toEqual(expect.objectContaining({
      displayName: 'Test Person',
      hometown: 'Northwich',
      gigFilter: { genres: [], actTypes: [], includeOpenMic: false, enabled: false }
    }));
  });

  test('returns a previously stored filter and safely normalises malformed stored members', async () => {
    mockDynamoDB.get.mockResolvedValue({
      Item: {
        ...baseUser(),
        gig_filter: {
          genres: [' Rock ', null, '', 'Indie', 'Rock'],
          actTypes: ['Covers', 'unknown', 42, 'tribute act'],
          includeOpenMic: true,
          enabled: true
        }
      }
    });

    const response = await handler(makeEvent('GET', '/users/profile'), {});
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).user.gigFilter).toEqual({
      genres: ['Rock', 'Indie'],
      actTypes: ['covers', 'tribute'],
      includeOpenMic: true,
      enabled: true
    });
  });
});

describe('PUT /users/profile gigFilter', () => {
  let storedUser;

  beforeEach(() => {
    jest.clearAllMocks();
    storedUser = baseUser();
    mockDynamoDB.get.mockImplementation(async () => ({ Item: { ...storedUser } }));
    mockDynamoDB.update.mockImplementation(async (params) => {
      if (params.ExpressionAttributeValues[':gigFilter']) {
        storedUser = {
          ...storedUser,
          gig_filter: params.ExpressionAttributeValues[':gigFilter'],
          updated_at: params.ExpressionAttributeValues[':updatedAt']
        };
      }
      return { Attributes: { ...storedUser } };
    });
  });

  test('saves both requested payload examples, normalises labels, and survives GET', async () => {
    const examples = [
      {
        input: {
          genres: ['Rock', 'Indie', 'Britpop'],
          actTypes: ['Covers'],
          includeOpenMic: false,
          enabled: true
        },
        storedActTypes: ['covers']
      },
      {
        input: {
          genres: ['Folk', 'Country'],
          actTypes: ['Acoustic'],
          includeOpenMic: true,
          enabled: true
        },
        storedActTypes: ['acoustic']
      }
    ];

    for (const example of examples) {
      const before = { ...storedUser };
      const putResponse = await handler(
        makeEvent('PUT', '/users/profile', { gigFilter: example.input }),
        {}
      );
      const putBody = JSON.parse(putResponse.body);

      expect(putResponse.statusCode).toBe(200);
      expect(putBody.user.gigFilter).toEqual({
        ...example.input,
        actTypes: example.storedActTypes
      });
      expect(storedUser).toEqual(expect.objectContaining({
        first_name: before.first_name,
        last_name: before.last_name,
        display_name: before.display_name,
        hometown: before.hometown,
        avatar_url: before.avatar_url,
        instrument: before.instrument,
        profile_complete: before.profile_complete
      }));

      const getResponse = await handler(makeEvent('GET', '/users/profile'), {});
      expect(getResponse.statusCode).toBe(200);
      expect(JSON.parse(getResponse.body).user.gigFilter).toEqual({
        ...example.input,
        actTypes: example.storedActTypes
      });
    }

    for (const params of mockDynamoDB.update.mock.calls.map(([value]) => value)) {
      expect(params.UpdateExpression).toBe('SET gig_filter = :gigFilter, updated_at = :updatedAt');
      expect(Object.keys(params.ExpressionAttributeValues).sort()).toEqual([':gigFilter', ':updatedAt']);
    }
  });

  test.each([
    null,
    { genres: 'Rock', actTypes: [], includeOpenMic: false, enabled: true },
    { genres: [], actTypes: ['karaoke'], includeOpenMic: false, enabled: true },
    { genres: [], actTypes: [], includeOpenMic: 'yes', enabled: true }
  ])('rejects malformed or unknown filter values without writing: %p', async (gigFilter) => {
    const response = await handler(makeEvent('PUT', '/users/profile', { gigFilter }), {});
    expect(response.statusCode).toBe(400);
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });

  test('rejects an unknown-only profile payload instead of blanking profile fields', async () => {
    const response = await handler(makeEvent('PUT', '/users/profile', { gigFilters: {} }), {});
    expect(response.statusCode).toBe(400);
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });

  test('keeps a stored gigFilter visible after an ordinary profile update', async () => {
    storedUser.gig_filter = {
      genres: ['Rock'],
      actTypes: ['covers'],
      includeOpenMic: false,
      enabled: true
    };
    mockDynamoDB.update.mockResolvedValue({
      Attributes: {
        ...storedUser,
        first_name: 'Updated',
        display_name: 'Updated Person'
      }
    });

    const response = await handler(makeEvent('PUT', '/users/profile', {
      firstName: 'Updated',
      lastName: 'Person',
      displayName: 'Updated Person',
      hometown: 'Northwich',
      avatarUrl: storedUser.avatar_url,
      instrument: storedUser.instrument
    }), {});

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).user.gigFilter).toEqual(storedUser.gig_filter);
    expect(mockDynamoDB.update.mock.calls[0][0].UpdateExpression).not.toContain('gig_filter');
  });
});
