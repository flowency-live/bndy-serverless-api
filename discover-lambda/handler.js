/**
 * Discover Lambda
 *
 * Handlers:
 * - streamHandler: Processes DynamoDB stream from bndy-events, updates gigging projection
 * - cleanupHandler: Daily cleanup of stale gigging projections
 * - browseHandler: /api/artists/browse endpoint with faceted search
 * - indexHandler: Builds the S3 search index (scheduled)
 */

const AWS = require('aws-sdk');
const https = require('https');

const keepAliveAgent = new https.Agent({ keepAlive: true });
const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: 'eu-west-2',
  httpOptions: { agent: keepAliveAgent },
});

const { processStreamBatch } = require('./lib/stream-handler');
const { filterArtists, buildFacets, sortArtists, parseQuery, paginateResults } = require('./lib/browse-handler');
const { loadIndex, getCacheStats } = require('./lib/search-index');

// API Gateway handles CORS via CorsConfiguration in template.yaml.
// Lambda should NOT set Access-Control-Allow-Origin to avoid conflicts.

/**
 * Get today's date in ISO format (YYYY-MM-DD).
 */
function todayISO() {
  return new Date().toISOString().split('T')[0];
}

/**
 * DynamoDB stream handler entry point.
 *
 * Triggered by bndy-events stream. Updates gigging projection on affected artists.
 */
exports.streamHandler = async (event) => {
  const records = event.Records || [];

  if (records.length === 0) {
    console.log('Discover: No records in stream event');
    return { batchItemFailures: [] };
  }

  console.log(`Discover: Processing ${records.length} stream records`);

  const today = todayISO();

  try {
    await processStreamBatch(records, dynamodb, today);
    console.log('Discover: Stream batch processed successfully');
    return { batchItemFailures: [] };
  } catch (error) {
    console.error('Discover: Stream processing failed:', error);
    throw error;
  }
};

/**
 * Daily cleanup handler.
 *
 * Runs at 03:00 to clear giggingStatus from artists whose giggingUntil has passed.
 * This catches gigs that simply passed without any stream event.
 */
exports.cleanupHandler = async () => {
  const today = todayISO();
  console.log(`Discover: Running daily cleanup for ${today}`);

  try {
    const params = {
      TableName: 'bndy-artists',
      IndexName: 'gigging-status-index',
      KeyConditionExpression: 'giggingStatus = :y AND giggingUntil < :today',
      ExpressionAttributeValues: {
        ':y': 'Y',
        ':today': today,
      },
      ProjectionExpression: 'id',
    };

    const result = await dynamodb.query(params).promise();
    const staleArtists = result.Items || [];

    if (staleArtists.length === 0) {
      console.log('Discover: No stale artists to clean up');
      return { cleaned: 0 };
    }

    console.log(`Discover: Cleaning up ${staleArtists.length} stale artists`);

    const updatePromises = staleArtists.map(async (artist) => {
      try {
        await dynamodb.update({
          TableName: 'bndy-artists',
          Key: { id: artist.id },
          UpdateExpression: 'REMOVE giggingStatus, giggingUntil',
          ConditionExpression: 'attribute_exists(id)',
        }).promise();
      } catch (error) {
        if (error.code !== 'ConditionalCheckFailedException') {
          console.error(`Discover: Failed to clean artist ${artist.id}:`, error);
        }
      }
    });

    await Promise.all(updatePromises);
    console.log(`Discover: Cleaned ${staleArtists.length} artists`);

    return { cleaned: staleArtists.length };
  } catch (error) {
    console.error('Discover: Cleanup failed:', error);
    throw error;
  }
};

/**
 * Browse handler for /api/artists/browse endpoint.
 *
 * Query params:
 * - q: Free text search (parsed into filters)
 * - genre: Filter by genre (repeatable)
 * - artistType: Filter by artist type (repeatable)
 * - actType: Filter by act type (repeatable)
 * - acoustic: Filter by acoustic (true/false)
 * - area: Filter by location/area (repeatable)
 * - gigging: Filter to only gigging artists (true)
 * - sort: Sort order (name, newest, soonest)
 * - cursor: Pagination cursor
 * - limit: Page size (default 24, max 100)
 */
