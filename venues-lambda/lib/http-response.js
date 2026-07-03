/**
 * HTTP response helper for public API endpoints.
 *
 * Gzips JSON bodies when the client accepts it (HTTP API v2 cannot compress
 * at the gateway layer) and attaches Cache-Control for shared/browser caching.
 */
const zlib = require('zlib');

const MIN_COMPRESS_BYTES = 1024;

function acceptsGzip(event) {
  const headers = (event && event.headers) || {};
  const acceptEncoding = headers['accept-encoding'] || headers['Accept-Encoding'] || '';
  return /\bgzip\b/i.test(acceptEncoding);
}

function jsonResponse(event, statusCode, data, options) {
  const { corsHeaders = {}, cacheControl } = options || {};
  const body = JSON.stringify(data);

  const headers = {
    'Content-Type': 'application/json',
    ...corsHeaders
  };
  if (cacheControl) {
    headers['Cache-Control'] = cacheControl;
  }

  if (statusCode === 200 && Buffer.byteLength(body) >= MIN_COMPRESS_BYTES && acceptsGzip(event)) {
    return {
      statusCode,
      headers: {
        ...headers,
        'Content-Encoding': 'gzip',
        'Vary': 'Accept-Encoding'
      },
      body: zlib.gzipSync(body).toString('base64'),
      isBase64Encoded: true
    };
  }

  return { statusCode, headers, body };
}

module.exports = { jsonResponse, acceptsGzip, MIN_COMPRESS_BYTES };
