/**
 * Location Resolution Tests (Work Order 2026-08-30)
 *
 * Tests for artist identity: name + location
 * - Same name, same region → matched
 * - Same name, different region → review with locationConflict
 * - Same name, missing location on either side → review
 */

const { areLocationsCompatible, calculateLocationScore, areRegionsAdjacent } = require('./location-resolution');

describe('areLocationsCompatible', () => {
  describe('Lincolnshire is one region (Backline finding 06/09/2026)', () => {
    it.each([
      ['Grimsby', 'Lincolnshire'],
      ['Lincoln', 'Grimsby'],
      ['Market Rasen', 'Lincolnshire'],
      ['Skegness', 'Lincoln'],
      ['Barton upon Humber', 'Lincolnshire'],
      ['Spalding', 'Louth'],
      ['Gainsborough', 'Lincoln'],
    ])('%s and %s are compatible', (a, b) => {
      expect(areLocationsCompatible(a, b).compatible).toBe(true);
    });

    it('keeps Peterborough out of Lincolnshire', () => {
      expect(areLocationsCompatible('Peterborough', 'Lincolnshire').compatible).toBe(false);
    });
  });

  describe('national acts', () => {
    it.each(['UK wide', 'UK touring', 'National'])('%s is compatible with any resolvable region', (national) => {
      const result = areLocationsCompatible('Staffordshire', national);
      expect(result.compatible).toBe(true);
      expect(result.reason).toBe('national');
      expect(calculateLocationScore(result)).toBe(1);
    });
  });

  describe('same region', () => {
    it('returns compatible when both locations resolve to same region', () => {
      // Essex and Southend both map to 'east' region
      const result = areLocationsCompatible('Essex', 'Southend');
      expect(result.compatible).toBe(true);
      expect(result.inputRegion).toBe('east');
      expect(result.candidateRegion).toBe('east');
    });

    it('returns compatible when exact same location string', () => {
      const result = areLocationsCompatible('Staffordshire', 'Staffordshire');
      expect(result.compatible).toBe(true);
    });
  });

  describe('different region', () => {
    it('returns incompatible when locations resolve to different regions', () => {
      // Essex → 'east', Newcastle → 'north-east'
      const result = areLocationsCompatible('Essex', 'Newcastle');
      expect(result.compatible).toBe(false);
      expect(result.inputRegion).toBe('east');
      expect(result.candidateRegion).toBe('north-east');
    });

    it('returns incompatible for clearly different regions', () => {
      const result = areLocationsCompatible('Manchester', 'Bristol');
      expect(result.compatible).toBe(false);
    });
  });

  describe('missing location', () => {
    it('returns unknown when input location is missing', () => {
      const result = areLocationsCompatible('', 'Essex');
      expect(result.compatible).toBe(false);
      expect(result.reason).toBe('input_missing');
    });

    it('returns unknown when candidate location is missing', () => {
      const result = areLocationsCompatible('Essex', '');
      expect(result.compatible).toBe(false);
      expect(result.reason).toBe('candidate_missing');
    });

    it('returns unknown when both locations are missing', () => {
      const result = areLocationsCompatible('', '');
      expect(result.compatible).toBe(false);
      expect(result.reason).toBe('both_missing');
    });

    it('treats undefined as missing', () => {
      const result = areLocationsCompatible(undefined, 'Essex');
      expect(result.compatible).toBe(false);
      expect(result.reason).toBe('input_missing');
    });
  });
});

describe('calculateLocationScore', () => {
  it('returns 1.0 for compatible locations', () => {
    const compat = { compatible: true };
    expect(calculateLocationScore(compat)).toBe(1.0);
  });

  it('returns 0.5 when candidate has no location', () => {
    const compat = { compatible: false, reason: 'candidate_missing' };
    expect(calculateLocationScore(compat)).toBe(0.5);
  });

  it('returns 0.5 when input has no location', () => {
    const compat = { compatible: false, reason: 'input_missing' };
    expect(calculateLocationScore(compat)).toBe(0.5);
  });

  it('returns 0.0 for location conflict', () => {
    const compat = { compatible: false, reason: undefined };
    expect(calculateLocationScore(compat)).toBe(0.0);
  });
});

describe('areRegionsAdjacent (owner ruling 06/09/2026: a unique name in a neighbouring region matches)', () => {
  it.each([
    ['west-midlands', 'north-west', true],
    ['west-midlands', 'east-midlands', true],
    ['north-west', 'yorkshire', true],
    ['east-midlands', 'east', true],
    ['west-midlands', 'scotland', false],
    ['east-midlands', 'wales', false],
    ['london', 'north-east', false],
    ['west-midlands', 'west-midlands', true],
    ['unknown', 'west-midlands', false],
  ])('%s next to %s is %s', (a, b, expected) => {
    expect(areRegionsAdjacent(a, b)).toBe(expected);
  });
});
