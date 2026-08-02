/**
 * Behavior tests for GET /api/artists: full pagination, stable payload,
 * gzip + Cache-Control.
 */
const zlib = require('zlib');

const mockDynamoDB = { scan: jest.fn(), query: jest.fn(), get: jest.fn(), put: jest.fn(), update: jest.fn(), delete: jest.fn(), batchGet: jest.fn() };

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      scan: (params) => ({ promise: () => mockDynamoDB.scan(params) }),
      query: (params) => ({ promise: () => mockDynamoDB.query(params) }),
      get: (params) => ({ promise: () => mockDynamoDB.get(params) }),
      put: (params) => ({ promise: () => mockDynamoDB.put(params) }),
      update: (params) => ({ promise: () => mockDynamoDB.update(params) }),
      delete: (params) => ({ promise: () => mockDynamoDB.delete(params) }),
      batchGet: (params) => ({ promise: () => mockDynamoDB.batchGet(params) })
    }))
  },
  SSM: jest.fn(() => ({ getParameter: () => ({ promise: () => Promise.resolve({ Parameter: { Value: 's' } }) }) })),
  S3: jest.fn(() => ({ putObject: () => ({ promise: () => Promise.resolve({}) }) })),
  Lambda: jest.fn(() => ({ invoke: () => ({ promise: () => Promise.resolve({ Payload: '{}' }) }) }))
}));

const { handler } = require('./handler');

const artist = (i) => ({ id: `ar-${i}`, name: `Artist ${i}`, bio: 'long bio text', genres: ['rock'], profileImageUrl: 'https://x/y.jpg' });

const listEvent = {
  requestContext: { http: { method: 'GET', path: '/api/artists' } },
  headers: { origin: 'https://live.bndy.co.uk', 'accept-encoding': 'gzip' }
};

function decodeBody(res) {
  if (res.isBase64Encoded) return JSON.parse(zlib.gunzipSync(Buffer.from(res.body, 'base64')).toString());
  return JSON.parse(res.body);
}

describe('GET /api/artists', () => {
  beforeEach(() => jest.clearAllMocks());

  it('paginates the scan (fixes silent 1MB truncation at ~1,700 artists)', async () => {
    mockDynamoDB.scan
      .mockResolvedValueOnce({ Items: [artist(1), artist(2)], LastEvaluatedKey: { id: 'ar-2' } })
      .mockResolvedValueOnce({ Items: [artist(3)] });
    const res = await handler(listEvent, {});
    expect(res.statusCode).toBe(200);
    expect(mockDynamoDB.scan).toHaveBeenCalledTimes(2);
    expect(mockDynamoDB.scan.mock.calls[1][0].ExclusiveStartKey).toEqual({ id: 'ar-2' });
    expect(decodeBody(res)).toHaveLength(3);
  });


  it('keeps the response shape (bio present as empty string)', async () => {
    mockDynamoDB.scan.mockResolvedValueOnce({ Items: [{ id: 'ar-1', name: 'A' }] });
    const body = decodeBody(await handler(listEvent, {}));
    expect(body[0]).toHaveProperty('bio', '');
    expect(body[0].name).toBe('A');
  });

  it('gzips large responses and keeps Cache-Control', async () => {
    mockDynamoDB.scan.mockResolvedValueOnce({ Items: Array.from({ length: 50 }, (_, i) => artist(i)) });
    const res = await handler(listEvent, {});
    expect(res.headers['Cache-Control']).toMatch(/max-age=/);
    expect(res.headers['Content-Encoding']).toBe('gzip');
    expect(decodeBody(res)).toHaveLength(50);
  });

  it('returns plain JSON when gzip not accepted', async () => {
    mockDynamoDB.scan.mockResolvedValueOnce({ Items: [artist(1)] });
    const res = await handler({ ...listEvent, headers: { origin: 'https://live.bndy.co.uk' } }, {});
    expect(res.isBase64Encoded).toBeUndefined();
    expect(JSON.parse(res.body)).toHaveLength(1);
  });
});