exports.browseHandler = async (event) => {
  const params = event.queryStringParameters || {};

  try {
    // Load the search index
    const artists = await loadIndex();

    if (artists.length === 0) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          results: [],
          facets: { genre: {}, artistType: {}, actType: {}, acoustic: {}, area: {} },
          parsed: {},
          nextCursor: null,
        }),
      };
    }

    // Parse free-text query into structured filters
    const parsed = params.q ? parseQuery(params.q) : { genre: [], actType: [], artistType: [], text: '' };

    // Build filter object from query params + parsed query
    const filters = {
      q: parsed.text || undefined,
      genre: [...(parsed.genre || []), ...(params.genre ? [].concat(params.genre) : [])],
      artistType: [...(parsed.artistType || []), ...(params.artistType ? [].concat(params.artistType) : [])],
      actType: [...(parsed.actType || []), ...(params.actType ? [].concat(params.actType) : [])],
      acoustic: parsed.acoustic ?? (params.acoustic === 'true' ? true : undefined),
      area: params.area ? [].concat(params.area) : [],
    };

    // Apply gigging filter if requested
    let filteredArtists = filterArtists(artists, filters);

    if (params.gigging === 'true') {
      const today = todayISO();
      filteredArtists = filteredArtists.filter(a => a.giggingUntil && a.giggingUntil >= today);
    }

    // Build facets from filtered results
    const facets = buildFacets(filteredArtists);

    // Sort
    const sort = params.sort || 'name';
    const sortedArtists = sortArtists(filteredArtists, sort);

    // Paginate
    const limit = Math.min(parseInt(params.limit, 10) || 24, 100);
    const { results, nextCursor } = paginateResults(sortedArtists, params.cursor, limit);

    // Transform to card format
    const cards = results.map((artist) => ({
      type: 'artist',
      id: artist.id,
      name: artist.name,
      imageUrl: artist.profileImageUrl || null,
      town: artist.location || null,
      tags: [
        ...(artist.genres || []).slice(0, 2),
        artist.actType,
      ].filter(Boolean),
      gigging: artist.giggingStatus === 'Y',
      giggingUntil: artist.giggingUntil || null,
      createdAt: artist.createdAt || null,
      verified: artist.isVerified || false,
    }));

    console.log(`Browse: ${cards.length} results (${filteredArtists.length} total, sort=${sort})`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
        // Vary by Origin so caches don't mix CORS responses for different origins
        'Vary': 'Origin, Accept-Encoding',
      },
      body: JSON.stringify({
        results: cards,
        facets,
        parsed: {
          genre: filters.genre.length > 0 ? filters.genre : undefined,
          artistType: filters.artistType.length > 0 ? filters.artistType : undefined,
          actType: filters.actType.length > 0 ? filters.actType : undefined,
          acoustic: filters.acoustic,
          area: filters.area.length > 0 ? filters.area : undefined,
          text: filters.q || undefined,
        },
        nextCursor,
        _cache: getCacheStats(),
      }),
    };
  } catch (error) {
    console.error('Browse: Failed:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};

/**
 * Index builder handler.
 *
 * Builds the S3 search index from bndy-artists table.
 * Runs on a schedule (every 15 minutes).
 */
exports.indexHandler = async () => {
  const zlib = require('zlib');
  const s3 = new AWS.S3({ region: 'eu-west-2' });

  const BUCKET = 'bndy-search';
  const INDEX_KEY = 'artists-index.json.gz';
  const VERSION_KEY = 'artists-index.version';

  console.log('Index: Building search index');

  try {
    // Scan all artists with projection for index fields
    const artists = [];
    let lastKey;

    do {
      const params = {
        TableName: 'bndy-artists',
        ProjectionExpression: 'id, #n, profileImageUrl, #loc, genres, artistType, actType, acoustic, isVerified, createdAt, giggingStatus, giggingUntil, #h',
        ExpressionAttributeNames: {
          '#n': 'name',
          '#loc': 'location',
          '#h': 'hidden',
        },
        ExclusiveStartKey: lastKey,
      };

      const result = await dynamodb.scan(params).promise();

      for (const item of result.Items || []) {
        // Skip hidden artists
        if (item['hidden'] === true) continue;

        artists.push({
          id: item.id,
          name: item.name,
          profileImageUrl: item.profileImageUrl || null,
          location: item.location || null,
          genres: item.genres || [],
          artistType: item.artistType || null,
          actType: item.actType || null,
          acoustic: item.acoustic || false,
          isVerified: item.isVerified || false,
          createdAt: item.createdAt || null,
          giggingStatus: item.giggingStatus || null,
          giggingUntil: item.giggingUntil || null,
        });
      }

      lastKey = result.LastEvaluatedKey;
    } while (lastKey);

    console.log(`Index: Found ${artists.length} artists`);

    // Build and compress the index
    const index = { artists, buildTime: new Date().toISOString() };
    const json = JSON.stringify(index);
    const compressed = zlib.gzipSync(json);

    console.log(`Index: Compressed size ${(compressed.length / 1024).toFixed(1)} KB`);

    // Upload to S3
    await s3.putObject({
      Bucket: BUCKET,
      Key: INDEX_KEY,
      Body: compressed,
      ContentType: 'application/json',
      ContentEncoding: 'gzip',
    }).promise();

    // Update version marker
    const version = new Date().toISOString();
    await s3.putObject({
      Bucket: BUCKET,
      Key: VERSION_KEY,
      Body: version,
      ContentType: 'text/plain',
    }).promise();

    console.log(`Index: Uploaded to s3://${BUCKET}/${INDEX_KEY} (version: ${version})`);

    return {
      success: true,
      artistCount: artists.length,
      sizeKB: (compressed.length / 1024).toFixed(1),
      version,
    };
  } catch (error) {
    console.error('Index: Build failed:', error);
    throw error;
  }
};
