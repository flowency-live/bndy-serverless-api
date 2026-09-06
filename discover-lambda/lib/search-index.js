/**
 * S3-backed search index for artists
 *
 * Loads a gzipped JSON index from S3 into memory on cold start.
 * Refreshes every 10 minutes or when a version marker changes.
 */

const AWS = require('aws-sdk');
const zlib = require('zlib');

const s3 = new AWS.S3({ region: 'eu-west-2' });

const BUCKET = 'bndy-search';
const INDEX_KEY = 'artists-index.json.gz';
const VERSION_KEY = 'artists-index.version';
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

let cachedIndex = null;
let cachedVersion = null;
let lastRefresh = 0;

/**
 * Load the artists index from S3.
 * Returns the parsed array of artist records.
 */
async function loadIndex() {
  const now = Date.now();

  // Check if refresh is needed
  if (cachedIndex && (now - lastRefresh) < REFRESH_INTERVAL_MS) {
    // Check version marker for early refresh
    const version = await getVersionMarker();
    if (version === cachedVersion) {
      return cachedIndex;
    }
  }

  // Load fresh index from S3
  try {
    const data = await s3.getObject({ Bucket: BUCKET, Key: INDEX_KEY }).promise();
    const decompressed = zlib.gunzipSync(data.Body);
    const parsed = JSON.parse(decompressed.toString('utf8'));

    cachedIndex = parsed.artists || [];
    cachedVersion = await getVersionMarker();
    lastRefresh = now;

    console.log(`Search index loaded: ${cachedIndex.length} artists`);
    return cachedIndex;
  } catch (error) {
    if (error.code === 'NoSuchKey') {
      console.warn('Search index not found in S3, returning empty');
      return [];
    }
    throw error;
  }
}

/**
 * Get the version marker from S3.
 */
async function getVersionMarker() {
  try {
    const data = await s3.getObject({ Bucket: BUCKET, Key: VERSION_KEY }).promise();
    return data.Body.toString('utf8').trim();
  } catch (error) {
    if (error.code === 'NoSuchKey') {
      return null;
    }
    console.warn('Failed to get version marker:', error.message);
    return null;
  }
}

/**
 * Force refresh the index on next call.
 */
function invalidateCache() {
  lastRefresh = 0;
  cachedVersion = null;
}

/**
 * Get current cache stats for diagnostics.
 */
function getCacheStats() {
  return {
    hasCachedIndex: cachedIndex !== null,
    artistCount: cachedIndex?.length || 0,
    version: cachedVersion,
    lastRefresh: lastRefresh ? new Date(lastRefresh).toISOString() : null,
    ageMs: lastRefresh ? Date.now() - lastRefresh : null,
  };
}

module.exports = {
  loadIndex,
  invalidateCache,
  getCacheStats,
};
