'use strict';

jest.mock('aws-sdk', () => ({
  DynamoDB: { DocumentClient: jest.fn(() => ({})) },
  SSM: jest.fn(() => ({}))
}));

const {
  toApiCuratorAccess,
  validateCuratorAccess,
  postcodeParts,
  postcodeAllowed
} = require('../lib/godmode-access');

describe('curator access policy', () => {
  test('missing stored policy preserves historical unrestricted behaviour', () => {
    expect(toApiCuratorAccess(undefined)).toEqual({
      scope: 'global', postcodePrefixes: [], ownRecordsOnly: false
    });
  });

  test('normalises postcode areas and districts', () => {
    const checked = validateCuratorAccess({
      scope: 'postcode',
      postcodePrefixes: [' st ', 'st5', 'CW 12', 'st5'],
      ownRecordsOnly: true
    });
    expect(checked.error).toBeUndefined();
    expect(toApiCuratorAccess(checked.value)).toEqual({
      scope: 'postcode', postcodePrefixes: ['ST', 'ST5', 'CW12'], ownRecordsOnly: true
    });
  });

  test('postcode scope requires at least one area or district', () => {
    expect(validateCuratorAccess({ scope: 'postcode', postcodePrefixes: [], ownRecordsOnly: false }).error).toMatch(/At least one/);
  });

  test('rejects values that are not a UK postcode area/district token', () => {
    expect(validateCuratorAccess({ scope: 'postcode', postcodePrefixes: ['ST5 1AB'], ownRecordsOnly: false }).error).toMatch(/Invalid postcode/);
  });

  test('district matching is exact so ST1 does not grant ST10', () => {
    const access = { scope: 'postcode', postcodePrefixes: ['ST1'], ownRecordsOnly: false };
    expect(postcodeAllowed(access, 'ST1 5AA')).toBe(true);
    expect(postcodeAllowed(access, 'ST10 1AA')).toBe(false);
  });

  test('area matching deliberately grants every district in that area', () => {
    const access = { scope: 'postcode', postcodePrefixes: ['ST'], ownRecordsOnly: false };
    expect(postcodeAllowed(access, 'ST1 5AA')).toBe(true);
    expect(postcodeAllowed(access, 'ST10 1AA')).toBe(true);
    expect(postcodeAllowed(access, 'CW12 3AA')).toBe(false);
  });

  test('parses compact and spaced full postcodes to the same outward code', () => {
    expect(postcodeParts('ST5 1AB')).toEqual({ outward: 'ST5', area: 'ST' });
    expect(postcodeParts('ST51AB')).toEqual({ outward: 'ST5', area: 'ST' });
  });
});
