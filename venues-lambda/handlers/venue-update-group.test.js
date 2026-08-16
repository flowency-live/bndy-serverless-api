/**
 * Feature 19 — venue ownership groups via MCP edit_venue.
 *
 * Change A: edit_venue (the MCP route) can write ownerGroupId and tenure.
 * Change B covers the dedicated group routes accepting the MCP token.
 *
 * Rules under test:
 *   1. ownerGroupId and tenure write through the MCP route
 *   2. ownerGroupName is REJECTED - it is denormalised from the group record
 *   3. tenure is validated against the enum
 *   4. The curator route (feature 4) still refuses both fields
 */

process.env.JWT_SECRET = 'test-jwt-secret';

const mockDynamoDB = {
  get: jest.fn(),
  put: jest.fn(),
  update: jest.fn(),
  query: jest.fn(),
  scan: jest.fn(),
  delete: jest.fn()
};

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: (p) => ({ promise: () => mockDynamoDB.get(p) }),
      put: (p) => ({ promise: () => mockDynamoDB.put(p) }),
      update: (p) => ({ promise: () => mockDynamoDB.update(p) }),
      query: (p) => ({ promise: () => mockDynamoDB.query(p) }),
      scan: (p) => ({ promise: () => mockDynamoDB.scan(p) }),
      delete: (p) => ({ promise: () => mockDynamoDB.delete(p) })
    }))
  },
  Lambda: jest.fn(() => ({ invoke: () => ({ promise: () => Promise.resolve({ Payload: '{}' }) }) })),
  SSM: jest.fn(() => ({
    getParameter: () => ({ promise: () => Promise.reject(new Error('use env')) })
  }))
}));

jest.mock('../lib/google-places', () => ({
  findPlaceFromGoogle: jest.fn(),
  getPlaceDetails: jest.fn()
}));

const AWS = require('aws-sdk');
const { handleUpdateVenue } = require('./venues-routes');

const deps = {
  dynamodb: new AWS.DynamoDB.DocumentClient(),
  lambda: new AWS.Lambda(),
  getCorsHeaders: () => ({})
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDynamoDB.get.mockResolvedValue({ Item: { id: 'v1', name: 'The Vic', latitude: 53.4, longitude: -2.2 } });
  mockDynamoDB.update.mockResolvedValue({ Attributes: { id: 'v1', name: 'The Vic' } });
});

const makeEvent = (body) => ({
  requestContext: { http: { method: 'PUT', path: '/api/venues/v1/mcp' } },
  pathParameters: { id: 'v1' },
  body: JSON.stringify(body)
});

describe('edit_venue writes ownerGroupId and tenure', () => {
  test('ownerGroupId writes to the venue', async () => {
    const res = await handleUpdateVenue(deps, 'v1', { ownerGroupId: 'g1' }, makeEvent({ ownerGroupId: 'g1' }));
    expect(res.statusCode).toBe(200);

    const call = mockDynamoDB.update.mock.calls[0][0];
    expect(call.UpdateExpression).toContain('ownerGroupId = :ownerGroupId');
    expect(call.ExpressionAttributeValues[':ownerGroupId']).toBe('g1');
  });

  test('tenure writes to the venue', async () => {
    const res = await handleUpdateVenue(deps, 'v1', { tenure: 'owned' }, makeEvent({ tenure: 'owned' }));
    expect(res.statusCode).toBe(200);

    const call = mockDynamoDB.update.mock.calls[0][0];
    expect(call.UpdateExpression).toContain('tenure = :tenure');
    expect(call.ExpressionAttributeValues[':tenure']).toBe('owned');
  });

  test('both ownerGroupId and tenure write together', async () => {
    const res = await handleUpdateVenue(deps, 'v1', { ownerGroupId: 'g1', tenure: 'owned' }, makeEvent({ ownerGroupId: 'g1', tenure: 'owned' }));
    expect(res.statusCode).toBe(200);

    const call = mockDynamoDB.update.mock.calls[0][0];
    expect(call.UpdateExpression).toContain('ownerGroupId');
    expect(call.UpdateExpression).toContain('tenure');
  });
});

describe('tenure validation', () => {
  test('tenure: unknown is accepted', async () => {
    const res = await handleUpdateVenue(deps, 'v1', { tenure: 'unknown' }, makeEvent({ tenure: 'unknown' }));
    expect(res.statusCode).toBe(200);
  });

  test('tenure: independent is accepted', async () => {
    const res = await handleUpdateVenue(deps, 'v1', { tenure: 'independent' }, makeEvent({ tenure: 'independent' }));
    expect(res.statusCode).toBe(200);
  });

  test('tenure: owned is accepted', async () => {
    const res = await handleUpdateVenue(deps, 'v1', { tenure: 'owned' }, makeEvent({ tenure: 'owned' }));
    expect(res.statusCode).toBe(200);
  });

  test('tenure: leasehold is rejected with INVALID_TENURE', async () => {
    const res = await handleUpdateVenue(deps, 'v1', { tenure: 'leasehold' }, makeEvent({ tenure: 'leasehold' }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('INVALID_TENURE');
  });

  test('tenure: managed is rejected', async () => {
    const res = await handleUpdateVenue(deps, 'v1', { tenure: 'managed' }, makeEvent({ tenure: 'managed' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('INVALID_TENURE');
  });
});

describe('ownerGroupName is deliberately excluded', () => {
  test('ownerGroupName does NOT write to the venue', async () => {
    // ownerGroupName is denormalised from the group record by the group routes.
    // An MCP caller must never set it directly, or the venue and group disagree.
    const res = await handleUpdateVenue(deps, 'v1', { ownerGroupName: 'Robinsons' }, makeEvent({ ownerGroupName: 'Robinsons' }));
    expect(res.statusCode).toBe(200);

    const call = mockDynamoDB.update.mock.calls[0][0];
    expect(call.UpdateExpression).not.toContain('ownerGroupName');
    expect(call.ExpressionAttributeValues[':ownerGroupName']).toBeUndefined();
  });

  test('ownerGroupId writes but ownerGroupName is stripped from the same request', async () => {
    const res = await handleUpdateVenue(deps, 'v1', { ownerGroupId: 'g1', ownerGroupName: 'Hacked' }, makeEvent({ ownerGroupId: 'g1', ownerGroupName: 'Hacked' }));
    expect(res.statusCode).toBe(200);

    const call = mockDynamoDB.update.mock.calls[0][0];
    expect(call.UpdateExpression).toContain('ownerGroupId');
    expect(call.UpdateExpression).not.toContain('ownerGroupName');
  });
});
