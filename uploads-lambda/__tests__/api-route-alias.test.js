/**
 * Uploads Lambda - API Route Alias Tests
 *
 * Tests that both legacy /uploads/* paths and new /api/uploads/* paths
 * hit identical handler logic, validation and response behaviour.
 * Required for bndy.live same-origin auth.
 *
 * CloudFront on bndy.live routes /api/* to API Gateway.
 * backstage.bndy.co.uk uses legacy /uploads/* paths.
 * Both must work identically.
 */

process.env.JWT_SECRET = 'test-jwt-secret';

const mockS3 = {
  createPresignedPost: jest.fn(),
  getSignedUrl: jest.fn()
};

const mockDynamoDB = {
  get: jest.fn()
};

jest.mock('aws-sdk', () => ({
  S3: jest.fn(() => ({
    createPresignedPost: (params, callback) => mockS3.createPresignedPost(params, callback),
    getSignedUrl: (operation, params) => mockS3.getSignedUrl(operation, params)
  })),
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (params) => ({ promise: () => mockDynamoDB.get(params) })
    }))
  },
  SSM: jest.fn(() => ({
    getParameter: () => ({
      promise: () => Promise.resolve({ Parameter: { Value: 'test-jwt-secret' } })
    })
  }))
}));

const jwt = require('jsonwebtoken');
const { handler } = require('../handler');

const createSessionToken = (userId = 'test-user-id') =>
  jwt.sign({ userId, email: 'test@example.com', username: 'testuser' }, 'test-jwt-secret', {
    expiresIn: '90d'
  });

const makeEvent = (method, path, token = null, body = null) => ({
  requestContext: { http: { method, path } },
  cookies: token ? [`bndy_session=${token}`] : [],
  headers: {},
  body: body ? JSON.stringify(body) : null
});

describe('API route alias - /api/uploads/* normalization', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Mock S3 presigned post
    mockS3.createPresignedPost.mockImplementation((params, callback) => {
      callback(null, {
        url: 'https://bndy-images.s3.eu-west-2.amazonaws.com',
        fields: {
          key: params.Fields?.key || 'uploads/test-key.jpg',
          'Content-Type': 'image/jpeg',
          Policy: 'test-policy',
          'X-Amz-Signature': 'test-signature'
        }
      });
    });

    // Mock S3 getSignedUrl
    mockS3.getSignedUrl.mockReturnValue('https://bndy-images.s3.eu-west-2.amazonaws.com/signed-url');

    // Mock user lookup (staff role for upload permission)
    mockDynamoDB.get.mockResolvedValue({
      Item: { cognito_id: 'test-user-id', role: 'staff' }
    });
  });

  describe('path normalization - identical handler logic', () => {
    const uploadBody = {
      fileName: 'test-image.jpg',
      contentType: 'image/jpeg',
      entity: 'artist',
      entityId: 'artist-123'
    };

    it('POST /uploads/presigned-url returns presigned URL', async () => {
      const token = createSessionToken();
      const event = makeEvent('POST', '/uploads/presigned-url', token, uploadBody);

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.uploadUrl).toBeDefined();
      expect(body.publicUrl).toBeDefined();
      expect(body.key).toBeDefined();
    });

    it('POST /api/uploads/presigned-url returns presigned URL', async () => {
      const token = createSessionToken();
      const event = makeEvent('POST', '/api/uploads/presigned-url', token, uploadBody);

      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.uploadUrl).toBeDefined();
      expect(body.publicUrl).toBeDefined();
      expect(body.key).toBeDefined();
    });

    it('both paths return identical status codes', async () => {
      const token = createSessionToken();

      const legacyRes = await handler(makeEvent('POST', '/uploads/presigned-url', token, uploadBody));
      const aliasRes = await handler(makeEvent('POST', '/api/uploads/presigned-url', token, uploadBody));

      expect(aliasRes.statusCode).toBe(legacyRes.statusCode);
    });

    it('both paths call S3 with same parameters', async () => {
      const token = createSessionToken();

      await handler(makeEvent('POST', '/uploads/presigned-url', token, uploadBody));
      const legacyCalls = [...mockS3.getSignedUrl.mock.calls];

      mockS3.getSignedUrl.mockClear();

      await handler(makeEvent('POST', '/api/uploads/presigned-url', token, uploadBody));
      const aliasCalls = [...mockS3.getSignedUrl.mock.calls];

      expect(aliasCalls.length).toBe(legacyCalls.length);
      // Operation should match (putObject)
      expect(aliasCalls[0][0]).toBe(legacyCalls[0][0]);
      // Bucket should match
      expect(aliasCalls[0][1].Bucket).toBe(legacyCalls[0][1].Bucket);
    });
  });

  describe('validation behaviour - identical for both paths', () => {
    it('both paths reject unauthenticated requests with 401', async () => {
      const body = { fileName: 'test.jpg', contentType: 'image/jpeg' };

      const legacyRes = await handler(makeEvent('POST', '/uploads/presigned-url', null, body));
      const aliasRes = await handler(makeEvent('POST', '/api/uploads/presigned-url', null, body));

      expect(legacyRes.statusCode).toBe(401);
      expect(aliasRes.statusCode).toBe(401);
    });

    it('both paths validate required fields identically', async () => {
      const token = createSessionToken();
      const incompleteBody = { fileName: 'test.jpg' }; // missing contentType

      const legacyRes = await handler(makeEvent('POST', '/uploads/presigned-url', token, incompleteBody));
      const aliasRes = await handler(makeEvent('POST', '/api/uploads/presigned-url', token, incompleteBody));

      // Both should return same status (400 for validation error or 200 if optional)
      expect(aliasRes.statusCode).toBe(legacyRes.statusCode);
    });
  });

  describe('response behaviour - identical for both paths', () => {
    it('both paths return same response structure', async () => {
      const token = createSessionToken();
      const body = {
        fileName: 'test-image.jpg',
        contentType: 'image/jpeg',
        entity: 'artist',
        entityId: 'artist-123'
      };

      const legacyRes = await handler(makeEvent('POST', '/uploads/presigned-url', token, body));
      const aliasRes = await handler(makeEvent('POST', '/api/uploads/presigned-url', token, body));

      const legacyBody = JSON.parse(legacyRes.body);
      const aliasBody = JSON.parse(aliasRes.body);

      // Both should have same keys
      expect(Object.keys(aliasBody).sort()).toEqual(Object.keys(legacyBody).sort());
    });
  });

  describe('edge cases', () => {
    it('404 for unknown route on legacy path', async () => {
      const response = await handler(makeEvent('GET', '/uploads/unknown'));
      expect(response.statusCode).toBe(404);
    });

    it('404 for unknown route on /api path', async () => {
      const response = await handler(makeEvent('GET', '/api/uploads/unknown'));
      expect(response.statusCode).toBe(404);
    });

    it('does not normalize paths that only start with /apiuploads (no slash)', async () => {
      const response = await handler(makeEvent('POST', '/apiuploads/presigned-url'));
      expect(response.statusCode).toBe(404);
    });
  });
});
