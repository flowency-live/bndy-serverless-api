process.env.JWT_SECRET = 'owned-profile-test-secret';

const mockDynamoDB = {
  query: jest.fn(),
  get: jest.fn(),
  update: jest.fn(),
  put: jest.fn(),
  scan: jest.fn()
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      get: (params) => ({ promise: () => mockDynamoDB.get(params) }),
      update: (params) => ({ promise: () => mockDynamoDB.update(params) }),
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      scan: (params) => ({ promise: () => mockDynamoDB.scan(params) })
    }))
  },
  S3: jest.fn(() => ({})),
  SSM: jest.fn(() => ({
    getParameter: () => ({ promise: () => Promise.reject(new Error('not used')) })
  }))
}));

const jwt = require('jsonwebtoken');
const { handler } = require('./handler');

function request(body, userId = 'user-1') {
  return {
    requestContext: { http: { method: 'PATCH', path: '/api/artists/artist-1/profile' } },
    pathParameters: { id: 'artist-1' },
    body: JSON.stringify(body),
    headers: {
      origin: 'https://www.bndy.co.uk',
      Cookie: `bndy_session=${jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '1h' })}`
    }
  };
}

describe('PATCH /api/artists/{id}/profile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDynamoDB.get.mockImplementation((params) => {
      if (params.TableName === 'bndy-users') {
        return Promise.resolve({ Item: { cognito_id: 'user-1', platformAdmin: false } });
      }
      if (params.TableName === 'bndy-artists') {
        return Promise.resolve({ Item: {
          id: 'artist-1',
          name: 'Test Artist',
          publicationScopes: ['live'],
          publishAvailability: false,
          contactMethod: 'whatsapp',
          phoneNumber: '+441234567890',
          whatsappNumber: '+447700900000',
          availabilityMessage: 'Please contact us anyway.'
        } });
      }
      return Promise.resolve({ Item: null });
    });
    mockDynamoDB.update.mockResolvedValue({
      Attributes: { id: 'artist-1', name: 'Test Artist', youtubeUrl: 'https://youtu.be/abcdefghijk' }
    });
  });

  test.each(['owner', 'admin'])('allows an active %s to update whitelisted media', async (role) => {
    mockDynamoDB.query.mockResolvedValue({
      Items: [{ artist_id: 'artist-1', user_id: 'user-1', role, status: 'active' }]
    });

    const result = await handler(request({
      youtubeUrl: 'https://youtu.be/abcdefghijk',
      hidden: true,
      name: 'Attempted rename'
    }), {});

    expect(result.statusCode).toBe(200);
    const update = mockDynamoDB.update.mock.calls[0][0];
    expect(update.ExpressionAttributeValues[':youtubeUrl']).toBe('https://youtu.be/abcdefghijk');
    expect(update.ExpressionAttributeValues[':hidden']).toBeUndefined();
    expect(update.ExpressionAttributeValues[':name']).toBeUndefined();
  });

  test.each(['staff', 'curator'])('allows an unrestricted %s to manage availability without artist membership', async (role) => {
    mockDynamoDB.get.mockImplementation((params) => {
      if (params.TableName === 'bndy-users') {
        return Promise.resolve({ Item: { cognito_id: 'user-1', platformAdmin: false, role } });
      }
      return Promise.resolve({ Item: { id: 'artist-1', name: 'Test Artist', publicationScopes: ['live'] } });
    });

    const result = await handler(request({ availabilityMessage: '  Contact us anyway.  ' }), {});

    expect(result.statusCode).toBe(200);
    expect(mockDynamoDB.update.mock.calls[0][0].ExpressionAttributeValues[':availabilityMessage']).toBe('Contact us anyway.');
    expect(mockDynamoDB.query).not.toHaveBeenCalled();
  });

  test('keeps a restricted curator inside the existing artist policy', async () => {
    mockDynamoDB.get.mockImplementation((params) => {
      if (params.TableName === 'bndy-users') {
        return Promise.resolve({ Item: {
          cognito_id: 'user-1',
          role: 'curator',
          curator_access: { scope: 'postcode', postcode_prefixes: ['ST'] }
        } });
      }
      if (params.TableName === 'bndy-artists') {
        return Promise.resolve({ Item: { id: 'artist-1', name: 'Test Artist', createdBy: 'someone-else', publicationScopes: ['live'] } });
      }
      return Promise.resolve({ Item: null });
    });
    mockDynamoDB.query.mockResolvedValue({ Items: [] });

    const result = await handler(request({ availabilityMessage: 'Not allowed' }), {});

    expect(result.statusCode).toBe(403);
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });

  test.each([
    { role: 'member', status: 'active' },
    { role: 'owner', status: 'revoked' }
  ])('rejects a relationship without management authority: %o', async (membership) => {
    mockDynamoDB.query.mockResolvedValue({
      Items: [{ artist_id: 'artist-1', user_id: 'user-1', ...membership }]
    });

    const result = await handler(request({ bio: 'Updated bio' }), {});

    expect(result.statusCode).toBe(403);
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });

  test('rejects a provider lookalike URL', async () => {
    mockDynamoDB.query.mockResolvedValue({
      Items: [{ artist_id: 'artist-1', user_id: 'user-1', role: 'owner', status: 'active' }]
    });

    const result = await handler(request({ spotifyUrl: 'https://open.spotify.com.example.org/artist/123' }), {});

    expect(result.statusCode).toBe(400);
    expect(mockDynamoDB.update).not.toHaveBeenCalled();
  });

  test('redacts unpublished booking contact from the public artist read', async () => {
    const result = await handler({
      requestContext: { http: { method: 'GET', path: '/api/artists/artist-1' } },
      pathParameters: { id: 'artist-1' },
      headers: { origin: 'https://www.bndy.co.uk' }
    }, {});

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ phoneNumber: null, whatsappNumber: null, availabilityMessage: null });
  });

  test('returns private booking settings to an active owner through the profile read', async () => {
    mockDynamoDB.query.mockResolvedValue({
      Items: [{ artist_id: 'artist-1', user_id: 'user-1', role: 'owner', status: 'active' }]
    });
    const event = request({});
    event.requestContext.http.method = 'GET';
    event.requestContext.http.path = '/api/artists/artist-1/profile';
    delete event.body;

    const result = await handler(event, {});

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      phoneNumber: '+441234567890',
      whatsappNumber: '+447700900000',
      availabilityMessage: 'Please contact us anyway.'
    });
  });
});
