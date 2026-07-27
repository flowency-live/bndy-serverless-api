/**
 * Geo query planning for GET /api/events/public/geo.
 * Pure functions: bbox parsing/validation and adaptive geohash cell cover.
 * The client speaks geography (bbox); the server owns the geohash strategy.
 * Design: Projects/bndy/GEO-EVENTS-ENDPOINT-PLAN.md (v2 addendum, audit A1)
 */
const ngeohash = require('ngeohash');

/** Existing GSI — walking/town scale (~1.2km cells). */
const GH6_INDEX = 'geohash6-date-index';
/** Viewport-scale GSI — city/county (~39km cells). Added 2026-07 (audit A1). */
const GH4_INDEX = 'geohash4-date-index';

const GH6_MAX_CELLS = 12;
const GH4_MAX_CELLS = 24;
const MAX_WINDOW_DAYS = 400;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "west,south,east,north" → { bbox } | { error } */
function parseBbox(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { error: 'bbox must be "west,south,east,north"' };
  }
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return { error: 'bbox must be four numbers: west,south,east,north' };
  }
  const [west, south, east, north] = parts;
  if (west < -180 || east > 180 || south < -90 || north > 90) {
    return { error: 'bbox coordinates out of range' };
  }
  if (!(west < east) || !(south < north)) {
    return { error: 'bbox must satisfy west<east and south<north' };
  }
  return { bbox: { west, south, east, north } };
}

/** Both dates required, ISO, ordered, window capped. → {} | { error } */
function validateDateWindow(startDate, endDate) {
  if (!DATE_RE.test(startDate || '') || !DATE_RE.test(endDate || '')) {
    return { error: 'startDate and endDate must be YYYY-MM-DD' };
  }
  if (endDate < startDate) {
    return { error: 'endDate must not be before startDate' };
  }
  const days = (new Date(endDate) - new Date(startDate)) / 86400000;
  if (days > MAX_WINDOW_DAYS) {
    return { error: `date window must be <= ${MAX_WINDOW_DAYS} days` };
  }
  return {};
}

/**
 * Choose the cheapest index cover for a bbox.
 * → { precision, indexName, hashAttr, cells } for fan-out, or
 *   { fallback: true } when the cover is too large (country-scale zoom) —
 *   caller serves the cached whole-window dataset instead. NEVER unbounded fan-out.
 */
// Approximate geohash cell sizes in degrees (lon x lat) at each precision.
const CELL_DEG = { 6: { lon: 0.010986, lat: 0.005493 }, 4: { lon: 0.3515625, lat: 0.17578125 } };

/** Cheap upper-bound estimate of the cell cover — no allocation. A country-scale
 *  bbox at precision 6 is ~750k cells; never materialise that just to reject it. */
function estimateCells(bbox, precision) {
  const c = CELL_DEG[precision];
  const cols = Math.ceil((bbox.east - bbox.west) / c.lon) + 1;
  const rows = Math.ceil((bbox.north - bbox.south) / c.lat) + 1;
  return cols * rows;
}

function planBboxQuery(bbox) {
  const { west, south, east, north } = bbox;
  if (estimateCells(bbox, 6) <= GH6_MAX_CELLS * 2) {
    const cells6 = ngeohash.bboxes(south, west, north, east, 6);
    if (cells6.length <= GH6_MAX_CELLS) {
      return { precision: 6, indexName: GH6_INDEX, hashAttr: 'geohash6', cells: cells6 };
    }
  }
  if (estimateCells(bbox, 4) <= GH4_MAX_CELLS * 2) {
    const cells4 = ngeohash.bboxes(south, west, north, east, 4);
    if (cells4.length <= GH4_MAX_CELLS) {
      return { precision: 4, indexName: GH4_INDEX, hashAttr: 'geohash4', cells: cells4 };
    }
  }
  return { fallback: true };
}

module.exports = {
  parseBbox,
  estimateCells,
  validateDateWindow,
  planBboxQuery,
  GH6_INDEX,
  GH4_INDEX,
  GH6_MAX_CELLS,
  GH4_MAX_CELLS,
  MAX_WINDOW_DAYS,
};
