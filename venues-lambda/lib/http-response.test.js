const zlib = require('zlib');
const { jsonResponse, acceptsGzip } = require('./http-response');

const gzipEvent = { headers: { 'accept-encoding': 'gzip, deflate, br' } };
const noGzipEvent = { headers: {} };
const cors = { 'Access-Control-Allow-Origin': 'https://live.bndy.co.uk' };

describe('acceptsGzip', () => {
  it('detects gzip in lowercase header (HTTP API v2)', () => {
    expect(acceptsGzip(gzipEvent)).toBe(true);
  });
  it('detects gzip in capitalised header', () => {
    expect(acceptsGzip({ headers: { 'Accept-Encoding': 'gzip' } })).toBe(true);
  });
  it('returns false when absent', () => {
    expect(acceptsGzip(noGzipEvent)).toBe(false);
    expect(acceptsGzip({})).toBe(false);
    expect(acceptsGzip(undefined)).toBe(false);
  });
});

describe('jsonResponse', () => {
  const bigData = { events: Array.from({ length: 200 }, (_, i) => ({ id: `ev-${i}`, name: 'The Longest Band Name In Staffordshire', venue: 'The Glebe' })) };

  it('gzips large bodies when client accepts gzip', () => {
    const res = jsonResponse(gzipEvent, 200, bigData, { corsHeaders: cors });
    expect(res.isBase64Encoded).toBe(true);
    expect(res.headers['Content-Encoding']).toBe('gzip');
    expect(res.headers['Vary']).toBe('Accept-Encoding');
    const decoded = JSON.parse(zlib.gunzipSync(Buffer.from(res.body, 'base64')).toString());
    expect(decoded).toEqual(bigData);
  });

  it('does not gzip when client does not accept it', () => {
    const res = jsonResponse(noGzipEvent, 200, bigData, { corsHeaders: cors });
    expect(res.isBase64Encoded).toBeUndefined();
    expect(res.headers['Content-Encoding']).toBeUndefined();
    expect(JSON.parse(res.body)).toEqual(bigData);
  });

  it('does not gzip small bodies (below 1KB threshold)', () => {
    const res = jsonResponse(gzipEvent, 200, { ok: true }, { corsHeaders: cors });
    expect(res.isBase64Encoded).toBeUndefined();
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('does not gzip non-200 responses', () => {
    const res = jsonResponse(gzipEvent, 400, bigData, { corsHeaders: cors });
    expect(res.isBase64Encoded).toBeUndefined();
    expect(res.statusCode).toBe(400);
  });

  it('merges CORS headers, Content-Type and Cache-Control', () => {
    const res = jsonResponse(gzipEvent, 200, bigData, { corsHeaders: cors, cacheControl: 'public, max-age=60' });
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://live.bndy.co.uk');
    expect(res.headers['Content-Type']).toBe('application/json');
    expect(res.headers['Cache-Control']).toBe('public, max-age=60');
  });

  it('preserves Vary: Origin when gzipping with CORS and cacheControl', () => {
    // Regression test: gzipped responses must include Vary: Origin when CORS is used,
    // otherwise browsers cache responses per-origin incorrectly (map.bndy.co.uk gets
    // backstage.bndy.co.uk's cached response with wrong Access-Control-Allow-Origin)
    const res = jsonResponse(gzipEvent, 200, bigData, { corsHeaders: cors, cacheControl: 'public, max-age=300' });
    expect(res.isBase64Encoded).toBe(true);
    expect(res.headers['Content-Encoding']).toBe('gzip');
    expect(res.headers['Vary']).toBe('Origin, Accept-Encoding');
  });

  it('omits Cache-Control when not provided', () => {
    const res = jsonResponse(gzipEvent, 200, { ok: true }, { corsHeaders: cors });
    expect(res.headers['Cache-Control']).toBeUndefined();
  });
});
