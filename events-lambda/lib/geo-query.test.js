const { parseBbox, validateDateWindow, planBboxQuery, estimateCells, GH6_MAX_CELLS, GH4_MAX_CELLS, GH6_INDEX, GH4_INDEX } = require('./geo-query');

describe('parseBbox', () => {
  it('parses a valid bbox', () => {
    expect(parseBbox('-2.3,52.9,-1.9,53.2').bbox).toEqual({ west: -2.3, south: 52.9, east: -1.9, north: 53.2 });
  });
  it.each([
    ['', 'empty'],
    ['-2.3,52.9,-1.9', 'three parts'],
    ['-2.3,52.9,-1.9,nope', 'non-numeric'],
    ['-1.9,52.9,-2.3,53.2', 'west >= east'],
    ['-2.3,53.2,-1.9,52.9', 'south >= north'],
    ['-200,52.9,-1.9,53.2', 'lng out of range'],
    ['-2.3,52.9,-1.9,95', 'lat out of range'],
  ])('rejects %s (%s)', (raw) => {
    expect(parseBbox(raw).error).toBeDefined();
  });
});

describe('validateDateWindow', () => {
  it('accepts a valid window', () => {
    expect(validateDateWindow('2026-07-11', '2026-08-11')).toEqual({});
  });
  it('rejects missing/malformed dates', () => {
    expect(validateDateWindow(undefined, '2026-08-11').error).toBeDefined();
    expect(validateDateWindow('11-07-2026', '2026-08-11').error).toBeDefined();
  });
  it('rejects reversed windows', () => {
    expect(validateDateWindow('2026-08-11', '2026-07-11').error).toBeDefined();
  });
  it('rejects windows over 400 days', () => {
    expect(validateDateWindow('2026-01-01', '2027-06-01').error).toBeDefined();
  });
});

describe('planBboxQuery', () => {
  it('uses the gh6 index for walking-distance boxes', () => {
    const plan = planBboxQuery({ west: -2.19, south: 53.0, east: -2.17, north: 53.02 });
    expect(plan.precision).toBe(6);
    expect(plan.indexName).toBe(GH6_INDEX);
    expect(plan.cells.length).toBeGreaterThan(0);
    expect(plan.cells.length).toBeLessThanOrEqual(GH6_MAX_CELLS);
    expect(new Set(plan.cells).size).toBe(plan.cells.length); // unique
  });
  it('uses the gh4 index for city-scale boxes', () => {
    const plan = planBboxQuery({ west: -2.4, south: 52.9, east: -2.0, north: 53.15 });
    expect(plan.precision).toBe(4);
    expect(plan.indexName).toBe(GH4_INDEX);
    expect(plan.cells.length).toBeLessThanOrEqual(GH4_MAX_CELLS);
    expect(plan.cells.every((c) => c.length === 4)).toBe(true);
  });
  it('falls back (never unbounded fan-out) for country-scale boxes', () => {
    const t0 = Date.now();
    const plan = planBboxQuery({ west: -8, south: 50, east: 2, north: 59 });
    expect(plan.fallback).toBe(true);
    expect(plan.cells).toBeUndefined();
    // must reject via estimate, not by materialising ~750k gh6 cells
    expect(Date.now() - t0).toBeLessThan(50);
  });
  it('estimateCells upper-bounds the real cover', () => {
    const bbox = { west: -2.4, south: 52.9, east: -2.0, north: 53.15 };
    expect(estimateCells(bbox, 4)).toBeGreaterThanOrEqual(planBboxQuery(bbox).cells.length);
  });
});
