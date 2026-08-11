// BNDY Artists Lambda Function - DynamoDB Version
// Handles: /api/artists, /api/artists/:id

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const https = require('https');

// Keep-alive agent: SDK v2 opens a new TLS connection per DynamoDB call by
// default; reusing connections saves ~10-50ms per call on busy handlers.
const keepAliveAgent = new (require('https').Agent)({ keepAlive: true });
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2', httpOptions: { agent: keepAliveAgent } });
const s3 = new AWS.S3({ region: 'eu-west-2' });
const { jsonResponse } = require('./lib/http-response');
const { scanAll } = require('./lib/scan-all');
const { artistIdentityKey, artistUniqueKey, facebookKey, normaliseKey, regionBucket } = require('./lib/identity');
const { gatedPut, rekeyUniqueKeys, releaseUniqueKeys, duplicateResponseBody, gateMode } = require('./lib/unique-gate');
const { validateArtistData } = require('./lib/data-quality');
const { deleteArtistEvents } = require('./lib/cascade-delete-events');
const { hasEventsForArtist, countEventsForArtist } = require('./lib/artist-event-guard');
const { requireRole: requireCuratorRole, logActivity: logCuratorActivity, pickFields: pickCuratorFields, hideEntity: hideArtistEntity, restoreEntity: restoreArtistEntity } = require('./curator-core');

/**
 * Sentinel keys for an artist record (2026-07-27 gate plan):
 *  - identity key: normalise(name) + '#' + regionBucket(location) — Jason's
 *    ruling that name + performing location IS the artist UID
 *  - variant keys: each name_variant produces its own key in the same region
 *  - facebook key: exact FB URL is the strongest identity signal — two
 *    records may never share one
 * Returns { keys, variantKeys, resolvable } — resolvable=false means the
 * location can't be bucketed; in enforce mode such artists must NOT be
 * created (review instead). variantKeys lists just the variant-derived keys
 * for collision reporting.
 */
function buildArtistUniqueKeys(name, location, facebookUrl, nameVariants) {
  const identity = artistIdentityKey(name, location);
  const keys = [];
  const variantKeys = [];

  if (identity.resolvable) keys.push(`artist#${identity.key}`);

  // Variant name keys (same region as primary)
  if (Array.isArray(nameVariants) && nameVariants.length > 0) {
    const region = regionBucket(location);
    const seenVariantKeys = new Set();
    // Don't duplicate the primary name key
    if (identity.resolvable) seenVariantKeys.add(identity.key);

    for (const variant of nameVariants) {
      if (!variant || typeof variant !== 'string') continue;
      const variantNameKey = normaliseKey(variant);
      if (!variantNameKey || seenVariantKeys.has(variantNameKey)) continue;
      seenVariantKeys.add(variantNameKey);

      // Only create variant key if region is resolvable
      if (region !== 'unknown') {
        const fullVariantKey = `artist#${variantNameKey}#${region}`;
        keys.push(fullVariantKey);
        variantKeys.push(fullVariantKey);
      }
    }
  }

  const fbKey = facebookKey(facebookUrl);
  if (fbKey) keys.push(`artist#fb#${fbKey}`);

  return { keys, variantKeys, resolvable: identity.resolvable, identity };
}

/**
 * Merge externalIds additively (union, dedupe by source+id).
 * Used for artist update paths to ensure externalIds accumulate rather than replace.
 *
 * @param {Array} existing - existing external_ids from DynamoDB
 * @param {Array} incoming - new externalIds from request
 * @returns {Array} merged and deduplicated array
 */
function mergeExternalIds(existing, incoming) {
  const existingArr = existing || [];
  const incomingArr = incoming || [];

  // Create a Set of unique keys (source#id) from existing
  const seen = new Set(existingArr.map(ext => `${ext.source}#${ext.id}`));

  // Merge: start with existing, add new ones that aren't duplicates
  const merged = [...existingArr];

  for (const ext of incomingArr) {
    const key = `${ext.source}#${ext.id}`;
    if (!seen.has(key)) {
      merged.push(ext);
      seen.add(key);
    }
  }

  return merged;
}

/**
 * Merge nameVariants additively (union, dedupe by normalized key).
 * Used for artist update paths to ensure known billing variations accumulate.
 *
 * @param {Array} existing - existing name_variants from DynamoDB
 * @param {Array} incoming - new nameVariants from request
 * @returns {Array} merged and deduplicated array (case-insensitive dedup)
 */
function mergeNameVariants(existing, incoming) {
  const existingArr = existing || [];
  const incomingArr = incoming || [];

  // Dedupe by normalized key (case-insensitive, whitespace normalized)
  const seen = new Set(existingArr.map(variant => normaliseKey(variant)));

  // Merge: start with existing, add new ones that aren't duplicates
  const merged = [...existingArr];

  for (const variant of incomingArr) {
    const key = normaliseKey(variant);
    if (!seen.has(key)) {
      merged.push(variant);
      seen.add(key);
    }
  }

  return merged;
}

// Configuration
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';

// Allowed CORS origins for frontend access
const ALLOWED_ORIGINS = [
  'https://www.bndy.co.uk',       // Primary domain
  'https://backstage.bndy.co.uk', // Legacy domain
  'https://bndy.co.uk',            // Apex domain
  'https://live.bndy.co.uk',      // Frontstage
  'https://gigmap.bndy.co.uk',    // GigMap
  'http://localhost:3000'          // Local development
];

// Module-level variable to store current request event for CORS
let currentEvent = null;

// Get appropriate origin for CORS based on request origin
const getAllowedOrigin = () => {
  const requestOrigin = currentEvent?.headers?.origin || currentEvent?.headers?.Origin;
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
};

// JWT Secret from environment variable (set by SAM template from Secrets Manager)
const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Extract Facebook username from URL
 * Handles various Facebook URL formats
 */
function extractFacebookUsername(url) {
  if (!url) return null;

  try {
    // Handle profile.php?id= format
    if (url.includes('profile.php?id=')) {
      const match = url.match(/id=(\d+)/);
      return match ? match[1] : null;
    }

    // Handle standard facebook.com/username format
    const match = url.match(/facebook\.com\/([a-zA-Z0-9.]{2,}[^/?]*)/);
    if (!match) return null;

    const username = match[1];

    // Filter out non-username paths
    const excludedPaths = ['profile.php', 'people', 'pages', 'groups', 'events', 'photos', 'videos', 'p'];
    if (excludedPaths.includes(username)) return null;

    return username;
  } catch (error) {
    console.error('Error extracting Facebook username:', error);
    return null;
  }
}

/**
 * Check if a URL returns a valid image
 * Uses HTTPS GET request with redirect following
 */
function checkImageExists(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = res.headers.location;
        https.get(redirectUrl, (redirectRes) => {
          resolve(redirectRes.statusCode === 200 && redirectRes.headers['content-type']?.startsWith('image/'));
        }).on('error', () => resolve(false));
      } else {
        resolve(res.statusCode === 200 && res.headers['content-type']?.startsWith('image/'));
      }
    }).on('error', () => resolve(false));
  });
}

/**
 * Fetch Facebook profile picture URL
 * Returns direct CDN URL if valid, null otherwise
 */
async function fetchFacebookProfilePicture(facebookUrl) {
  if (!facebookUrl) return null;

  const username = extractFacebookUsername(facebookUrl);
  if (!username) {
    console.log('[FETCH_FB_IMAGE] Could not extract username from:', facebookUrl);
    return null;
  }

  // Construct Graph API URL
  const profilePicUrl = `https://graph.facebook.com/${username}/picture?type=large`;

  // Validate image exists
  const exists = await checkImageExists(profilePicUrl);
  if (exists) {
    console.log('[FETCH_FB_IMAGE] Successfully fetched image for username:', username);
    return profilePicUrl;
  }

  console.log('[FETCH_FB_IMAGE] Image validation failed for username:', username);
  return null;
}

/**
 * Download external image and upload to S3
 * Returns S3 public URL if successful, null otherwise
 * @param {string} imageUrl - External image URL to download
 * @param {string} artistId - Artist ID for S3 key path
 * @param {string} artistName - Artist name for logging
 * @returns {Promise<string|null>} S3 public URL or null
 */
async function downloadAndUploadImageToS3(imageUrl, artistId, artistName) {
  if (!imageUrl || !imageUrl.trim()) return null;

  // Skip if already an S3 URL (don't re-download)
  if (imageUrl.includes('s3.') || imageUrl.includes('bndy-images')) {
    console.log(`[DOWNLOAD_IMAGE] Already S3 URL, using as-is: ${imageUrl.substring(0, 80)}`);
    return imageUrl;
  }

  // Skip Facebook Graph API URLs (these are dynamic redirects)
  if (imageUrl.includes('graph.facebook.com')) {
    console.log(`[DOWNLOAD_IMAGE] Facebook Graph URL, using as-is: ${imageUrl.substring(0, 80)}`);
    return imageUrl;
  }

  console.log(`[DOWNLOAD_IMAGE] Downloading external image for artist "${artistName}"`);
  console.log(`[DOWNLOAD_IMAGE] Source URL: ${imageUrl.substring(0, 100)}`);

  return new Promise((resolve) => {
    https.get(imageUrl, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        console.log(`[DOWNLOAD_IMAGE] Following redirect to: ${redirectUrl?.substring(0, 80)}`);
        return resolve(downloadAndUploadImageToS3(redirectUrl, artistId, artistName));
      }

      if (response.statusCode !== 200) {
        console.error(`[DOWNLOAD_IMAGE] Failed to download: HTTP ${response.statusCode}`);
        return resolve(null);
      }

      const contentType = response.headers['content-type'];
      if (!contentType || !contentType.startsWith('image/')) {
        console.error(`[DOWNLOAD_IMAGE] Invalid content type: ${contentType}`);
        return resolve(null);
      }

      // Determine file extension from content type
      const ext = contentType.split('/')[1]?.split(';')[0] || 'jpg';
      const allowedExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
      const fileExt = allowedExts.includes(ext) ? ext : 'jpg';

      // Download image data
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks);
          const fileSizeKB = (buffer.length / 1024).toFixed(2);
          console.log(`[DOWNLOAD_IMAGE] Downloaded ${fileSizeKB}KB`);

          // Validate size (5MB limit)
          const maxSize = 5 * 1024 * 1024;
          if (buffer.length > maxSize) {
            console.error(`[DOWNLOAD_IMAGE] File too large: ${fileSizeKB}KB (max 5MB)`);
            return resolve(null);
          }

          // Generate S3 key
          const timestamp = Date.now();
          const sanitizedName = artistName.replace(/[^a-zA-Z0-9-]/g, '_').substring(0, 50);
          const key = `community-imports/${artistId}/${timestamp}-${sanitizedName}.${fileExt}`;

          console.log(`[DOWNLOAD_IMAGE] Uploading to S3: ${key}`);

          // Upload to S3
          await s3.putObject({
            Bucket: 'bndy-images',
            Key: key,
            Body: buffer,
            ContentType: contentType,
            Metadata: {
              'artist-id': artistId,
              'artist-name': artistName,
              'source': 'mcp_community_import',
              'original-url': imageUrl.substring(0, 500)
            }
          }).promise();

          const s3Url = `https://bndy-images.s3.eu-west-2.amazonaws.com/${key}`;
          console.log(`[DOWNLOAD_IMAGE] Upload successful: ${s3Url.substring(0, 80)}`);
          return resolve(s3Url);

        } catch (uploadError) {
          console.error('[DOWNLOAD_IMAGE] S3 upload failed:', uploadError.message);
          return resolve(null);
        }
      });

      response.on('error', (error) => {
        console.error('[DOWNLOAD_IMAGE] Download error:', error.message);
        return resolve(null);
      });

    }).on('error', (error) => {
      console.error('[DOWNLOAD_IMAGE] HTTP request error:', error.message);
      return resolve(null);
    });
  });
}

// Parse cookies from event
const parseCookies = (cookieHeader) => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, value] = cookie.trim().split('=');
    cookies[name] = value;
    return cookies;
  }, {});
};

/**
 * Timing-safe string comparison to prevent timing attacks on token verification.
 * SEC-AUD-004: Added for MCP service token authentication
 */
const timingSafeCompare = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Require MCP service token authentication
 * SEC-AUD-004: MCP routes now require Bearer token auth, not unauthenticated access
 * Returns { user } on success, { error, statusCode } on failure
 */
const requireMcpAuth = (event) => {
  const bearer = event.headers?.Authorization || event.headers?.authorization || '';
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : null;
  const serviceToken = process.env.MCP_SERVICE_TOKEN;

  // MCP_SERVICE_TOKEN must be configured
  if (!serviceToken) {
    console.error('[SEC-AUD-004] MCP_SERVICE_TOKEN not configured');
    return { error: 'MCP service not configured', statusCode: 500 };
  }

  // Require Bearer token
  if (!token) {
    return { error: 'MCP service token required', statusCode: 401 };
  }

  // Validate service token
  if (!timingSafeCompare(token, serviceToken)) {
    return { error: 'Invalid MCP service token', statusCode: 401 };
  }

  return { user: { userId: 'mcp-service', platformAdmin: true, isService: true } };
};

// Authentication middleware
const requireAuth = async (event) => {
  let sessionToken = null;

  if (event.cookies && Array.isArray(event.cookies)) {
    const cookieString = event.cookies.find(c => c.startsWith('bndy_session='));
    if (cookieString) {
      sessionToken = cookieString.split('=')[1];
    }
  } else {
    const cookies = parseCookies(event.headers?.Cookie || event.headers?.cookie || '');
    sessionToken = cookies.bndy_session;
  }

  if (!sessionToken) {
    return { error: 'Not authenticated' };
  }

  try {
    const session = jwt.verify(sessionToken, JWT_SECRET);

    // Fetch user to check platformAdmin flag
    const userResult = await dynamodb.get({
      TableName: 'bndy-users',
      Key: { cognito_id: session.userId }
    }).promise();

    const platformAdmin = userResult.Item?.platformAdmin || false;

    return {
      user: {
        ...session,
        platformAdmin
      }
    };
  } catch (error) {
    console.error(' Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

/**
 * Require platform admin authentication
 * Returns { user } on success, { error, statusCode } on failure
 */
const requirePlatformAdmin = async (event) => {
  const authResult = await requireAuth(event);
  if (authResult.error) {
    return { error: authResult.error, statusCode: 401 };
  }

  if (!authResult.user.platformAdmin) {
    return { error: 'Platform admin access required', statusCode: 403 };
  }

  return authResult;
};

exports.handler = async (event, context) => {
  // Store event for CORS headers
  currentEvent = event;

  // HTTP API v2 payload format compatibility
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;

  console.log(' Artists Lambda: Request received', {
    method,
    path,
    pathParameters: event.pathParameters
  });

  context.callbackWaitsForEmptyEventLoop = false;

  try {
    // Route requests
    if (method === 'GET' && path === '/api/artists') {
      return await handleGetAllArtists(event);
    }

    // External ID lookup endpoint
    if (method === 'GET' && path === '/api/artists/by-external-id') {
      return await handleGetArtistByExternalId(event);
    }

    // MCP list artists endpoint (paginated with filters)
    if (method === 'GET' && path === '/api/artists/list') {
      return await handleListArtistsMcp(event);
    }

    // Artist search endpoint (fuzzy matching for duplicate prevention)
    if (method === 'GET' && path === '/api/artists/search') {
      return await handleSearchArtists(event);
    }

    // Check name availability endpoint
    if (method === 'GET' && path === '/api/artists/check-name') {
      return await handleCheckName(event);
    }

    // Refresh Facebook profile image endpoint
    if (method === 'POST' && path.includes('/refresh-facebook-image')) {
      const artistId = event.pathParameters?.id || path.split('/')[3];
      return await handleRefreshFacebookImage(artistId);
    }

    // Get artist events (public endpoint for MCP)
    if (method === 'GET' && event.pathParameters?.id && path.includes('/events')) {
      return await handleGetArtistEvents(event.pathParameters.id, event);
    }

    if (method === 'GET' && event.pathParameters?.id) {
      // Feature 4: godmode can read a hidden artist with ?includeHidden=1 + platform admin
      if (event.queryStringParameters?.includeHidden === '1') {
        const adminCheck = await requirePlatformAdmin(event);
        if (!adminCheck.error) event.__allowHidden = true;
      }
      return await handleGetArtistById(event.pathParameters.id, event);
    }

    if (method === 'POST' && path === '/api/artists') {
      return await handleCreateArtist(event);
    }

    // Community artist creation endpoint (public, no auth required)
    if (method === 'POST' && path === '/api/artists/community') {
      return await handleCreateCommunityArtist(event);
    }

    // Find-or-create artist (public, no auth) - server-side resolution gate (ADR-014)
    // SEC-COMMUNITY: Also handles /api/community/artists/find-or-create (public wizard)
    if (method === 'POST' && (path === '/api/artists/find-or-create' || path === '/api/community/artists/find-or-create')) {
      return await handleFindOrCreateArtist(event);
    }

    // Curator routes (backlog feature 4) — role gate lives inside the handlers
    if (method === 'PUT' && path.startsWith('/api/curator/artists/')) {
      return await handleCuratorUpdateArtist(event);
    }
    if (method === 'POST' && path.startsWith('/api/curator/artists/') && path.endsWith('/hide')) {
      return await handleCuratorHideArtist(event);
    }
    if (method === 'POST' && path.startsWith('/api/curator/artists/') && path.endsWith('/restore')) {
      return await handleCuratorRestoreArtist(event);
    }

    // Acts CRUD routes - #60 Acts Model
    // These must come before the generic PUT/DELETE routes
    if (method === 'POST' && path.includes('/acts') && event.pathParameters?.id) {
      return await handleCreateAct(event);
    }

    if (method === 'PUT' && path.includes('/acts/') && path.includes('/default')) {
      return await handleSetDefaultAct(event);
    }

    if (method === 'PUT' && path.includes('/acts/') && event.pathParameters?.actId) {
      return await handleUpdateAct(event);
    }

    if (method === 'DELETE' && path.includes('/acts/') && event.pathParameters?.actId) {
      return await handleDeleteAct(event);
    }

    // Enrichment action endpoint (2026-08-11)
    if (method === 'PATCH' && path.includes('/enrichment') && event.pathParameters?.id) {
      // Require platform admin for enrichment actions
      const authResult = await requirePlatformAdmin(event);
      if (authResult.error) {
        return {
          statusCode: authResult.statusCode || 401,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: authResult.error })
        };
      }
      return await handleEnrichmentAction(event);
    }

    if ((method === 'PUT' || method === 'PATCH') && event.pathParameters?.id) {
      // Check if this is an MCP update request (public, no auth)
      if (path.includes('/mcp')) {
        return await handleMCPUpdateArtist(event);
      }
      return await handleUpdateArtist(event);
    }

    if (method === 'DELETE' && event.pathParameters?.id) {
      // SEC-AUD-004: MCP delete now requires service token auth
      if (path.includes('/mcp')) {
        const mcpAuth = requireMcpAuth(event);
        if (mcpAuth.error) {
          return {
            statusCode: mcpAuth.statusCode || 401,
            headers: getCorsHeaders(),
            body: JSON.stringify({ error: mcpAuth.error })
          };
        }
        return await handleMCPDeleteArtist(event.pathParameters.id);
      }

      // SEC-XX: Require platformAdmin for artist deletion (godmode only)
      const authResult = await requirePlatformAdmin(event);
      if (authResult.error) {
        return {
          statusCode: authResult.statusCode || 401,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: authResult.error })
        };
      }

      // Check for force delete (cascade delete events)
      const queryParams = event.queryStringParameters || {};
      if (queryParams.force === 'true') {
        return await handleForceDeleteArtist(event.pathParameters.id);
      }

      return await handleDeleteArtist(event.pathParameters.id);
    }

    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Route not found' })
    };

  } catch (error) {
    console.error(' Artists Lambda: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

async function handleGetAllArtists(event) {
  console.log(' Artists Lambda: Scanning all artists from DynamoDB...');

  const params = {
    TableName: 'bndy-artists',
    ProjectionExpression: 'id, #name, bio, #location, locationLat, locationLng, locationType, genres, facebookUrl, instagramUrl, websiteUrl, socialMediaUrls, profileImageUrl, isVerified, followerCount, claimedByUserId, allowedEventTypes, displayColour, artist_type, actType, acoustic, publishAvailability, availabilityMode, contactMethod, phoneNumber, whatsappNumber, showMemberVotes, autoDiscardThreshold, #source, ai_created, needs_review, owner_user_id, validated, createdAt, #hidden',
    ExpressionAttributeNames: {
      '#name': 'name',
      '#location': 'location',
      '#source': 'source',
      '#hidden': 'hidden'
    }
  };

  try {
    const scannedItems = await scanAll(dynamodb, params);
    // Feature 4: hidden artists never reach a public list.
    const allItems = scannedItems.filter(a => a.hidden !== true);

    // Transform to match expected API format
    const formattedArtists = allItems.map(artist => ({
      id: artist.id,
      name: artist.name,
      artist_type: artist.artist_type || null,
      artistType: artist.artist_type || null,
      bio: artist.bio || '',
      location: artist.location || '',
      locationLat: artist.locationLat || null,
      locationLng: artist.locationLng || null,
      locationType: artist.locationType || null,
      genres: artist.genres || [],
      actType: artist.actType || null,
      acoustic: artist.acoustic || false,
      publishAvailability: artist.publishAvailability || false,
      availabilityMode: artist.availabilityMode || 'selected_dates_only',
      contactMethod: artist.contactMethod || 'phone',
      phoneNumber: artist.phoneNumber || null,
      whatsappNumber: artist.whatsappNumber || null,
      showMemberVotes: artist.showMemberVotes || false,
      autoDiscardThreshold: artist.autoDiscardThreshold ?? null,
      facebookUrl: artist.facebookUrl || '',
      instagramUrl: artist.instagramUrl || '',
      websiteUrl: artist.websiteUrl || '',
      socialMediaUrls: artist.socialMediaUrls || [],
      profileImageUrl: artist.profileImageUrl || '',
      externalIds: artist.external_ids || [],
      nameVariants: artist.name_variants || [],
      isVerified: artist.isVerified || false,
      followerCount: artist.followerCount || 0,
      claimedByUserId: artist.claimedByUserId || null,
      owner_user_id: artist.owner_user_id || null,
      allowedEventTypes: artist.allowedEventTypes || ['practice', 'public_gig'],
      displayColour: artist.displayColour || '#f97316',
      source: artist.source || null,
      ai_created: artist.ai_created || false,
      needs_review: artist.needs_review !== undefined ? artist.needs_review : null,
      validated: artist.validated !== undefined ? artist.validated : true,
      createdAt: artist.createdAt
    }));

    console.log(` Artists Lambda: Served ${formattedArtists.length} artists`);

    return jsonResponse(event, 200, formattedArtists, {
      corsHeaders: getCorsHeaders(),
      cacheControl: 'public, max-age=300'
    });
  } catch (error) {
    console.error(' DynamoDB scan failed:', error);
    throw error;
  }
}

async function handleGetArtistById(artistId, event) {
  console.log(` Artists Lambda: Getting artist by ID: ${artistId}`);

  const params = {
    TableName: 'bndy-artists',
    Key: { id: artistId }
  };

  try {
    const result = await dynamodb.get(params).promise();

    if (!result.Item) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Artist not found' })
      };
    }

    // Feature 4: a hidden artist is off every public surface.
    if (result.Item.hidden === true && !event?.__allowHidden) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Artist not found', code: 'HIDDEN' })
      };
    }

    // Transform to match expected API format
    const artist = {
      id: result.Item.id,
      name: result.Item.name,
      artist_type: result.Item.artist_type || null,
      artistType: result.Item.artist_type || null, // Provide both formats for compatibility
      bio: result.Item.bio || '',
      location: result.Item.location || '',
      locationLat: result.Item.locationLat || null,
      locationLng: result.Item.locationLng || null,
      locationType: result.Item.locationType || null,
      genres: result.Item.genres || [],
      actType: result.Item.actType || null,
      acoustic: result.Item.acoustic || false,
      publishAvailability: result.Item.publishAvailability || false,
      availabilityMode: result.Item.availabilityMode || 'selected_dates_only',
      contactMethod: result.Item.contactMethod || 'phone',
      phoneNumber: result.Item.phoneNumber || null,
      whatsappNumber: result.Item.whatsappNumber || null,
      showMemberVotes: result.Item.showMemberVotes || false,
      autoDiscardThreshold: result.Item.autoDiscardThreshold ?? null,
      facebookUrl: result.Item.facebookUrl || '',
      instagramUrl: result.Item.instagramUrl || '',
      websiteUrl: result.Item.websiteUrl || '',
      youtubeUrl: result.Item.youtubeUrl || '',
      spotifyUrl: result.Item.spotifyUrl || '',
      twitterUrl: result.Item.twitterUrl || '',
      socialMediaUrls: result.Item.socialMediaUrls || [],
      profileImageUrl: result.Item.profileImageUrl || '',
      isVerified: result.Item.isVerified || false,
      followerCount: result.Item.followerCount || 0,
      claimedByUserId: result.Item.claimedByUserId || null,
      owner_user_id: result.Item.owner_user_id || null,
      allowedEventTypes: result.Item.allowedEventTypes || ['practice', 'public_gig'],
      displayColour: result.Item.displayColour || '#f97316',
      source: result.Item.source || null,
      ai_created: result.Item.ai_created || false,
      needs_review: result.Item.needs_review !== undefined ? result.Item.needs_review : null,
      external_ids: result.Item.external_ids || [],
      externalIds: result.Item.external_ids || [],
      name_variants: result.Item.name_variants || [],
      nameVariants: result.Item.name_variants || [],
      actsEnabled: result.Item.actsEnabled || false,
      acts: result.Item.acts || [],
      createdAt: result.Item.createdAt,
      updatedAt: result.Item.updatedAt,
      // Enrichment fields (2026-08-11)
      enrichmentStatus: result.Item.enrichment_status || null,
      enrichmentData: result.Item.enrichment_data || null,
      enrichmentDate: result.Item.enrichment_date || null
    };

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify(artist)
    };
  } catch (error) {
    console.error(' DynamoDB get failed:', error);
    throw error;
  }
}

/**
 * Get artist by external ID (public endpoint for MCP)
 * Scans and filters for matching external_ids entry
 */
async function handleGetArtistByExternalId(event) {
  const source = event.queryStringParameters?.source;
  const externalId = event.queryStringParameters?.id;

  console.log(`[Artists] Looking up artist by external ID: ${source}:${externalId}`);

  if (!source || !externalId) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'source and id query parameters are required' })
    };
  }

  try {
    // Scan (fully paginated) and filter for matching externalId
    const allArtistItems = await scanAll(dynamodb, {
      TableName: 'bndy-artists'
    });

    // Find artist with matching externalId
    const matchingArtist = allArtistItems.find(artist => {
      const externalIds = artist.external_ids || [];
      return externalIds.some(ext => ext.source === source && ext.id === externalId);
    });

    if (!matchingArtist) {
      return {
        statusCode: 200,
        headers: getCorsHeaders(),
        body: JSON.stringify({
          found: false,
          source,
          externalId,
          message: `No artist found with external ID ${source}:${externalId}`
        })
      };
    }

    // Transform to match expected API format
    const artist = {
      id: matchingArtist.id,
      name: matchingArtist.name,
      artistType: matchingArtist.artist_type || null,
      location: matchingArtist.location || '',
      bio: matchingArtist.bio || '',
      genres: matchingArtist.genres || [],
      profileImageUrl: matchingArtist.profileImageUrl || '',
      externalIds: matchingArtist.external_ids || [],
      facebookUrl: matchingArtist.facebookUrl || '',
      instagramUrl: matchingArtist.instagramUrl || '',
      websiteUrl: matchingArtist.websiteUrl || '',
      youtubeUrl: matchingArtist.youtubeUrl || '',
      spotifyUrl: matchingArtist.spotifyUrl || '',
      ai_created: matchingArtist.ai_created,
      needs_review: matchingArtist.needs_review,
      createdAt: matchingArtist.createdAt,
      updatedAt: matchingArtist.updated_at
    };

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        found: true,
        entityType: 'artist',
        artist,
        message: `Found artist "${artist.name}" with external ID ${source}:${externalId}`
      })
    };
  } catch (error) {
    console.error('[Artists] Error looking up by external ID:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

/**
 * Get events for an artist (public endpoint for MCP)
 * Uses artist_id-index GSI on bndy-events table
 */
async function handleGetArtistEvents(artistId, event) {
  console.log(`[ARTIST_EVENTS] Getting events for artist: ${artistId}`);

  const { dateFrom, dateTo } = event.queryStringParameters || {};

  try {
    // Build query - use artist_id-index GSI
    const queryParams = {
      TableName: 'bndy-events',
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      ExpressionAttributeValues: {
        ':artistId': artistId
      }
    };

    // Add date filter if provided
    if (dateFrom && dateTo) {
      queryParams.FilterExpression = '#date BETWEEN :dateFrom AND :dateTo';
      queryParams.ExpressionAttributeNames = { '#date': 'date' };
      queryParams.ExpressionAttributeValues[':dateFrom'] = dateFrom;
      queryParams.ExpressionAttributeValues[':dateTo'] = dateTo;
    } else if (dateFrom) {
      queryParams.FilterExpression = '#date >= :dateFrom';
      queryParams.ExpressionAttributeNames = { '#date': 'date' };
      queryParams.ExpressionAttributeValues[':dateFrom'] = dateFrom;
    } else if (dateTo) {
      queryParams.FilterExpression = '#date <= :dateTo';
      queryParams.ExpressionAttributeNames = { '#date': 'date' };
      queryParams.ExpressionAttributeValues[':dateTo'] = dateTo;
    }

    const result = await dynamodb.query(queryParams).promise();
    const events = result.Items || [];

    console.log(`[ARTIST_EVENTS] Found ${events.length} events for artist ${artistId}`);

    if (events.length === 0) {
      return {
        statusCode: 200,
        headers: getCorsHeaders(),
        body: JSON.stringify([])
      };
    }

    // Collect unique venueIds for batch lookup
    const venueIds = [...new Set(events.map(e => e.venueId).filter(Boolean))];

    // Batch get venues
    const venueMap = {};
    if (venueIds.length > 0) {
      const venuePromises = venueIds.map(id =>
        dynamodb.get({
          TableName: 'bndy-venues',
          Key: { id }
        }).promise()
      );

      const venueResults = await Promise.all(venuePromises);
      venueResults.forEach((result, idx) => {
        if (result.Item) {
          venueMap[venueIds[idx]] = result.Item;
        }
      });
    }

    // Get artist name for response
    const artistResult = await dynamodb.get({
      TableName: 'bndy-artists',
      Key: { id: artistId }
    }).promise();
    const artistName = artistResult.Item?.name || null;

    // Format events with venue details
    const formattedEvents = events.map(e => {
      const venue = e.venueId ? venueMap[e.venueId] : null;
      return {
        id: e.id,
        title: e.title,
        date: e.date,
        startTime: e.startTime || null,
        endTime: e.endTime || null,
        artistId: e.artist_id || e.artistId,
        artistName: artistName,
        venueId: e.venueId || null,
        venueName: venue?.name || null,
        venueCity: venue?.city || null
      };
    });

    // Sort by date
    formattedEvents.sort((a, b) => a.date.localeCompare(b.date));

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify(formattedEvents)
    };

  } catch (error) {
    console.error('[ARTIST_EVENTS] Error fetching events:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Failed to fetch artist events' })
    };
  }
}

async function handleCreateArtist(event) {
  console.log(' Artists Lambda: Creating new artist');

  // Require authentication for creating artists
  const authResult = await requireAuth(event);
  if (authResult.error) {
    return {
      statusCode: 401,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: authResult.error })
    };
  }

  const { user } = authResult;
  const artistData = JSON.parse(event.body);

  // Data quality validation (2026-07-27 audit follow-up)
  const validation = validateArtistData(artistData);
  if (!validation.valid) {
    console.log(`DATA_QUALITY_REJECT: Artist creation blocked - ${validation.errors.join('; ')}`);
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        error: 'data_quality_validation_failed',
        details: validation.errors
      })
    };
  }

  const now = new Date().toISOString();
  const artistId = crypto.randomUUID();

  // Fetch Facebook profile picture if no custom image provided
  let profileImageUrl = artistData.profileImageUrl || artistData.avatarUrl || '';
  if (!profileImageUrl && artistData.facebookUrl) {
    console.log('[CREATE_ARTIST] Attempting to fetch Facebook profile image...');
    const fbImage = await fetchFacebookProfilePicture(artistData.facebookUrl);
    if (fbImage) {
      profileImageUrl = fbImage;
      console.log('[CREATE_ARTIST] Facebook image fetched successfully');
    }
  }

  const artist = {
    id: artistId,
    name: artistData.name,
    ...generateNameSearchFields(artistData.name),  // Add GSI fields for fast search
    bio: artistData.bio || '',
    location: artistData.location || '',
    locationLat: artistData.locationLat || null,
    locationLng: artistData.locationLng || null,
    locationType: artistData.locationType || null,
    genres: artistData.genres || [],

    // Artist classification
    artist_type: artistData.artistType || artistData.artist_type || 'band',
    actType: artistData.actType || null,
    acoustic: artistData.acoustic || false,

    // NEW: Owner tracking
    owner_user_id: user.userId,
    member_count: 1, // Creator is first member

    // Social media
    facebookUrl: artistData.facebookUrl || '',
    instagramUrl: artistData.instagramUrl || '',
    websiteUrl: artistData.websiteUrl || '',
    socialMediaUrls: artistData.socialMediaUrls || [],
    profileImageUrl,

    // Display customization
    displayColour: artistData.displayColour || '#f97316',

    isVerified: false,
    followerCount: 0,
    claimedByUserId: null, // Deprecated - use owner_user_id

    // Data quality tracking
    source: 'backstage',   // Artist self-created = cleanest data
    needs_review: false,   // No review needed for authenticated artist creation

    // Name variants for alternative billing strings
    name_variants: artistData.nameVariants || [],

    createdAt: now,
    updated_at: now
  };

  try {
    // HARD GATE (2026-07-27): same rule as every other create path — the
    // authenticated Backstage route was previously a zero-dedup blind put.
    const { keys: uniqueKeys, resolvable } = buildArtistUniqueKeys(
      artist.name, artist.location, artist.facebookUrl, artist.name_variants
    );
    if (!resolvable && gateMode() === 'enforce') {
      return {
        statusCode: 422,
        headers: getCorsHeaders(),
        body: JSON.stringify({
          error: 'A resolvable location (town/county) is required to create an artist — it is part of the artist\'s identity.',
          code: 'LOCATION_UNRESOLVABLE'
        })
      };
    }
    const gateResult = await gatedPut(dynamodb, {
      tableName: 'bndy-artists',
      item: artist,
      keys: uniqueKeys,
      entityType: 'artist',
      source: 'backstage'
    });
    if (!gateResult.written) {
      return {
        statusCode: 409,
        headers: getCorsHeaders(),
        body: JSON.stringify({
          ...duplicateResponseBody('artist', gateResult.existing),
          message: 'An artist with this name already exists in this region. Claim or edit the existing record instead.'
        })
      };
    }

    // Create owner membership automatically
    const membershipId = crypto.randomUUID();
    const membership = {
      membership_id: membershipId,
      user_id: user.userId,
      artist_id: artistId,
      membership_type: 'performer',
      role: 'owner',

      // Profile fields (null = inherit from user profile)
      display_name: artistData.memberDisplayName || null,
      avatar_url: null,
      instrument: artistData.memberInstrument || null,
      bio: null,

      // UI fields
      icon: artistData.memberIcon || 'fa-music',
      color: artistData.memberColor || '#708090',

      // Owner gets all permissions
      permissions: [
        'manage_members',
        'manage_gigs',
        'manage_songs',
        'manage_finances',
        'manage_settings'
      ],

      joined_at: now,
      invited_at: null,
      invited_by_user_id: null,
      status: 'active',

      created_at: now,
      updated_at: now
    };

    await dynamodb.put({
      TableName: MEMBERSHIPS_TABLE,
      Item: membership
    }).promise();

    console.log(' Artist and owner membership created successfully');

    return {
      statusCode: 201,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        artist: artist,
        membership: membership,
        message: 'Artist created successfully'
      })
    };
  } catch (error) {
    console.error(' DynamoDB put failed:', error);
    throw error;
  }
}

async function handleUpdateArtist(event) {
  const artistId = event.pathParameters.id;
  const artistData = JSON.parse(event.body);

  console.log(` Artists Lambda: Updating artist: ${artistId}`);

  // Require authentication
  const authResult = await requireAuth(event);
  if (authResult.error) {
    return {
      statusCode: 401,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: authResult.error })
    };
  }

  const { user } = authResult;

  // Validate enum fields
  if (artistData.availabilityMode !== undefined &&
      !['selected_dates_only', 'free_weekends'].includes(artistData.availabilityMode)) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Invalid availabilityMode. Must be "selected_dates_only" or "free_weekends".' })
    };
  }

  if (artistData.contactMethod !== undefined &&
      !['phone', 'whatsapp'].includes(artistData.contactMethod)) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Invalid contactMethod. Must be "phone" or "whatsapp".' })
    };
  }

  // Check access - platform admin OR member OR an approved curator wrapper
  // (feature 4: __curatorApproved is set internally after a role gate — it can
  // never arrive on an external request object)
  if (!user.platformAdmin && event.__curatorApproved !== true) {
    const membershipResult = await dynamodb.query({
      TableName: MEMBERSHIPS_TABLE,
      IndexName: 'user_id-index',
      KeyConditionExpression: 'user_id = :userId',
      FilterExpression: 'artist_id = :artistId',
      ExpressionAttributeValues: {
        ':userId': user.userId,
        ':artistId': artistId
      }
    }).promise();

    const hasMembership = membershipResult.Items && membershipResult.Items.length > 0;
    if (!hasMembership) {
      console.log('[ARTISTS] Access denied - no membership and not platform admin');
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Access denied' })
      };
    }
  } else {
    console.log('[ARTISTS] Platform admin access granted for artist update');
  }

  const now = new Date().toISOString();

  // Build update expression dynamically to only update provided fields
  const updateParts = [];
  const expressionAttributeNames = {
    '#name': 'name',
    '#location': 'location'
  };
  const expressionAttributeValues = {
    ':updated_at': now
  };

  // Always update timestamp
  updateParts.push('updated_at = :updated_at');

  // Update only fields that are provided in artistData
  if (artistData.name !== undefined) {
    const searchFields = generateNameSearchFields(artistData.name);
    updateParts.push('#name = :name', 'name_lower = :name_lower', 'name_prefix = :name_prefix');
    expressionAttributeValues[':name'] = artistData.name;
    expressionAttributeValues[':name_lower'] = searchFields.name_lower;
    expressionAttributeValues[':name_prefix'] = searchFields.name_prefix;
  }
  if (artistData.bio !== undefined) {
    updateParts.push('bio = :bio');
    expressionAttributeValues[':bio'] = artistData.bio || '';
  }
  if (artistData.location !== undefined) {
    updateParts.push('#location = :location');
    expressionAttributeValues[':location'] = artistData.location || '';
  }
  if (artistData.locationLat !== undefined) {
    updateParts.push('locationLat = :locationLat');
    expressionAttributeValues[':locationLat'] = artistData.locationLat;
  }
  if (artistData.locationLng !== undefined) {
    updateParts.push('locationLng = :locationLng');
    expressionAttributeValues[':locationLng'] = artistData.locationLng;
  }
  if (artistData.locationType !== undefined) {
    updateParts.push('locationType = :locationType');
    expressionAttributeValues[':locationType'] = artistData.locationType;
  }
  if (artistData.genres !== undefined) {
    // Genre validation (2026-07-31): normalise and reject off-list values
    const { normaliseGenres, GENRES } = require('./lib/genres');
    const genreResult = normaliseGenres(artistData.genres);
    if (genreResult.invalid.length > 0) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({
          error: 'Invalid genres',
          code: 'INVALID_GENRES',
          invalidGenres: genreResult.invalid,
          validGenres: GENRES
        })
      };
    }
    updateParts.push('genres = :genres');
    expressionAttributeValues[':genres'] = genreResult.valid;
  }
  if (artistData.artistType !== undefined) {
    updateParts.push('artist_type = :artist_type');
    expressionAttributeValues[':artist_type'] = artistData.artistType;
  }
  if (artistData.actType !== undefined) {
    updateParts.push('actType = :actType');
    expressionAttributeValues[':actType'] = artistData.actType || null;
  }
  if (artistData.acoustic !== undefined) {
    updateParts.push('acoustic = :acoustic');
    expressionAttributeValues[':acoustic'] = artistData.acoustic || false;
  }
  if (artistData.publishAvailability !== undefined) {
    updateParts.push('publishAvailability = :publishAvailability');
    expressionAttributeValues[':publishAvailability'] = artistData.publishAvailability || false;
  }
  if (artistData.showMemberVotes !== undefined) {
    updateParts.push('showMemberVotes = :showMemberVotes');
    expressionAttributeValues[':showMemberVotes'] = artistData.showMemberVotes || false;
  }
  if (artistData.autoDiscardThreshold !== undefined) {
    updateParts.push('autoDiscardThreshold = :autoDiscardThreshold');
    expressionAttributeValues[':autoDiscardThreshold'] = artistData.autoDiscardThreshold;  // Can be null to disable
  }
  if (artistData.isVerified !== undefined) {
    updateParts.push('isVerified = :isVerified');
    expressionAttributeValues[':isVerified'] = artistData.isVerified;
  }
  if (artistData.profileImageUrl !== undefined) {
    updateParts.push('profileImageUrl = :profileImageUrl');
    expressionAttributeValues[':profileImageUrl'] = artistData.profileImageUrl || '';
  }
  if (artistData.allowedEventTypes !== undefined) {
    updateParts.push('allowedEventTypes = :allowedEventTypes');
    expressionAttributeValues[':allowedEventTypes'] = artistData.allowedEventTypes;
  }
  if (artistData.displayColour !== undefined) {
    updateParts.push('displayColour = :displayColour');
    expressionAttributeValues[':displayColour'] = artistData.displayColour;
  }
  if (artistData.facebookUrl !== undefined) {
    updateParts.push('facebookUrl = :facebookUrl');
    expressionAttributeValues[':facebookUrl'] = artistData.facebookUrl || null;

    // Auto-fetch Facebook profile image if facebookUrl is being set and profileImageUrl is not explicitly provided
    if (artistData.facebookUrl && artistData.profileImageUrl === undefined) {
      console.log('[UPDATE_ARTIST] Attempting to fetch Facebook profile image...');
      const fbImage = await fetchFacebookProfilePicture(artistData.facebookUrl);
      if (fbImage) {
        console.log('[UPDATE_ARTIST] Facebook image fetched successfully:', fbImage);
        updateParts.push('profileImageUrl = :profileImageUrl');
        expressionAttributeValues[':profileImageUrl'] = fbImage;
      }
    }
  }
  if (artistData.instagramUrl !== undefined) {
    updateParts.push('instagramUrl = :instagramUrl');
    expressionAttributeValues[':instagramUrl'] = artistData.instagramUrl || null;
  }
  if (artistData.websiteUrl !== undefined) {
    updateParts.push('websiteUrl = :websiteUrl');
    expressionAttributeValues[':websiteUrl'] = artistData.websiteUrl || null;
  }
  if (artistData.youtubeUrl !== undefined) {
    updateParts.push('youtubeUrl = :youtubeUrl');
    expressionAttributeValues[':youtubeUrl'] = artistData.youtubeUrl || null;
  }
  if (artistData.spotifyUrl !== undefined) {
    updateParts.push('spotifyUrl = :spotifyUrl');
    expressionAttributeValues[':spotifyUrl'] = artistData.spotifyUrl || null;
  }
  if (artistData.twitterUrl !== undefined) {
    updateParts.push('twitterUrl = :twitterUrl');
    expressionAttributeValues[':twitterUrl'] = artistData.twitterUrl || null;
  }

  // Availability settings (2026-07-31)
  if (artistData.availabilityMode !== undefined) {
    updateParts.push('availabilityMode = :availabilityMode');
    expressionAttributeValues[':availabilityMode'] = artistData.availabilityMode;
  }
  if (artistData.contactMethod !== undefined) {
    updateParts.push('contactMethod = :contactMethod');
    expressionAttributeValues[':contactMethod'] = artistData.contactMethod;
  }
  if (artistData.phoneNumber !== undefined) {
    updateParts.push('phoneNumber = :phoneNumber');
    expressionAttributeValues[':phoneNumber'] = artistData.phoneNumber;
  }
  if (artistData.whatsappNumber !== undefined) {
    updateParts.push('whatsappNumber = :whatsappNumber');
    expressionAttributeValues[':whatsappNumber'] = artistData.whatsappNumber;
  }

  // Allow updating needs_review (for admin review workflow)
  if (artistData.needs_review !== undefined) {
    updateParts.push('needs_review = :needs_review');
    expressionAttributeValues[':needs_review'] = artistData.needs_review;
  }

  // Allow updating validated (for admin validation workflow)
  if (artistData.validated !== undefined) {
    updateParts.push('validated = :validated');
    expressionAttributeValues[':validated'] = artistData.validated;
  }

  // Enrichment fields (2026-08-11)
  if (artistData.enrichmentStatus !== undefined) {
    updateParts.push('enrichment_status = :enrichment_status');
    expressionAttributeValues[':enrichment_status'] = artistData.enrichmentStatus;
  }
  if (artistData.enrichmentData !== undefined) {
    updateParts.push('enrichment_data = :enrichment_data');
    expressionAttributeValues[':enrichment_data'] = artistData.enrichmentData;
  }
  if (artistData.enrichmentDate !== undefined) {
    updateParts.push('enrichment_date = :enrichment_date');
    expressionAttributeValues[':enrichment_date'] = artistData.enrichmentDate;
  }

  // Allow updating source (for enabling artists in backstage - platform admin only)
  if (artistData.source !== undefined) {
    expressionAttributeNames['#source'] = 'source';
    updateParts.push('#source = :source');
    expressionAttributeValues[':source'] = artistData.source;
  }

  // Acts model fields (#60) - actsEnabled toggle
  if (artistData.actsEnabled !== undefined) {
    updateParts.push('actsEnabled = :actsEnabled');
    expressionAttributeValues[':actsEnabled'] = artistData.actsEnabled;
  }

  // Acts array - typically managed via dedicated acts routes, but allow direct update
  if (artistData.acts !== undefined) {
    updateParts.push('acts = :acts');
    expressionAttributeValues[':acts'] = artistData.acts || [];
  }

  // External IDs - additive merge (Fix #2: 2026-07-29)
  // MCP imports and other sources add externalIds; must merge, not replace
  if (artistData.externalIds !== undefined) {
    // Read existing to merge
    const existingRes = await dynamodb.get({ TableName: 'bndy-artists', Key: { id: artistId } }).promise();
    const existingExternalIds = existingRes.Item?.external_ids || [];
    const mergedExternalIds = mergeExternalIds(existingExternalIds, artistData.externalIds);

    updateParts.push('external_ids = :external_ids');
    expressionAttributeValues[':external_ids'] = mergedExternalIds;
  }

  // Name variants - additive merge (Fix #3a: 2026-07-29)
  // Known billing variations (e.g., "Danny & Friends" for "Danny Brab") accumulate
  if (artistData.nameVariants !== undefined) {
    // Read existing to merge (may already be loaded above for externalIds)
    const existingRes = await dynamodb.get({ TableName: 'bndy-artists', Key: { id: artistId } }).promise();
    const existingNameVariants = existingRes.Item?.name_variants || [];
    const mergedNameVariants = mergeNameVariants(existingNameVariants, artistData.nameVariants);

    updateParts.push('name_variants = :name_variants');
    expressionAttributeValues[':name_variants'] = mergedNameVariants;
  }

  const params = {
    TableName: 'bndy-artists',
    Key: { id: artistId },
    UpdateExpression: `SET ${updateParts.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW'
  };

  try {
    // GATE FIX 2026-07-28: renames/relocations must re-key sentinels — a name/
    // location/FB change alters the artist's identity keys. Claim new + release
    // old atomically; enforce-mode collision = this update would create a
    // duplicate identity → 409, update NOT performed.
    // Re-key when name/location/fb changes OR when nameVariants are added
    const needsRekey = artistData.name !== undefined || artistData.location !== undefined ||
                       artistData.facebookUrl !== undefined || artistData.nameVariants !== undefined;
    if (needsRekey) {
      const existingRes = await dynamodb.get({ TableName: 'bndy-artists', Key: { id: artistId } }).promise();
      if (existingRes.Item) {
        const cur = existingRes.Item;
        const effName = artistData.name !== undefined ? artistData.name : cur.name;
        const effLocation = artistData.location !== undefined ? artistData.location : cur.location;
        const effFb = artistData.facebookUrl !== undefined ? artistData.facebookUrl : cur.facebookUrl;
        // For nameVariants: old keys use existing variants, new keys use merged variants
        const curVariants = cur.name_variants || [];
        const effVariants = artistData.nameVariants !== undefined
          ? mergeNameVariants(curVariants, artistData.nameVariants)
          : curVariants;
        const rekey = await rekeyUniqueKeys(dynamodb, {
          oldKeys: buildArtistUniqueKeys(cur.name, cur.location, cur.facebookUrl, curVariants).keys,
          newKeys: buildArtistUniqueKeys(effName, effLocation, effFb, effVariants).keys,
          refId: artistId,
          entityType: 'artist',
          source: 'backstage-update'
        });
        if (rekey.changed && rekey.ok === false) {
          return {
            statusCode: 409,
            headers: getCorsHeaders(),
            body: JSON.stringify({
              ...duplicateResponseBody('artist', rekey.existing),
              message: 'This rename/relocation/variant would make the artist a duplicate of an existing record. Merge instead.'
            })
          };
        }
      }
    }

    const result = await dynamodb.update(params).promise();

    // Transform response to match frontend expectations (snake_case -> camelCase)
    const transformedArtist = {
      ...result.Attributes,
      artistType: result.Attributes.artist_type || null,  // Provide camelCase for compatibility
      externalIds: result.Attributes.external_ids || [],  // Provide camelCase for frontend (Fix #2)
      nameVariants: result.Attributes.name_variants || [] // Provide camelCase for frontend (Fix #3a)
    };

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify(transformedArtist)
    };
  } catch (error) {
    console.error(' DynamoDB update failed:', error);
    throw error;
  }
}

/**
 * Handle enrichment action (accept/reject)
 * PATCH /api/artists/:id/enrichment
 *
 * Body: { action: 'accept' | 'reject', fields?: string[] }
 * - accept: Copy selected fields from enrichment_data to main profile
 * - reject: Clear enrichment_data without applying changes
 */
async function handleEnrichmentAction(event) {
  const artistId = event.pathParameters?.id;
  const body = JSON.parse(event.body || '{}');
  const { action, fields } = body;

  console.log(`[ENRICHMENT_ACTION] Artist ${artistId}: action=${action}, fields=${JSON.stringify(fields)}`);

  if (!action || !['accept', 'reject'].includes(action)) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'action must be "accept" or "reject"' })
    };
  }

  try {
    // Get current artist
    const getParams = {
      TableName: 'bndy-artists',
      Key: { id: artistId }
    };
    const result = await dynamodb.get(getParams).promise();

    if (!result.Item) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Artist not found' })
      };
    }

    const artist = result.Item;
    const enrichmentData = artist.enrichment_data;

    if (!enrichmentData) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'No enrichment data to process' })
      };
    }

    const updateParts = ['updatedAt = :updatedAt'];
    const expressionAttributeValues = {
      ':updatedAt': new Date().toISOString()
    };

    if (action === 'accept') {
      // Determine which fields to accept
      const fieldsToAccept = fields || Object.keys(enrichmentData)
        .filter(k => k.startsWith('suggested_'))
        .map(k => k.replace('suggested_', ''));

      // Copy selected suggested fields to main profile
      for (const field of fieldsToAccept) {
        const suggestedKey = `suggested_${field}`;
        if (enrichmentData[suggestedKey] !== undefined) {
          updateParts.push(`${field} = :${field}`);
          expressionAttributeValues[`:${field}`] = enrichmentData[suggestedKey];
        }
      }

      // Mark as reviewed
      updateParts.push('enrichment_status = :enrichment_status');
      expressionAttributeValues[':enrichment_status'] = 'reviewed';
    } else {
      // Mark as rejected
      updateParts.push('enrichment_status = :enrichment_status');
      expressionAttributeValues[':enrichment_status'] = 'rejected';
    }

    // Clear enrichment_data after processing
    updateParts.push('enrichment_data = :enrichment_data');
    expressionAttributeValues[':enrichment_data'] = null;

    const updateParams = {
      TableName: 'bndy-artists',
      Key: { id: artistId },
      UpdateExpression: `SET ${updateParts.join(', ')}`,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    };

    const updateResult = await dynamodb.update(updateParams).promise();

    console.log(`[ENRICHMENT_ACTION] Successfully processed enrichment for artist ${artistId}`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        ...updateResult.Attributes,
        artistType: updateResult.Attributes.artist_type || null,
        enrichmentStatus: updateResult.Attributes.enrichment_status || null,
        enrichmentData: updateResult.Attributes.enrichment_data || null,
        enrichmentDate: updateResult.Attributes.enrichment_date || null
      })
    };
  } catch (error) {
    console.error('[ENRICHMENT_ACTION] Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleCheckName(event) {
  console.log(' Artists Lambda: Checking name availability');

  const name = event.queryStringParameters?.name;

  if (!name || !name.trim()) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Name parameter is required' })
    };
  }

  try {
    // Scan all artists and filter case-insensitively in code
    // DynamoDB doesn't support lower() function, so we fetch and filter
    const params = {
      TableName: 'bndy-artists',
      ProjectionExpression: 'id, #name, bio, #location',
      ExpressionAttributeNames: {
        '#name': 'name',
        '#location': 'location'
      }
    };

    const result = await dynamodb.scan(params).promise();

    // Case-insensitive comparison
    const normalizedSearchName = name.toLowerCase().trim();
    const matches = result.Items.filter(item =>
      item.name && item.name.toLowerCase().trim() === normalizedSearchName
    );

    const available = matches.length === 0;

    console.log(` Name "${name}" availability: ${available}, found ${matches.length} matches`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        available,
        existingId: matches.length > 0 ? matches[0].id : null,
        existingName: matches.length > 0 ? matches[0].name : null,
        existingLocation: matches.length > 0 ? (matches[0].location || null) : null,
        totalMatches: matches.length,
        matches: matches.map(m => ({
          id: m.id,
          name: m.name,
          location: m.location || null
        }))
      })
    };
  } catch (error) {
    console.error(' DynamoDB scan failed:', error);
    throw error;
  }
}

async function handleRefreshFacebookImage(artistId) {
  console.log(`[REFRESH_FB_IMAGE] Refreshing Facebook image for artist: ${artistId}`);

  try {
    // Get artist
    const getParams = {
      TableName: 'bndy-artists',
      Key: { id: artistId }
    };

    const result = await dynamodb.get(getParams).promise();
    if (!result.Item) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Artist not found' })
      };
    }

    const artist = result.Item;

    // Check if artist has Facebook URL
    if (!artist.facebookUrl) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Artist has no Facebook URL' })
      };
    }

    // Fetch Facebook profile picture
    console.log(`[REFRESH_FB_IMAGE] Fetching image from: ${artist.facebookUrl}`);
    const fbImage = await fetchFacebookProfilePicture(artist.facebookUrl);

    if (!fbImage) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Could not fetch Facebook profile image' })
      };
    }

    // Update artist with new image
    const updateParams = {
      TableName: 'bndy-artists',
      Key: { id: artistId },
      UpdateExpression: 'SET profileImageUrl = :profileImageUrl, updated_at = :updated_at',
      ExpressionAttributeValues: {
        ':profileImageUrl': fbImage,
        ':updated_at': new Date().toISOString()
      },
      ReturnValues: 'ALL_NEW'
    };

    const updateResult = await dynamodb.update(updateParams).promise();
    console.log(`[REFRESH_FB_IMAGE] Successfully updated profile image for artist: ${artistId}`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        message: 'Profile image refreshed successfully',
        profileImageUrl: fbImage,
        artist: updateResult.Attributes
      })
    };
  } catch (error) {
    console.error('[REFRESH_FB_IMAGE] Error refreshing Facebook image:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

async function handleDeleteArtist(artistId) {
  console.log(` Artists Lambda: Deleting artist: ${artistId}`);

  try {
    // Step 1: Check if any events reference this artist (Fix #6b, 2026-07-29)
    // Refuse deletion to prevent orphan events with dead artistIds
    const eventCheck = await countEventsForArtist(dynamodb, artistId);
    if (eventCheck.totalCount > 0) {
      console.log(` ✗ Artist ${artistId} has ${eventCheck.totalCount} events - refusing deletion`);
      return {
        statusCode: 409,
        headers: getCorsHeaders(),
        body: JSON.stringify({
          error: 'Artist has events',
          code: 'ARTIST_HAS_EVENTS',
          message: `This artist has ${eventCheck.totalCount} event(s). Delete them too?`,
          artistId,
          eventCount: eventCheck.totalCount,
          requiresConfirmation: true
        })
      };
    }

    // Step 2: Query all memberships for this artist
    const membershipQueryParams = {
      TableName: MEMBERSHIPS_TABLE,
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      ExpressionAttributeValues: {
        ':artistId': artistId
      }
    };

    const membershipsResult = await dynamodb.query(membershipQueryParams).promise();
    console.log(` Found ${membershipsResult.Items.length} memberships to delete`);

    // Step 3: Delete all memberships (cascade delete)
    for (const membership of membershipsResult.Items) {
      await dynamodb.delete({
        TableName: MEMBERSHIPS_TABLE,
        Key: { membership_id: membership.membership_id }
      }).promise();
      console.log(` Deleted membership: ${membership.membership_id} for user: ${membership.user_id}`);
    }

    // Step 4: Delete the artist record (fetch first so the uniqueness
    // sentinels can be released — gate plan 2026-07-27)
    const artistParams = {
      TableName: 'bndy-artists',
      Key: { id: artistId }
    };

    const artistRecord = await dynamodb.get(artistParams).promise();
    await dynamodb.delete(artistParams).promise();
    if (artistRecord.Item) {
      const { keys } = buildArtistUniqueKeys(artistRecord.Item.name, artistRecord.Item.location, artistRecord.Item.facebookUrl, artistRecord.Item.name_variants);
      await releaseUniqueKeys(dynamodb, keys, artistId);
    }
    console.log(` Artist deleted successfully with ${membershipsResult.Items.length} cascaded membership deletions`);

    return {
      statusCode: 204,
      headers: getCorsHeaders(),
      body: ''
    };
  } catch (error) {
    console.error(' Artist deletion failed:', error);
    throw error;
  }
}

/**
 * Force delete artist and all associated events (cascade delete)
 * Called when user confirms deletion after 409 response
 */
async function handleForceDeleteArtist(artistId) {
  console.log(` Artists Lambda: Force deleting artist and events: ${artistId}`);

  try {
    // Step 1: Get all event IDs for this artist
    const eventCheck = await countEventsForArtist(dynamodb, artistId);
    console.log(` Found ${eventCheck.totalCount} events to cascade delete`);

    // Step 2: Delete all events referencing this artist
    if (eventCheck.totalCount > 0) {
      await deleteArtistEvents(dynamodb, artistId, eventCheck.eventIds);
      console.log(` Deleted ${eventCheck.totalCount} events`);
    }

    // Step 3: Delete memberships (cascade)
    const membershipQueryParams = {
      TableName: MEMBERSHIPS_TABLE,
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      ExpressionAttributeValues: {
        ':artistId': artistId
      }
    };

    const membershipsResult = await dynamodb.query(membershipQueryParams).promise();
    console.log(` Found ${membershipsResult.Items.length} memberships to delete`);

    for (const membership of membershipsResult.Items) {
      await dynamodb.delete({
        TableName: MEMBERSHIPS_TABLE,
        Key: { membership_id: membership.membership_id }
      }).promise();
    }

    // Step 4: Delete the artist record + release uniqueness sentinels
    const artistParams = {
      TableName: 'bndy-artists',
      Key: { id: artistId }
    };

    const artistRecord = await dynamodb.get(artistParams).promise();
    await dynamodb.delete(artistParams).promise();
    if (artistRecord.Item) {
      const { keys } = buildArtistUniqueKeys(artistRecord.Item.name, artistRecord.Item.location, artistRecord.Item.facebookUrl, artistRecord.Item.name_variants);
      await releaseUniqueKeys(dynamodb, keys, artistId);
    }

    console.log(` Force delete complete: artist ${artistId}, ${eventCheck.totalCount} events, ${membershipsResult.Items.length} memberships`);

    return {
      statusCode: 204,
      headers: getCorsHeaders(),
      body: ''
    };
  } catch (error) {
    console.error(' Artist force deletion failed:', error);
    throw error;
  }
}

// DELETE /api/artists/:id/mcp - Delete artist via MCP (NO AUTH)
// Allows deletion of ANY artist record via MCP
async function handleMCPDeleteArtist(artistId) {
  console.log(` Artists Lambda MCP: Delete request for artist: ${artistId}`);

  try {
    // Step 1: Fetch artist to verify it exists
    const artistResult = await dynamodb.get({
      TableName: 'bndy-artists',
      Key: { id: artistId }
    }).promise();

    if (!artistResult.Item) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Artist not found', id: artistId })
      };
    }

    // Step 2: Check if any events reference this artist (Fix #6b, 2026-07-29)
    // CHANGED: No longer cascade-deletes events - refuses deletion instead
    // to prevent orphan events with dead artistIds
    const hasEvents = await hasEventsForArtist(dynamodb, artistId);
    if (hasEvents) {
      console.log(` ✗ MCP: Artist ${artistId} has events - refusing deletion`);
      return {
        statusCode: 409,
        headers: getCorsHeaders(),
        body: JSON.stringify({
          error: 'Artist has events',
          code: 'ARTIST_HAS_EVENTS',
          message: 'Cannot delete artist while events reference it. Delete or reassign events first.',
          artistId
        })
      };
    }

    // Step 3: Delete memberships (cascade)
    const membershipQueryParams = {
      TableName: MEMBERSHIPS_TABLE,
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      ExpressionAttributeValues: {
        ':artistId': artistId
      }
    };

    const membershipsResult = await dynamodb.query(membershipQueryParams).promise();
    console.log(` Found ${membershipsResult.Items.length} memberships to delete`);

    for (const membership of membershipsResult.Items) {
      await dynamodb.delete({
        TableName: MEMBERSHIPS_TABLE,
        Key: { membership_id: membership.membership_id }
      }).promise();
    }

    // Step 4: Delete the artist record + release uniqueness sentinels
    // (artistResult.Item was fetched in Step 1)
    await dynamodb.delete({
      TableName: 'bndy-artists',
      Key: { id: artistId }
    }).promise();

    if (artistResult.Item) {
      const { keys } = buildArtistUniqueKeys(artistResult.Item.name, artistResult.Item.location, artistResult.Item.facebookUrl, artistResult.Item.name_variants);
      await releaseUniqueKeys(dynamodb, keys, artistId);
    }

    console.log(` MCP: Artist ${artistId} deleted successfully`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        message: 'Artist deleted successfully',
        id: artistId,
        cascadedMemberships: membershipsResult.Items.length
      })
    };
  } catch (error) {
    console.error(' MCP artist deletion failed:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

// ============================================================================
// COMMUNITY WIZARD ENDPOINTS (Public, No Auth Required)
// ============================================================================

// Levenshtein distance for fuzzy matching
function levenshteinDistance(str1, str2) {
  const matrix = [];
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[str2.length][str1.length];
}

// Simple match score - just contains/starts-with matching
function calculateMatchScore(artistName, artistLocation, queryName, queryLocation) {
  const nameLower = artistName.toLowerCase().trim();
  const queryLower = queryName.toLowerCase().trim();

  // Exact match = 100
  if (nameLower === queryLower) {
    return 100;
  }

  // Starts with query = very high score
  if (nameLower.startsWith(queryLower)) {
    return 95;
  }

  // Contains query anywhere = good score
  if (nameLower.includes(queryLower)) {
    return 85;
  }

  // Check if any word starts with query
  const artistWords = nameLower.split(/\s+/);
  for (const word of artistWords) {
    if (word.startsWith(queryLower)) {
      return 80;
    }
  }

  // Check if any word contains query
  for (const word of artistWords) {
    if (word.includes(queryLower)) {
      return 70;
    }
  }

  // No match
  return 0;
}

// Generate GSI fields for fast name search
function generateNameSearchFields(name) {
  const nameLower = name.toLowerCase().trim();
  const namePrefix = nameLower.substring(0, 2);
  return { name_lower: nameLower, name_prefix: namePrefix };
}

// Search artists (fuzzy matching for duplicate prevention)
async function handleSearchArtists(event) {
  console.log(' Artists Lambda: Searching artists using GSI Query');

  const { name, location } = event.queryStringParameters || {};

  if (!name || name.length < 2) {
    return {
      statusCode: 400,
      headers: getCommunityHeaders(),
      body: JSON.stringify({ error: 'Name query must be at least 2 characters' })
    };
  }

  try {
    const searchTerm = name.toLowerCase().trim();
    const prefix = searchTerm.substring(0, 2); // Use first 2 letters as partition key

    // Query GSI for artists with matching prefix
    const result = await dynamodb.query({
      TableName: 'bndy-artists',
      IndexName: 'name-search-index',
      KeyConditionExpression: 'name_prefix = :prefix AND begins_with(name_lower, :searchTerm)',
      ExpressionAttributeValues: {
        ':prefix': prefix,
        ':searchTerm': searchTerm
      },
      ProjectionExpression: 'id, #name, bio, #location, locationLat, locationLng, locationType, profileImageUrl',
      ExpressionAttributeNames: {
        '#name': 'name',
        '#location': 'location'
      },
      Limit: 20  // Get up to 20 results
    }).promise();

    // Calculate match scores for ranking
    const matches = result.Items
      .map(artist => ({
        id: artist.id,
        name: artist.name,
        location: artist.location || '',
        locationLat: artist.locationLat || null,
        locationLng: artist.locationLng || null,
        locationType: artist.locationType || null,
        profileImageUrl: artist.profileImageUrl || null,
        matchScore: calculateMatchScore(artist.name, artist.location, name, location || '')
      }))
      .filter(artist => artist.matchScore > 0)  // Only show actual matches
      .sort((a, b) => b.matchScore - a.matchScore)  // Highest score first
      .slice(0, 10);  // Top 10 matches

    console.log(` Found ${matches.length} matches for "${name}" using GSI Query`);

    return {
      statusCode: 200,
      headers: getCommunityHeaders(),
      body: JSON.stringify({ matches })
    };
  } catch (error) {
    console.error(' Artist search failed:', error);
    throw error;
  }
}

// Generate random color for displayColour
function randomColor() {
  const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
  return colors[Math.floor(Math.random() * colors.length)];
}

// Create community artist (public endpoint, no auth)
async function handleCreateCommunityArtist(event) {
  console.log(' Artists Lambda: Creating community artist');

  try {
    const body = JSON.parse(event.body);
    const { name, location, locationType, locationLat, locationLng, facebookUrl, instagramUrl, websiteUrl, bio, genres, artist_type, artistType, actType, acoustic, profileImageUrl, externalIds, nameVariants, verifiedSourceName } = body;

    // Validation
    if (!name || name.trim().length === 0) {
      return {
        statusCode: 400,
        headers: getCommunityHeaders(),
        body: JSON.stringify({ error: 'Artist name is required' })
      };
    }

    if (!location || location.trim().length === 0) {
      return {
        statusCode: 400,
        headers: getCommunityHeaders(),
        body: JSON.stringify({ error: 'Location is required to prevent duplicates' })
      };
    }

    // GATE VERIFICATION FIX 2026-07-28: this unauthenticated route was the ONLY
    // create path not running data-quality validation — lineup names ("A + B"),
    // placeholders ("TBC") and listing-copy names could still be created here.
    // Same check as handleCreateArtist (:821) and find-or-create (:2123).
    //
    // Fix #7 (2026-07-30): §2A.5 verified-source-name exception.
    // If verifiedSourceName=true AND facebookUrl is provided, bypass the
    // listing-copy detector. The caller asserts the name was taken from the
    // act's own Facebook page — e.g., "NU CALL - Nu-Metal Tribute Band".
    const dataQualityCheck = validateArtistData({ name }, {
      verifiedSourceName: verifiedSourceName === true,
      facebookUrl: facebookUrl || ''
    });
    if (!dataQualityCheck.valid) {
      console.warn(`[Artists] Community create rejected by data-quality gate: ${JSON.stringify(dataQualityCheck.errors)}`);
      return {
        statusCode: 422,
        headers: getCommunityHeaders(),
        body: JSON.stringify({
          error: 'Artist name failed data-quality validation',
          code: 'DATA_QUALITY',
          errors: dataQualityCheck.errors
        })
      };
    }

    // Genre validation (2026-07-31): normalise and reject off-list values
    const { normaliseGenres, GENRES } = require('./lib/genres');
    const genreResult = normaliseGenres(genres);
    if (genreResult.invalid.length > 0) {
      console.warn(`[Artists] Community create rejected: invalid genres ${JSON.stringify(genreResult.invalid)}`);
      return {
        statusCode: 400,
        headers: getCommunityHeaders(),
        body: JSON.stringify({
          error: 'Invalid genres',
          code: 'INVALID_GENRES',
          invalidGenres: genreResult.invalid,
          validGenres: GENRES
        })
      };
    }

    const now = new Date().toISOString();
    const artistId = crypto.randomUUID();

    // Handle profile image from multiple sources (priority order)
    let finalProfileImageUrl = '';

    // Priority 1: Provided external URL (MCP imports)
    if (profileImageUrl) {
      console.log('[CREATE_COMMUNITY_ARTIST] External profileImageUrl provided, attempting download & S3 upload...');
      try {
        const s3Url = await downloadAndUploadImageToS3(profileImageUrl, artistId, name.trim());
        if (s3Url) {
          finalProfileImageUrl = s3Url;
          console.log('[CREATE_COMMUNITY_ARTIST] Image uploaded to S3 successfully');
        } else {
          console.warn('[CREATE_COMMUNITY_ARTIST] Image download/upload failed, will try Facebook fallback');
        }
      } catch (error) {
        console.error('[CREATE_COMMUNITY_ARTIST] Error downloading/uploading image:', error.message);
        // Continue to Facebook fallback
      }
    }

    // Priority 2: Facebook URL fallback (existing Frontstage behavior)
    if (!finalProfileImageUrl && facebookUrl) {
      console.log('[CREATE_COMMUNITY_ARTIST] Attempting to fetch Facebook profile image...');
      const fbImage = await fetchFacebookProfilePicture(facebookUrl);
      if (fbImage) {
        finalProfileImageUrl = fbImage;
        console.log('[CREATE_COMMUNITY_ARTIST] Facebook image fetched successfully');
      }
    }

    // Handle location coordinates based on type
    let finalLocationLat = null;
    let finalLocationLng = null;

    if (locationType === 'city' && locationLat && locationLng) {
      // City-specific location with coordinates from Google Places
      finalLocationLat = locationLat;
      finalLocationLng = locationLng;
      console.log(`[CREATE_COMMUNITY_ARTIST] City location with coordinates: ${locationLat}, ${locationLng}`);
    } else {
      // Regional or national location - no specific coordinates
      console.log(`[CREATE_COMMUNITY_ARTIST] Regional/national location: ${location}`);
    }

    const newArtist = {
      id: artistId,
      name: name.trim(),
      ...generateNameSearchFields(name.trim()),  // Add GSI fields for fast search
      location: location.trim(),
      locationLat: finalLocationLat,
      locationLng: finalLocationLng,
      locationType: locationType || null,
      facebookUrl: facebookUrl || '',
      instagramUrl: instagramUrl || '',
      websiteUrl: websiteUrl || '',
      spotifyUrl: body.spotifyUrl || '',
      bio: bio || '',
      profileImageUrl: finalProfileImageUrl,
      isVerified: false,
      claimedByUserId: null,  // Available for claiming
      socialMediaUrls: [],
      followerCount: 0,
      genres: genreResult.valid,  // Normalised by genre validation above

      // Backstage-compatible fields
      owner_user_id: null,  // Community-created = no owner
      artist_type: artistType || artist_type || 'band',
      actType: actType || null,
      acoustic: acoustic || false,
      displayColour: randomColor(),
      member_count: 0,
      allowedEventTypes: ['public_gig'],

      // Data quality tracking
      source: body.source || 'frontstage',  // frontstage = public, mcp_ai_import = AI-created
      ai_created: body.ai_created || false,
      needs_review: true,    // Requires admin review before considered clean

      // External IDs for cross-referencing (MCP imports)
      external_ids: externalIds || [],

      // Name variants for known billing variations (Fix #3a)
      name_variants: nameVariants || [],

      // Fix #7: Record if name passed via verified-source-name exception (§2A.5)
      // Allows reviewers to see why a listing-copy-looking name was accepted
      ...(dataQualityCheck.verifiedSourceName ? {
        verifiedSourceName: true,
        verifiedSourceUrl: dataQualityCheck.verifiedSourceUrl
      } : {}),

      createdAt: now,
      updated_at: now
    };

    // HARD GATE (2026-07-27): artist UID = normalise(name) + region bucket.
    // Even when a caller's "this is a new artist" logic is wrong, the
    // sentinel transaction bounces the write.
    const { keys: uniqueKeys, resolvable } = buildArtistUniqueKeys(name, location, facebookUrl, nameVariants);

    if (!resolvable && gateMode() === 'enforce') {
      // A location that can't be bucketed can't participate in identity —
      // creating would make an unmatchable record (the 331-blank-location
      // problem). Route to review instead of creating.
      return {
        statusCode: 422,
        headers: getCommunityHeaders(),
        body: JSON.stringify({
          error: `Location "${location}" cannot be resolved to a region. Artist identity requires a resolvable performing location — supply a town/county (e.g. "Stoke-on-Trent"), not "${location}".`,
          code: 'LOCATION_UNRESOLVABLE',
          action: 'review'
        })
      };
    }
    if (!resolvable) {
      console.warn(`UNIQUE-GATE: artist "${name}" location "${location}" unresolvable — creating UNGATED (log mode)`);
    }

    const gateResult = await gatedPut(dynamodb, {
      tableName: 'bndy-artists',
      item: newArtist,
      keys: uniqueKeys,
      entityType: 'artist',
      source: newArtist.source
    });

    if (!gateResult.written) {
      const existingId = gateResult.existing && gateResult.existing.refId;
      console.log(`[Artists] Gate bounced community create of "${name}" — duplicate of ${existingId}`);
      return {
        statusCode: 409,
        headers: getCommunityHeaders(),
        body: JSON.stringify({
          ...duplicateResponseBody('artist', gateResult.existing),
          message: `An artist with this name already exists in this region (or shares this Facebook page). Use the existing record.`,
          existingArtistId: existingId
        })
      };
    }

    console.log(` Community artist created: ${artistId} (${name}) with ${locationType || 'unknown'} location [gate: ${gateResult.gate}]`);

    return {
      statusCode: 201,
      headers: getCommunityHeaders(),
      body: JSON.stringify({
        message: 'Artist created successfully',
        artist: {
          id: artistId,
          name: newArtist.name,
          location: newArtist.location,
          locationLat: newArtist.locationLat,
          locationLng: newArtist.locationLng,
          locationType: newArtist.locationType,
          externalIds: newArtist.external_ids,
          nameVariants: newArtist.name_variants
        }
      })
    };
  } catch (error) {
    console.error(' Community artist creation failed:', error);
    return {
      statusCode: 500,
      headers: getCommunityHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

// ============================================================================
// FIND-OR-CREATE ARTIST (Public, No Auth) - server-side artist resolution
// ADR-014 gate: normalise before scoring; require a shared significant token (no
// "Adam Forman" -> "Adam Morgan" false positives); region is a SIGNAL not a filter;
// 60-90% -> review; genuine no-hit -> create (needs_review:true). One place for
// artist dedup, shared by source-runner + MCP + the planned form.
// ============================================================================

// Leading articles to strip for matching (common in band names)
const LEADING_ARTICLES = ['the ', 'a ', 'an '];
// Trailing suffixes to strip (act type descriptors, not part of core identity)
// ADR-023: Order by length DESC - check compound suffixes before simple ones
// e.g., "acoustic duo" must match before "duo" alone
const TRAILING_SUFFIXES = [
  ' acoustic duo',   // Most specific compound suffixes first
  ' acoustic trio',
  ' acoustic band',
  ' acoustic show',
  ' party band',
  ' rock band',
  ' cover band',
  ' band',           // Simple suffixes after compounds
  ' duo',
  ' trio',
  ' live',
  ' acoustic',
  ' show',
  ' experience',
  ' collective',
  ' solo',
];

// Strip leading article from name (returns name without article, or original if no match)
function stripLeadingArticle(name) {
  const lower = (name || '').toLowerCase().trim();
  for (const article of LEADING_ARTICLES) {
    if (lower.startsWith(article)) {
      return name.trim().substring(article.length);
    }
  }
  return name;
}

// Strip trailing suffix from name
function stripTrailingSuffix(name) {
  const lower = (name || '').toLowerCase();
  for (const suffix of TRAILING_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return name.slice(0, -suffix.length).trim();
    }
  }
  return name;
}

/**
 * Extract the act qualifier from a billing string (ADR-023).
 * Returns { core, act } where:
 * - core is the artist name with act qualifier stripped
 * - act is the qualifier (e.g., "Acoustic Duo", "Band") or null if none
 *
 * Example: "The Vanz Acoustic Duo" → { core: "The Vanz", act: "Acoustic Duo" }
 */
function extractActQualifier(name) {
  const trimmed = (name || '').trim();
  const lower = trimmed.toLowerCase();

  for (const suffix of TRAILING_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      return {
        core: trimmed.slice(0, -suffix.length).trim(),
        act: trimmed.slice(-suffix.length + 1).trim() // +1 to skip leading space
      };
    }
  }
  return { core: trimmed, act: null };
}

// Slug-strength normalisation (ADR-013): strip articles/suffixes/apostrophes/punctuation/spacing/case.
// "The Magnetic Jellyfish" → "magneticjellyfish" (same as "Magnetic Jellyfish")
// "Circa 81 Band" → "circa81" (same as "Circa81")
function artistSlugNormalise(raw) {
  let name = (raw || '').toLowerCase();
  // Strip leading article
  for (const article of LEADING_ARTICLES) {
    if (name.startsWith(article)) {
      name = name.substring(article.length);
      break;
    }
  }
  // Strip trailing suffix
  for (const suffix of TRAILING_SUFFIXES) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }
  // Remove apostrophes and non-alphanumeric
  return name
    .replace(/[''‚‛'`]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

// Significant tokens: alphanumeric words of length >= 4 (ignore short/common words).
function significantTokens(raw) {
  return (raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4);
}

// Levenshtein similarity percentage between two strings.
function similarityPct(a, b) {
  if (!a.length && !b.length) return 100;
  if (!a.length || !b.length) return 0;
  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return ((maxLen - dist) / maxLen) * 100;
}

// =============================================================================
// BATCH 3: Footprint scoring infrastructure (ADR-021 rev.3)
// =============================================================================

/**
 * Get an artist's gig-geography footprint.
 * Returns a map of regions → weight (based on event count/recency).
 *
 * Per ADR-021 spec: "put it behind a getArtistFootprint(artistId) interface
 * so the source swaps to the knowledge layer later without touching the resolver"
 *
 * @param {string} artistId - The artist ID to get footprint for
 * @param {Map<string, string>} [venueRegionCache] - Optional cache for venue→region lookups (N+1 fix)
 * @returns {Promise<{regions: Map<string, number>, totalEvents: number}>}
 */
async function getArtistFootprint(artistId, venueRegionCache) {
  const footprint = { regions: new Map(), totalEvents: 0 };
  // Use provided cache or create local one (cache is request-scoped, not cross-request)
  const cache = venueRegionCache || new Map();

  try {
    // Query events by artistId (limit to last 50 for efficiency)
    const eventsResult = await dynamodb.query({
      TableName: 'bndy-events',
      IndexName: 'artistId-index',
      KeyConditionExpression: 'artistId = :artistId',
      ExpressionAttributeValues: { ':artistId': artistId },
      ProjectionExpression: 'id, venueId, #date',
      ExpressionAttributeNames: { '#date': 'date' },
      Limit: 50,
      ScanIndexForward: false // Most recent first
    }).promise();

    const events = eventsResult.Items || [];
    footprint.totalEvents = events.length;

    if (events.length === 0) {
      return footprint;
    }

    // Get unique venueIds
    const venueIds = [...new Set(events.map(e => e.venueId).filter(Boolean))];

    // Fetch venues for regions (with cache to avoid N+1 across candidates)
    for (const venueId of venueIds) {
      let region = cache.get(venueId);

      if (!region) {
        try {
          const venueResult = await dynamodb.get({
            TableName: 'bndy-venues',
            Key: { id: venueId },
            ProjectionExpression: 'id, city, #region',
            ExpressionAttributeNames: { '#region': 'region' }
          }).promise();

          if (venueResult.Item) {
            region = venueResult.Item.region || venueResult.Item.city || 'unknown';
            cache.set(venueId, region);
          }
        } catch (err) {
          console.warn(`[footprint] Failed to fetch venue ${venueId}:`, err.message);
        }
      }

      if (region) {
        const currentWeight = footprint.regions.get(region) || 0;
        // Count events at this venue's region
        const eventsAtVenue = events.filter(e => e.venueId === venueId).length;
        footprint.regions.set(region, currentWeight + eventsAtVenue);
      }
    }
  } catch (err) {
    console.warn(`[footprint] Failed to query events for artist ${artistId}:`, err.message);
  }

  return footprint;
}

/**
 * Score how well a venue region matches an artist's footprint.
 * Returns 0-100 score.
 *
 * Per ADR-021: "Score the listing's venueRegion by containment/proximity to that set:
 * same locality ≈ 1.0; same county/metro ≈ 0.7; adjacent region ≈ 0.4; far ≈ 0.0"
 *
 * @param {string} venueRegion - The listing's venue region
 * @param {{regions: Map<string, number>, totalEvents: number}} footprint - Artist footprint
 * @returns {number} Score 0-100
 */
function scoreFootprintMatch(venueRegion, footprint) {
  if (!venueRegion || footprint.totalEvents === 0) {
    return 0; // No footprint → score 0 (cannot win on footprint, which is correct)
  }

  const normalised = venueRegion.toLowerCase().trim();

  // Check for exact region match
  for (const [region, weight] of footprint.regions) {
    if (region.toLowerCase() === normalised) {
      // Same region = high score (proportional to how dominant this region is)
      const dominance = weight / footprint.totalEvents;
      return Math.round(100 * dominance); // 100 if all events in this region
    }
  }

  // Check for partial/adjacent region match
  // Simple heuristic: if the region name contains or is contained by a footprint region
  for (const [region] of footprint.regions) {
    const regionLower = region.toLowerCase();
    if (regionLower.includes(normalised) || normalised.includes(regionLower)) {
      return 70; // Adjacent/overlapping region
    }
  }

  // TODO: Add proper geo-proximity scoring (distance between regions)
  // For now, any footprint with no match scores 0
  return 0;
}

/**
 * Calculate composite score for an artist candidate.
 * Weighted per ADR-021 spec:
 * - Footprint: 45%
 * - Social: 25% (when present)
 * - Locality: 15%
 * - Co-acts: 10% (not implemented yet)
 * - Genre: 5% (not implemented yet)
 *
 * Note: Name similarity is NOT a scored signal - only for candidate fetch.
 */
function calculateCompositeScore(candidate, venueRegion, footprint) {
  // Target weights per ADR-021 spec (when all signals are implemented):
  // - Footprint: 45%, Social: 25%, Locality: 15%, Co-acts: 10%, Genre: 5%
  //
  // Currently implemented: footprint + locality = 60%
  // To make scoring meaningful now, scale up to 100% proportionally.
  // This maintains relative weights (footprint:locality = 3:1) while filling the gap.
  //
  // Scale factor = 100 / (45 + 15) = 1.667
  // Effective weights: footprint = 75%, locality = 25%

  const SCALE_FACTOR = 100 / (45 + 15); // = 1.667
  const weights = {
    footprint: 0.45 * SCALE_FACTOR, // ~0.75
    locality: 0.15 * SCALE_FACTOR,  // ~0.25
  };

  let score = 0;

  // Footprint score (scaled to ~75%)
  const footprintScore = scoreFootprintMatch(venueRegion, footprint);
  score += footprintScore * weights.footprint;

  // Locality score (scaled to ~25%) - candidate's stored location vs venue region
  if (candidate.location && venueRegion) {
    const locLower = candidate.location.toLowerCase();
    const venueLower = venueRegion.toLowerCase();
    if (locLower.includes(venueLower) || venueLower.includes(locLower)) {
      score += 100 * weights.locality;
    }
  }

  // TODO: When social/co-acts/genre are implemented, remove SCALE_FACTOR
  // and use the original ADR-021 weights.

  return Math.round(score);
}

// Scoring thresholds
// Note: With only footprint (75%) + locality (25%) implemented, a perfect footprint
// match gives 75 points. Thresholds are calibrated to this partial implementation.
// When social/co-acts/genre are added, recalibrate to ADR-021 spec (90/70).
const SCORE_THRESHOLD_HIGH = 75; // ≥75 = MATCH (perfect footprint match)
const SCORE_THRESHOLD_LOW = 50;  // 50-75 = REVIEW
const MARGIN_THRESHOLD = 10;     // If #2 within 10pts of #1 → REVIEW

async function handleFindOrCreateArtist(event) {
  console.log(' Artists Lambda: find-or-create artist');
  const body = JSON.parse(event.body || '{}');
  // canCreate defaults true (Cowork path); runner passes false
  // venueRegion is the listing's venue region for footprint scoring (Batch 3)
  // verifiedSourceName: §2A.5 exception for acts whose FB page name IS the billing (Fix #7)
  // resolveTo: when action:review was returned, caller can pick a candidate id
  // confirmNew: when action:review was returned, caller confirms this is genuinely new
  // dryRun: B3 - return full verdict (matched/review/clear + candidates with location), ZERO writes
  const { name, canCreate = true, venueRegion, verifiedSourceName, resolveTo, confirmNew, dryRun } = body;

  // RESOLUTION HANDLING (Blocker #1 fix): resolveTo + confirmNew params
  // When action:review was previously returned, caller can resolve via these params
  if (resolveTo && confirmNew) {
    return {
      statusCode: 400,
      headers: getCommunityHeaders(),
      body: JSON.stringify({
        error: 'Cannot provide both resolveTo and confirmNew - pick one resolution method'
      })
    };
  }

  // resolveTo: Link to existing artist (manual resolution from review candidates)
  if (resolveTo) {
    try {
      const resolved = await dynamodb.get({
        TableName: 'bndy-artists',
        Key: { id: resolveTo }
      }).promise();

      if (!resolved.Item) {
        return {
          statusCode: 400,
          headers: getCommunityHeaders(),
          body: JSON.stringify({
            error: `resolveTo artist not found: ${resolveTo}. Use a valid candidate id from the review response.`
          })
        };
      }

      console.log(`[find-or-create artist] MANUAL_RESOLUTION: "${name}" -> "${resolved.Item.name}" (${resolveTo})`);
      return {
        statusCode: 200,
        headers: getCommunityHeaders(),
        body: JSON.stringify({
          action: 'matched',
          artist: { id: resolved.Item.id, name: resolved.Item.name, location: resolved.Item.location || '' },
          confidence: 1,
          matchedBy: 'manual_resolution'
        })
      };
    } catch (err) {
      console.error('[find-or-create artist] resolveTo lookup failed:', err.message);
      return {
        statusCode: 500,
        headers: getCommunityHeaders(),
        body: JSON.stringify({ error: 'Failed to resolve artist: ' + err.message })
      };
    }
  }

  if (!name || name.trim().length === 0) {
    return {
      statusCode: 400,
      headers: getCommunityHeaders(),
      body: JSON.stringify({ error: 'Artist name is required' })
    };
  }

  // Data quality validation (2026-07-27 audit follow-up)
  // Fix #7 (2026-07-30): Pass verifiedSourceName + facebookUrl for §2A.5 exception
  // ADDENDUM H FIX (2026-08-07): Return 422 with DATA_QUALITY code so dryRun pre-check
  // surfaces validation errors BEFORE publish. Without this, dryRun returned "clear"
  // but actual create failed with 422, stranding the wizard.
  const validation = validateArtistData({ name }, {
    verifiedSourceName: verifiedSourceName === true,
    facebookUrl: body.facebookUrl || ''
  });
  if (!validation.valid) {
    console.log(`DATA_QUALITY_REJECT: Artist creation blocked - ${validation.errors.join('; ')}`);
    return {
      statusCode: 422,
      headers: getCommunityHeaders(),
      body: JSON.stringify({
        error: 'Artist name failed data-quality validation',
        code: 'DATA_QUALITY',
        errors: validation.errors
      })
    };
  }

  // ADDENDUM H FIX (2026-08-07): Location resolution validation for confirmNew path.
  // Validate location upfront so dryRun surfaces the error instead of returning "clear"
  // only to have the actual create fail with 422.
  const location = body.location;
  if (confirmNew === true) {
    const { resolvable } = buildArtistUniqueKeys(name, location || '', '', []);
    if (!resolvable && gateMode() === 'enforce') {
      console.log(`LOCATION_UNRESOLVABLE: "${name}" location "${location}" cannot be bucketed (confirmNew path)`);
      return {
        statusCode: 422,
        headers: getCommunityHeaders(),
        body: JSON.stringify({
          error: `Location "${location || ''}" cannot be resolved to a region. Artist identity requires a resolvable performing location — supply a town/county (e.g. "Stoke-on-Trent").`,
          code: 'LOCATION_UNRESOLVABLE',
          action: 'review'
        })
      };
    }
  }

  // confirmNew: Bypass all matching and create directly (manual resolution after review)
  // Caller has seen the candidates and confirms this is genuinely a new, distinct artist
  if (confirmNew === true) {
    // B3: dryRun mode - return verdict without creating
    if (dryRun) {
      console.log(`[find-or-create artist] DRY_RUN CONFIRM_NEW: "${name}" - would create (zero writes)`);
      return {
        statusCode: 200,
        headers: getCommunityHeaders(),
        body: JSON.stringify({
          action: 'clear',
          reason: 'dryRun: confirmNew accepted, would create new artist',
          candidates: []
        })
      };
    }
    console.log(`[find-or-create artist] CONFIRM_NEW: "${name}" - bypassing matching per caller confirmation`);
    const created = await handleCreateCommunityArtist(event);
    try {
      const parsed = JSON.parse(created.body);
      return {
        statusCode: created.statusCode,
        headers: getCommunityHeaders(),
        body: JSON.stringify({ action: created.statusCode === 201 ? 'created' : 'create_failed', ...parsed })
      };
    } catch (e) {
      return created;
    }
  }

  // GATE FIX 2026-07-28 (verification finding c): FB-FIRST MATCH.
  // Exact facebook_key match = same artist regardless of name spelling
  // (runbook §1A.2 Step 0 — the strongest identity signal). O(1) via the
  // sentinel table, which covers every artist with an FB URL post-backfill.
  const inputFbUrl = body.facebookUrl || '';
  const inputFbKey = facebookKey(inputFbUrl);
  if (inputFbKey) {
    try {
      const fbSentinel = await dynamodb.get({
        TableName: process.env.UNIQUE_KEYS_TABLE || 'bndy-unique-keys',
        Key: { key: `artist#fb#${inputFbKey}` }
      }).promise();
      if (fbSentinel.Item && fbSentinel.Item.refId) {
        const fbMatch = await dynamodb.get({ TableName: 'bndy-artists', Key: { id: fbSentinel.Item.refId } }).promise();
        if (fbMatch.Item) {
          console.log(`[find-or-create artist] FB-FIRST MATCH: "${name}" → ${fbMatch.Item.id} (${fbMatch.Item.name}) via facebook key`);
          return {
            statusCode: 200,
            headers: getCommunityHeaders(),
            body: JSON.stringify({
              action: 'matched',
              artist: { id: fbMatch.Item.id, name: fbMatch.Item.name, location: fbMatch.Item.location },
              confidence: 1,
              matchedBy: 'facebook'
            })
          };
        }
      }
    } catch (fbErr) {
      console.warn(`[find-or-create artist] FB-first lookup failed (non-fatal): ${fbErr.code || fbErr.message}`);
    }
  }

  // ADR-023: Extract act qualifier if present (e.g., "The Vanz Acoustic Duo" → act: "Acoustic Duo")
  // The act is NOT part of artist identity - resolve the core, return act separately
  const { core: artistCore, act: extractedAct } = extractActQualifier(name);

  const querySlug = artistSlugNormalise(name);
  const queryTokens = significantTokens(name);

  // Compute prefixes to search: original + article-stripped + suffix-stripped (bare core)
  // "The Magnetic Jellyfish" → search "th" AND "ma"
  // "8Ts Band" → search "8t" (finds "8Ts")
  // "The Vanz Duo" → search "th" AND "va" (finds "The Vanz" or "Vanz")
  const prefixes = new Set();
  const originalPrefix = name.toLowerCase().trim().substring(0, 2);
  prefixes.add(originalPrefix);

  // Article-stripped: "The X" → search "x" prefix too
  const strippedArticle = stripLeadingArticle(name);
  if (strippedArticle !== name && strippedArticle.length >= 2) {
    prefixes.add(strippedArticle.toLowerCase().substring(0, 2));
  }

  // Bare-core (suffix-stripped): "X Band" → search core "X" prefix too
  // Per ADR-021 spec: strip Band/Duo/Trio/Acoustic/Live/Music and search the core
  const bareCore = stripTrailingSuffix(name);
  if (bareCore !== name && bareCore.length >= 2) {
    prefixes.add(bareCore.toLowerCase().substring(0, 2));
  }

  // Combined: article + suffix stripped ("The X Band" → "X")
  const bareCoreOfStripped = stripTrailingSuffix(strippedArticle);
  if (bareCoreOfStripped !== strippedArticle && bareCoreOfStripped.length >= 2) {
    prefixes.add(bareCoreOfStripped.toLowerCase().substring(0, 2));
  }

  // Fetch candidates from all prefix partitions, then score with slug-strength
  // normalisation (catches "Circa81" == "Circa 81" AND "The X" == "X").
  // NOTE: caps at 500 per prefix; a dedicated slug GSI is the long-term fix for very
  // high-cardinality prefixes (e.g. "th"). Misses fall through to create + needs_review.
  let candidates = [];
  const seenIds = new Set();

  for (const prefix of prefixes) {
    try {
      const res = await dynamodb.query({
        TableName: 'bndy-artists',
        IndexName: 'name-search-index',
        KeyConditionExpression: 'name_prefix = :prefix',
        ExpressionAttributeValues: { ':prefix': prefix },
        ProjectionExpression: 'id, #name, bio, #location, name_variants',
        ExpressionAttributeNames: { '#name': 'name', '#location': 'location' },
        Limit: 500
      }).promise();

      // Deduplicate by ID (in case same artist appears in multiple prefixes)
      for (const item of (res.Items || [])) {
        if (!seenIds.has(item.id)) {
          seenIds.add(item.id);
          candidates.push(item);
        }
      }
    } catch (err) {
      console.error(`[find-or-create artist] candidate query failed for prefix "${prefix}":`, err.message);
    }
  }

  console.log(`[find-or-create artist] Searched ${prefixes.size} prefix(es): ${[...prefixes].join(', ')} -> ${candidates.length} candidates`);

  // Fix #3b: Name variant check BEFORE similarity scoring (2026-07-29)
  // If incoming name matches any candidate's nameVariants, return matched immediately
  const incomingNameKey = normaliseKey(name);
  for (const candidate of candidates) {
    const variants = candidate.name_variants || [];
    for (const variant of variants) {
      if (normaliseKey(variant) === incomingNameKey) {
        console.log(`[find-or-create artist] NAME_VARIANT MATCH: "${name}" → ${candidate.id} (${candidate.name}) via variant "${variant}"`);
        return {
          statusCode: 200,
          headers: getCommunityHeaders(),
          body: JSON.stringify({
            action: 'matched',
            artist: { id: candidate.id, name: candidate.name, location: candidate.location },
            confidence: 1,
            matchedBy: 'name_variant',
            variant: variant
          })
        };
      }
    }
  }

  // Phase 1: Score candidates by name similarity (for candidate filtering)
  // Fix #3c: Include region bucketing for mid-band safety net
  const incomingRegion = regionBucket(body.location || venueRegion || '');

  const simScored = candidates
    .map(a => {
      const slug = artistSlugNormalise(a.name);
      const slugEqual = slug === querySlug && querySlug.length > 0;
      const sim = slugEqual ? 100 : similarityPct(slug, querySlug);
      const aTokens = significantTokens(a.name);
      const sharedToken = queryTokens.some(t => aTokens.includes(t));
      const candidateRegion = regionBucket(a.location || '');
      const sameRegion = incomingRegion !== 'unknown' && candidateRegion !== 'unknown' && incomingRegion === candidateRegion;
      return { id: a.id, name: a.name, location: a.location || '', sim, sharedToken, slugEqual, region: candidateRegion, sameRegion };
    })
    .filter(s => s.sim >= 60 || s.slugEqual) // Only consider plausible candidates
    .sort((x, y) => y.sim - x.sim)
    .slice(0, 10); // Limit to top 10 for footprint queries

  // Phase 2: If venueRegion provided, use footprint scoring to break ties (ADR-021 Batch 3)
  let scored = simScored;
  let usedFootprintScoring = false;

  if (venueRegion && simScored.length > 1) {
    console.log(`[find-or-create artist] Using footprint scoring with venueRegion="${venueRegion}"`);
    usedFootprintScoring = true;

    // Shared venue→region cache across candidates (N+1 fix: same venue across artists is only fetched once)
    const venueRegionCache = new Map();

    // Fetch footprints for top candidates
    const scoredWithFootprint = [];
    for (const candidate of simScored) {
      const footprint = await getArtistFootprint(candidate.id, venueRegionCache);
      const compositeScore = calculateCompositeScore(candidate, venueRegion, footprint);

      scoredWithFootprint.push({
        ...candidate,
        footprintScore: compositeScore,
        footprintRegions: footprint.totalEvents > 0
          ? [...footprint.regions.entries()].map(([r, w]) => `${r}(${w})`)
          : [],
        totalEvents: footprint.totalEvents
      });
    }

    // Re-sort by composite score (footprint-weighted)
    scored = scoredWithFootprint.sort((x, y) => y.footprintScore - x.footprintScore);

    // Margin guard (ADR-021): if #2 within 10pts of #1 → REVIEW (ambiguous collision)
    if (scored.length >= 2) {
      const margin = scored[0].footprintScore - scored[1].footprintScore;
      if (margin < MARGIN_THRESHOLD) {
        console.log(`[find-or-create artist] REVIEW "${name}" - margin guard triggered (${margin}pt margin)`);
        return {
          statusCode: 200,
          headers: getCommunityHeaders(),
          body: JSON.stringify({
            action: 'review',
            reason: `Near-tie margin guard: top 2 candidates within ${MARGIN_THRESHOLD}pt (margin=${margin})`,
            candidates: scored.slice(0, 5).map(s => ({
              id: s.id, name: s.name, location: s.location,
              confidence: Math.round(s.footprintScore) / 100,
              footprintScore: s.footprintScore,
              footprintRegions: s.footprintRegions,
              totalEvents: s.totalEvents
            }))
          })
        };
      }
    }
  }

  const best = scored[0];

  // Decision: Confident match using similarity OR footprint score
  // - With venueRegion (footprint scoring): composite score >= threshold (already past margin guard)
  // - Without venueRegion: identical slug, OR >=90% similarity AND shared token
  // KEY: When footprint scoring is used, it SUPERSEDES the slugEqual fast-path.
  // This ensures same-name bands in different regions don't auto-merge.
  let isConfidentMatch = false;
  let matchMethod = '';
  let matchScore = 0;

  if (usedFootprintScoring && best) {
    // Footprint scoring supersedes name-based matching
    // Use footprint score threshold, not slugEqual
    if (best.footprintScore >= SCORE_THRESHOLD_HIGH) {
      isConfidentMatch = true;
      matchMethod = 'footprint';
      matchScore = best.footprintScore;
    }
    // If footprint score is below threshold, fall through to review/no-match
  } else if (best) {
    // No footprint scoring - use name-based matching
    // ADR-021 fallback: Apply margin guard even without venueRegion to prevent
    // arbitrary matches on same-name collisions (e.g., 3× "Ant Hill Mob").
    // If multiple candidates have high similarity, REVIEW instead of arbitrary match.
    if (scored.length >= 2 && best.sim >= 60) {
      const simMargin = best.sim - scored[1].sim;
      if (simMargin < MARGIN_THRESHOLD) {
        // Near-tie on similarity alone - this is likely a same-name collision
        // Route to REVIEW rather than picking arbitrarily
        console.log(`[find-or-create artist] REVIEW "${name}" - similarity margin guard (no venueRegion, ${simMargin}pt margin)`);
        return {
          statusCode: 200,
          headers: getCommunityHeaders(),
          body: JSON.stringify({
            action: 'review',
            reason: `Same-name collision detected: top ${scored.length >= 2 ? 2 : 1} candidates within ${MARGIN_THRESHOLD}pt (margin=${simMargin}). Provide venueRegion for footprint disambiguation.`,
            candidates: scored.slice(0, 5).map(s => ({
              id: s.id, name: s.name, location: s.location,
              confidence: Math.round(s.sim) / 100,
              sharedToken: s.sharedToken
            }))
          })
        };
      }
    }

    // Clear winner (sufficient margin over #2) - safe to match
    if (best.slugEqual) {
      isConfidentMatch = true;
      matchMethod = 'normalised_name';
      matchScore = best.sim;
    } else if (best.sim >= 90 && best.sharedToken) {
      isConfidentMatch = true;
      matchMethod = 'fuzzy_token';
      matchScore = best.sim;
    }
  }

  if (isConfidentMatch) {
    console.log(`[find-or-create artist] MATCH "${name}" -> "${best.name}" (${matchScore.toFixed(0)}% via ${matchMethod})${extractedAct ? ` + act "${extractedAct}"` : ''}`);
    return {
      statusCode: 200,
      headers: getCommunityHeaders(),
      body: JSON.stringify({
        action: 'matched',
        artist: { id: best.id, name: best.name, location: best.location },
        confidence: Math.round(matchScore) / 100,
        matchedBy: matchMethod,
        // ADR-023: If billing string had an act qualifier, return it separately
        // e.g., "The Vanz Acoustic Duo" → artist: "The Vanz", act: "Acoustic Duo"
        ...(extractedAct ? { act: extractedAct } : {}),
        ...(usedFootprintScoring ? { footprintScore: best.footprintScore, footprintRegions: best.footprintRegions } : {})
      })
    };
  }

  // Ambiguous middle: candidates exist but no clear winner
  // - Without venueRegion: >=60% similarity
  // - With venueRegion: footprint score 70-90 (SCORE_THRESHOLD_LOW to HIGH)
  // Fix #3c: Mid-band safety net (60-89% + sharedToken + same region → review)
  const plausible = usedFootprintScoring
    ? scored.filter(s => s.footprintScore >= SCORE_THRESHOLD_LOW).slice(0, 5)
    : scored.filter(s => {
        // 60-89% band: require sharedToken AND same region (Fix #3c safety net)
        if (s.sim >= 60 && s.sim < 90) {
          return s.sharedToken && s.sameRegion;
        }
        // >=90%: should have matched above, but include if present
        return s.sim >= 90;
      }).slice(0, 5);

  if (plausible.length > 0) {
    const topScore = usedFootprintScoring ? plausible[0].footprintScore : plausible[0].sim;
    console.log(`[find-or-create artist] REVIEW "${name}" (${plausible.length} candidate(s), top ${topScore.toFixed(0)}%)`);
    return {
      statusCode: 200,
      headers: getCommunityHeaders(),
      body: JSON.stringify({
        action: 'review',
        reason: 'Ambiguous artist match - needs human review (ADR-014/ADR-021)',
        candidates: plausible.map(s => ({
          id: s.id, name: s.name, location: s.location,
          confidence: Math.round(usedFootprintScoring ? s.footprintScore : s.sim) / 100,
          sharedToken: s.sharedToken,
          ...(usedFootprintScoring ? { footprintScore: s.footprintScore, footprintRegions: s.footprintRegions } : {})
        }))
      })
    };
  }

  // Genuine no-hit: create OR review based on canCreate flag.
  // Per ADR-021 spec: runner passes canCreate:false → review (never auto-create).
  // Cowork/MCP keeps canCreate:true (default) until cutover.
  if (!canCreate) {
    console.log(`[find-or-create artist] REVIEW "${name}" (likely-new, canCreate=false)`);
    return {
      statusCode: 200,
      headers: getCommunityHeaders(),
      body: JSON.stringify({
        action: 'review',
        reason: 'likely-new',
        queryName: name,
        candidates: [] // No plausible candidates
      })
    };
  }

  // GATE FIX 2026-07-28 (verification finding d): CONTAINMENT CHECK.
  // Billing-string class ("Not Guilty - 5pc..." vs "Not Guilty", "Cyril Blake
  // 60s & 70s Band" vs "Cyril Blake"): if the incoming normalised key starts
  // with an existing candidate's key (or vice versa, ≥6 chars) in the SAME
  // region, this is almost certainly the same act under listing copy →
  // review, never create. Runs over ALL fetched candidates (not just
  // similarity-filtered ones — containment pairs often score low on
  // Levenshtein).
  {
    const incomingKey = normaliseKey(name);
    const incomingRegion = regionBucket(body.location || venueRegion || '');
    const containment = [];
    if (incomingKey.length >= 6) {
      for (const c of candidates) {
        const cKey = normaliseKey(c.name);
        if (cKey.length >= 6 && cKey !== incomingKey
            && (incomingKey.startsWith(cKey) || cKey.startsWith(incomingKey))) {
          const cRegion = regionBucket(c.location || '');
          if (incomingRegion === 'unknown' || cRegion === 'unknown' || incomingRegion === cRegion) {
            containment.push({ id: c.id, name: c.name, location: c.location || '', reason: 'name-containment' });
          }
        }
      }
    }
    if (containment.length > 0) {
      console.log(`[find-or-create artist] REVIEW "${name}" - containment match: ${containment.map(c => c.name).join(', ')}`);
      return {
        statusCode: 200,
        headers: getCommunityHeaders(),
        body: JSON.stringify({
          action: 'review',
          reason: 'name-containment: incoming name contains (or is contained by) an existing artist name in the same region — likely the same act with listing copy/description attached. Strip the description and reuse the existing id, or confirm genuinely distinct.',
          queryName: name,
          candidates: containment.slice(0, 5)
        })
      };
    }
  }

  // B3: dryRun mode - return verdict without creating
  if (dryRun) {
    // ADDENDUM H FIX: validate location BEFORE returning "clear" so wizard
    // surfaces the error at pre-check time, not at publish time.
    const { resolvable } = buildArtistUniqueKeys(name, body.location || '', '', []);
    if (!resolvable && gateMode() === 'enforce') {
      console.log(`LOCATION_UNRESOLVABLE: "${name}" location "${body.location}" cannot be bucketed (dryRun path)`);
      return {
        statusCode: 422,
        headers: getCommunityHeaders(),
        body: JSON.stringify({
          error: `Location "${body.location || ''}" cannot be resolved to a region. Artist identity requires a resolvable performing location — supply a town/county (e.g. "Stoke-on-Trent").`,
          code: 'LOCATION_UNRESOLVABLE',
          action: 'review'
        })
      };
    }
    console.log(`[find-or-create artist] DRY_RUN CREATE: "${name}" - would create (zero writes)`);
    return {
      statusCode: 200,
      headers: getCommunityHeaders(),
      body: JSON.stringify({
        action: 'clear',
        reason: 'dryRun: no match found, would create new artist',
        candidates: []
      })
    };
  }

  console.log(`[find-or-create artist] CREATE "${name}" (no plausible match, canCreate=true)`);
  const created = await handleCreateCommunityArtist(event);
  try {
    const parsed = JSON.parse(created.body);
    return {
      statusCode: created.statusCode,
      headers: getCommunityHeaders(),
      body: JSON.stringify({ action: created.statusCode === 201 ? 'created' : 'create_failed', ...parsed })
    };
  } catch (e) {
    return created;
  }
}

// ============================================================================
// ACTS CRUD HANDLERS - #60 Acts Model
// ============================================================================

/**
 * Generate a simple unique ID for acts
 */
function generateActId() {
  return 'act_' + crypto.randomBytes(8).toString('hex');
}

/**
 * Create a new act for an artist
 * POST /api/artists/:id/acts
 */
async function handleCreateAct(event) {
  const artistId = event.pathParameters.id;

  console.log(`[ACTS] Creating act for artist: ${artistId}`);

  // Require platform admin auth
  const authResult = await requirePlatformAdmin(event);
  if (authResult.error) {
    return {
      statusCode: authResult.statusCode || 401,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: authResult.error })
    };
  }

  // Parse and validate body
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  if (!body.name || !body.name.trim()) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Act name is required' })
    };
  }

  try {
    // Get current artist
    const artistResult = await dynamodb.get({
      TableName: 'bndy-artists',
      Key: { id: artistId }
    }).promise();

    if (!artistResult.Item) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Artist not found' })
      };
    }

    const currentActs = artistResult.Item.acts || [];

    // Create new act
    const newAct = {
      id: generateActId(),
      name: body.name.trim(),
      description: body.description?.trim() || null,
      isDefault: currentActs.length === 0 ? true : (body.isDefault || false)
    };

    // If this act is default, unset others
    const updatedActs = newAct.isDefault
      ? currentActs.map(a => ({ ...a, isDefault: false }))
      : currentActs;

    updatedActs.push(newAct);

    // Update artist
    const result = await dynamodb.update({
      TableName: 'bndy-artists',
      Key: { id: artistId },
      UpdateExpression: 'SET acts = :acts, updated_at = :updated_at',
      ExpressionAttributeValues: {
        ':acts': updatedActs,
        ':updated_at': new Date().toISOString()
      },
      ReturnValues: 'ALL_NEW'
    }).promise();

    console.log(`[ACTS] Created act "${newAct.name}" (${newAct.id}) for artist ${artistId}`);

    return {
      statusCode: 201,
      headers: getCorsHeaders(),
      body: JSON.stringify({ act: newAct, acts: result.Attributes.acts })
    };
  } catch (error) {
    console.error('[ACTS] Create act error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

/**
 * Update an existing act
 * PUT /api/artists/:id/acts/:actId
 */
async function handleUpdateAct(event) {
  const artistId = event.pathParameters.id;
  const actId = event.pathParameters.actId;

  console.log(`[ACTS] Updating act ${actId} for artist ${artistId}`);

  // Require platform admin auth
  const authResult = await requirePlatformAdmin(event);
  if (authResult.error) {
    return {
      statusCode: authResult.statusCode || 401,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: authResult.error })
    };
  }

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  try {
    // Get current artist
    const artistResult = await dynamodb.get({
      TableName: 'bndy-artists',
      Key: { id: artistId }
    }).promise();

    if (!artistResult.Item) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Artist not found' })
      };
    }

    const currentActs = artistResult.Item.acts || [];
    const actIndex = currentActs.findIndex(a => a.id === actId);

    if (actIndex === -1) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Act not found' })
      };
    }

    // Update act fields
    const updatedAct = {
      ...currentActs[actIndex],
      name: body.name?.trim() || currentActs[actIndex].name,
      description: body.description !== undefined ? (body.description?.trim() || null) : currentActs[actIndex].description
    };

    const updatedActs = [...currentActs];
    updatedActs[actIndex] = updatedAct;

    // Update artist
    const result = await dynamodb.update({
      TableName: 'bndy-artists',
      Key: { id: artistId },
      UpdateExpression: 'SET acts = :acts, updated_at = :updated_at',
      ExpressionAttributeValues: {
        ':acts': updatedActs,
        ':updated_at': new Date().toISOString()
      },
      ReturnValues: 'ALL_NEW'
    }).promise();

    console.log(`[ACTS] Updated act ${actId} for artist ${artistId}`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({ act: updatedAct, acts: result.Attributes.acts })
    };
  } catch (error) {
    console.error('[ACTS] Update act error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

/**
 * Delete an act
 * DELETE /api/artists/:id/acts/:actId
 * Blocked if any events reference this actId
 */
async function handleDeleteAct(event) {
  const artistId = event.pathParameters.id;
  const actId = event.pathParameters.actId;

  console.log(`[ACTS] Deleting act ${actId} for artist ${artistId}`);

  // Require platform admin auth
  const authResult = await requirePlatformAdmin(event);
  if (authResult.error) {
    return {
      statusCode: authResult.statusCode || 401,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: authResult.error })
    };
  }

  try {
    // Get current artist
    const artistResult = await dynamodb.get({
      TableName: 'bndy-artists',
      Key: { id: artistId }
    }).promise();

    if (!artistResult.Item) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Artist not found' })
      };
    }

    const currentActs = artistResult.Item.acts || [];
    const actIndex = currentActs.findIndex(a => a.id === actId);

    if (actIndex === -1) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Act not found' })
      };
    }

    // Check if any events reference this actId
    const eventsResult = await dynamodb.query({
      TableName: 'bndy-events',
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      FilterExpression: 'actId = :actId',
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':actId': actId
      },
      Limit: 1
    }).promise();

    if (eventsResult.Items && eventsResult.Items.length > 0) {
      return {
        statusCode: 409,
        headers: getCorsHeaders(),
        body: JSON.stringify({
          error: 'Cannot delete act: events reference this actId',
          eventCount: eventsResult.Count
        })
      };
    }

    // Remove act from array
    const updatedActs = currentActs.filter(a => a.id !== actId);

    // If we removed the default act, make the first remaining act default
    if (currentActs[actIndex].isDefault && updatedActs.length > 0) {
      updatedActs[0].isDefault = true;
    }

    // Update artist
    const result = await dynamodb.update({
      TableName: 'bndy-artists',
      Key: { id: artistId },
      UpdateExpression: 'SET acts = :acts, updated_at = :updated_at',
      ExpressionAttributeValues: {
        ':acts': updatedActs,
        ':updated_at': new Date().toISOString()
      },
      ReturnValues: 'ALL_NEW'
    }).promise();

    console.log(`[ACTS] Deleted act ${actId} for artist ${artistId}`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({ deleted: true, acts: result.Attributes.acts })
    };
  } catch (error) {
    console.error('[ACTS] Delete act error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

/**
 * Set an act as default
 * PUT /api/artists/:id/acts/:actId/default
 */
async function handleSetDefaultAct(event) {
  const artistId = event.pathParameters.id;
  // Extract actId from path - path looks like /api/artists/{id}/acts/{actId}/default
  const pathParts = (event.requestContext?.http?.path || event.path).split('/');
  const actIdIndex = pathParts.indexOf('acts') + 1;
  const actId = pathParts[actIdIndex];

  console.log(`[ACTS] Setting default act ${actId} for artist ${artistId}`);

  // Require platform admin auth
  const authResult = await requirePlatformAdmin(event);
  if (authResult.error) {
    return {
      statusCode: authResult.statusCode || 401,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: authResult.error })
    };
  }

  try {
    // Get current artist
    const artistResult = await dynamodb.get({
      TableName: 'bndy-artists',
      Key: { id: artistId }
    }).promise();

    if (!artistResult.Item) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Artist not found' })
      };
    }

    const currentActs = artistResult.Item.acts || [];
    const actIndex = currentActs.findIndex(a => a.id === actId);

    if (actIndex === -1) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Act not found' })
      };
    }

    // Update all acts - set the target as default, others as not default
    const updatedActs = currentActs.map(a => ({
      ...a,
      isDefault: a.id === actId
    }));

    // Update artist
    const result = await dynamodb.update({
      TableName: 'bndy-artists',
      Key: { id: artistId },
      UpdateExpression: 'SET acts = :acts, updated_at = :updated_at',
      ExpressionAttributeValues: {
        ':acts': updatedActs,
        ':updated_at': new Date().toISOString()
      },
      ReturnValues: 'ALL_NEW'
    }).promise();

    console.log(`[ACTS] Set act ${actId} as default for artist ${artistId}`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({ acts: result.Attributes.acts })
    };
  } catch (error) {
    console.error('[ACTS] Set default act error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

// ============================================================================
// MCP UPDATE ENDPOINT (Public, No Auth Required - AI-created artists only)
// ============================================================================

async function handleMCPUpdateArtist(event) {
  const artistId = event.pathParameters.id;
  const artistData = JSON.parse(event.body);

  console.log(`[MCP_UPDATE_ARTIST] Updating artist: ${artistId}`);

  try {
    // First, verify the artist exists and is AI-created
    const existingArtist = await dynamodb.get({
      TableName: 'bndy-artists',
      Key: { id: artistId }
    }).promise();

    if (!existingArtist.Item) {
      return {
        statusCode: 404,
        headers: getCommunityHeaders(),
        body: JSON.stringify({ error: 'Artist not found' })
      };
    }

    // Log update for audit trail (no source restrictions - MCP can enrich any artist)
    console.log(`[MCP_UPDATE_ARTIST] Updating artist: ${artistId} (source: ${existingArtist.Item.source || 'unknown'})`);

    const now = new Date().toISOString();

    // Build update expression dynamically
    const updateParts = ['updated_at = :updated_at'];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {
      ':updated_at': now
    };

    // Update only fields that are provided
    if (artistData.name !== undefined) {
      const searchFields = generateNameSearchFields(artistData.name);
      expressionAttributeNames['#name'] = 'name';
      updateParts.push('#name = :name', 'name_lower = :name_lower', 'name_prefix = :name_prefix');
      expressionAttributeValues[':name'] = artistData.name;
      expressionAttributeValues[':name_lower'] = searchFields.name_lower;
      expressionAttributeValues[':name_prefix'] = searchFields.name_prefix;
    }
    if (artistData.bio !== undefined) {
      updateParts.push('bio = :bio');
      expressionAttributeValues[':bio'] = artistData.bio || '';
    }
    if (artistData.location !== undefined) {
      expressionAttributeNames['#location'] = 'location';
      updateParts.push('#location = :location');
      expressionAttributeValues[':location'] = artistData.location || '';
    }
    if (artistData.locationType !== undefined) {
      updateParts.push('locationType = :locationType');
      expressionAttributeValues[':locationType'] = artistData.locationType;
    }
    if (artistData.locationLat !== undefined) {
      updateParts.push('locationLat = :locationLat');
      expressionAttributeValues[':locationLat'] = artistData.locationLat;
    }
    if (artistData.locationLng !== undefined) {
      updateParts.push('locationLng = :locationLng');
      expressionAttributeValues[':locationLng'] = artistData.locationLng;
    }
    if (artistData.genres !== undefined) {
      // Genre validation (2026-07-31): normalise and reject off-list values
      const { normaliseGenres, GENRES } = require('./lib/genres');
      const genreResult = normaliseGenres(artistData.genres);
      if (genreResult.invalid.length > 0) {
        return {
          statusCode: 400,
          headers: getMcpCorsHeaders(),
          body: JSON.stringify({
            error: 'Invalid genres',
            code: 'INVALID_GENRES',
            invalidGenres: genreResult.invalid,
            validGenres: GENRES
          })
        };
      }
      updateParts.push('genres = :genres');
      expressionAttributeValues[':genres'] = genreResult.valid;
    }
    if (artistData.artistType !== undefined) {
      updateParts.push('artist_type = :artist_type');
      expressionAttributeValues[':artist_type'] = artistData.artistType;
    }
    if (artistData.actType !== undefined) {
      updateParts.push('actType = :actType');
      expressionAttributeValues[':actType'] = artistData.actType || null;
    }
    if (artistData.acoustic !== undefined) {
      updateParts.push('acoustic = :acoustic');
      expressionAttributeValues[':acoustic'] = artistData.acoustic || false;
    }
    if (artistData.facebookUrl !== undefined) {
      updateParts.push('facebookUrl = :facebookUrl');
      expressionAttributeValues[':facebookUrl'] = artistData.facebookUrl || null;

      // Auto-fetch Facebook profile image if facebookUrl is being set and profileImageUrl is not explicitly provided
      // (Same behaviour as web/godmode handler - enrichment runs add facebookUrl, should also get the image)
      if (artistData.facebookUrl && artistData.profileImageUrl === undefined) {
        console.log('[MCP_UPDATE_ARTIST] Attempting to fetch Facebook profile image...');
        const fbImage = await fetchFacebookProfilePicture(artistData.facebookUrl);
        if (fbImage) {
          console.log('[MCP_UPDATE_ARTIST] Facebook image fetched successfully:', fbImage);
          updateParts.push('profileImageUrl = :profileImageUrl');
          expressionAttributeValues[':profileImageUrl'] = fbImage;
        }
      }
    }
    if (artistData.instagramUrl !== undefined) {
      updateParts.push('instagramUrl = :instagramUrl');
      expressionAttributeValues[':instagramUrl'] = artistData.instagramUrl || null;
    }
    if (artistData.websiteUrl !== undefined) {
      updateParts.push('websiteUrl = :websiteUrl');
      expressionAttributeValues[':websiteUrl'] = artistData.websiteUrl || null;
    }
    if (artistData.youtubeUrl !== undefined) {
      updateParts.push('youtubeUrl = :youtubeUrl');
      expressionAttributeValues[':youtubeUrl'] = artistData.youtubeUrl || null;
    }
    if (artistData.spotifyUrl !== undefined) {
      updateParts.push('spotifyUrl = :spotifyUrl');
      expressionAttributeValues[':spotifyUrl'] = artistData.spotifyUrl || null;
    }
    if (artistData.twitterUrl !== undefined) {
      updateParts.push('twitterUrl = :twitterUrl');
      expressionAttributeValues[':twitterUrl'] = artistData.twitterUrl || null;
    }
    if (artistData.profileImageUrl !== undefined) {
      updateParts.push('profileImageUrl = :profileImageUrl');
      expressionAttributeValues[':profileImageUrl'] = artistData.profileImageUrl || '';
    }
    if (artistData.externalIds !== undefined) {
      // MCP externalIds must also merge additively (Fix #2: 2026-07-29)
      const existingExternalIds = existingArtist.Item?.external_ids || [];
      const mergedExternalIds = mergeExternalIds(existingExternalIds, artistData.externalIds);

      updateParts.push('external_ids = :external_ids');
      expressionAttributeValues[':external_ids'] = mergedExternalIds;
    }
    if (artistData.nameVariants !== undefined) {
      // MCP nameVariants must also merge additively (Fix #3a: 2026-07-29)
      const existingNameVariants = existingArtist.Item?.name_variants || [];
      const mergedNameVariants = mergeNameVariants(existingNameVariants, artistData.nameVariants);

      updateParts.push('name_variants = :name_variants');
      expressionAttributeValues[':name_variants'] = mergedNameVariants;
    }

    // Enrichment fields (2026-08-11) - MCP agents populate these for human review
    if (artistData.enrichmentStatus !== undefined) {
      updateParts.push('enrichment_status = :enrichment_status');
      expressionAttributeValues[':enrichment_status'] = artistData.enrichmentStatus;
    }
    if (artistData.enrichmentData !== undefined) {
      updateParts.push('enrichment_data = :enrichment_data');
      expressionAttributeValues[':enrichment_data'] = artistData.enrichmentData;
    }
    if (artistData.enrichmentDate !== undefined) {
      updateParts.push('enrichment_date = :enrichment_date');
      expressionAttributeValues[':enrichment_date'] = artistData.enrichmentDate;
    }

    const params = {
      TableName: 'bndy-artists',
      Key: { id: artistId },
      UpdateExpression: `SET ${updateParts.join(', ')}`,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    };

    // Only add ExpressionAttributeNames if we have reserved word mappings
    if (Object.keys(expressionAttributeNames).length > 0) {
      params.ExpressionAttributeNames = expressionAttributeNames;
    }

    // GATE FIX 2026-07-28: MCP renames/relocations/variants must re-key sentinels
    // (existingArtist.Item was fetched above). Enforce-mode collision → 409,
    // update NOT performed.
    const mcpNeedsRekey = artistData.name !== undefined || artistData.location !== undefined ||
                          artistData.facebookUrl !== undefined || artistData.nameVariants !== undefined;
    if (mcpNeedsRekey) {
      const cur = existingArtist.Item;
      const effName = artistData.name !== undefined ? artistData.name : cur.name;
      const effLocation = artistData.location !== undefined ? artistData.location : cur.location;
      const effFb = artistData.facebookUrl !== undefined ? artistData.facebookUrl : cur.facebookUrl;
      // For nameVariants: old keys use existing variants, new keys use merged variants
      const curVariants = cur.name_variants || [];
      const effVariants = artistData.nameVariants !== undefined
        ? mergeNameVariants(curVariants, artistData.nameVariants)
        : curVariants;
      const rekey = await rekeyUniqueKeys(dynamodb, {
        oldKeys: buildArtistUniqueKeys(cur.name, cur.location, cur.facebookUrl, curVariants).keys,
        newKeys: buildArtistUniqueKeys(effName, effLocation, effFb, effVariants).keys,
        refId: artistId,
        entityType: 'artist',
        source: 'mcp-update'
      });
      if (rekey.changed && rekey.ok === false) {
        return {
          statusCode: 409,
          headers: getCommunityHeaders(),
          body: JSON.stringify({
            ...duplicateResponseBody('artist', rekey.existing),
            message: 'This rename/relocation/variant would make the artist a duplicate of an existing record. Merge instead (do not vary the name to get around this).'
          })
        };
      }
    }

    const result = await dynamodb.update(params).promise();

    console.log(`[MCP_UPDATE_ARTIST] Successfully updated artist: ${artistId}`);

    return {
      statusCode: 200,
      headers: getCommunityHeaders(),
      body: JSON.stringify({
        ...result.Attributes,
        artistType: result.Attributes.artist_type || null,
        externalIds: result.Attributes.external_ids || [],  // Provide camelCase for frontend (Fix #2)
        nameVariants: result.Attributes.name_variants || [] // Provide camelCase for frontend (Fix #3a)
      })
    };
  } catch (error) {
    console.error('[MCP_UPDATE_ARTIST] Error:', error);
    return {
      statusCode: 500,
      headers: getCommunityHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

// ============================================================================
// MCP LIST ARTISTS ENDPOINT (Public, No Auth Required)
// ============================================================================

async function handleListArtistsMcp(event) {
  const queryParams = event.queryStringParameters || {};

  // Known parameter names - reject any unknown ones to prevent silent filter failures
  const KNOWN_PARAMS = new Set([
    'limit', 'offset',
    'missingSocials', 'missingLocation', 'missingGenres',
    'region', 'createdSince'
  ]);
  const unknownParams = Object.keys(queryParams).filter(p => !KNOWN_PARAMS.has(p));
  if (unknownParams.length > 0) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        error: `Unknown parameter(s): ${unknownParams.join(', ')}`,
        knownParameters: Array.from(KNOWN_PARAMS),
        message: 'Unknown parameters are rejected to prevent silent filter failures. Check parameter names.'
      })
    };
  }

  // Parse pagination params
  const limit = Math.min(parseInt(queryParams.limit) || 100, 500);
  const offset = parseInt(queryParams.offset) || 0;

  // Parse filter params
  const missingSocials = queryParams.missingSocials === 'true';
  const missingLocation = queryParams.missingLocation === 'true';
  const missingGenres = queryParams.missingGenres === 'true';
  const region = queryParams.region || null;
  const createdSince = queryParams.createdSince || null;

  console.log(`[MCP_LIST_ARTISTS] Listing artists - limit: ${limit}, offset: ${offset}, filters: missingSocials=${missingSocials}, missingLocation=${missingLocation}, missingGenres=${missingGenres}, region=${region}, createdSince=${createdSince}`);

  try {
    // Build filter expressions for DynamoDB scan
    const filterExpressions = [];
    const expressionAttributeNames = {
      '#name': 'name',
      '#location': 'location',
      '#source': 'source'
    };
    const expressionAttributeValues = {};

    // Filter: missingSocials - no Facebook, Instagram, or website
    if (missingSocials) {
      filterExpressions.push('(attribute_not_exists(facebookUrl) OR facebookUrl = :emptyStr) AND (attribute_not_exists(instagramUrl) OR instagramUrl = :emptyStr) AND (attribute_not_exists(websiteUrl) OR websiteUrl = :emptyStr)');
      expressionAttributeValues[':emptyStr'] = '';
    }

    // Filter: missingLocation - no location string
    if (missingLocation) {
      filterExpressions.push('(attribute_not_exists(#location) OR #location = :emptyStr2)');
      expressionAttributeValues[':emptyStr2'] = '';
    }

    // Filter: missingGenres - empty or no genres array
    if (missingGenres) {
      filterExpressions.push('(attribute_not_exists(genres) OR size(genres) = :zero)');
      expressionAttributeValues[':zero'] = 0;
    }

    // Filter: region - location contains region string
    if (region) {
      filterExpressions.push('contains(#location, :region)');
      expressionAttributeValues[':region'] = region;
    }

    // Filter: createdSince - created after specified date
    if (createdSince) {
      filterExpressions.push('createdAt >= :createdSince');
      expressionAttributeValues[':createdSince'] = createdSince;
    }

    // Build scan params
    const scanParams = {
      TableName: 'bndy-artists',
      ProjectionExpression: 'id, #name, bio, #location, locationLat, locationLng, locationType, genres, facebookUrl, instagramUrl, websiteUrl, youtubeUrl, spotifyUrl, twitterUrl, profileImageUrl, isVerified, claimedByUserId, artist_type, actType, acoustic, #source, ai_created, needs_review, external_ids, createdAt, updated_at',
      ExpressionAttributeNames: expressionAttributeNames
    };

    if (filterExpressions.length > 0) {
      scanParams.FilterExpression = filterExpressions.join(' AND ');
      scanParams.ExpressionAttributeValues = expressionAttributeValues;
    }

    // Scan all items (for filtering - DynamoDB requires full scan for complex filters)
    const allItems = [];
    let lastEvaluatedKey = null;

    do {
      if (lastEvaluatedKey) {
        scanParams.ExclusiveStartKey = lastEvaluatedKey;
      }
      const result = await dynamodb.scan(scanParams).promise();
      allItems.push(...result.Items);
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    // Apply pagination in memory (DynamoDB scan doesn't support offset)
    const totalCount = allItems.length;
    const paginatedItems = allItems.slice(offset, offset + limit);

    // Transform to API format
    const formattedArtists = paginatedItems.map(artist => ({
      id: artist.id,
      name: artist.name,
      artistType: artist.artist_type || null,
      bio: artist.bio || '',
      location: artist.location || '',
      locationLat: artist.locationLat || null,
      locationLng: artist.locationLng || null,
      locationType: artist.locationType || null,
      genres: artist.genres || [],
      actType: artist.actType || null,
      acoustic: artist.acoustic || false,
      facebookUrl: artist.facebookUrl || '',
      instagramUrl: artist.instagramUrl || '',
      websiteUrl: artist.websiteUrl || '',
      youtubeUrl: artist.youtubeUrl || '',
      spotifyUrl: artist.spotifyUrl || '',
      twitterUrl: artist.twitterUrl || '',
      profileImageUrl: artist.profileImageUrl || '',
      externalIds: artist.external_ids || [],
      isVerified: artist.isVerified || false,
      isClaimed: !!artist.claimedByUserId,
      source: artist.source || null,
      aiCreated: artist.ai_created || false,
      needsReview: artist.needs_review || false,
      createdAt: artist.createdAt || null,
      updatedAt: artist.updated_at || null
    }));

    console.log(`[MCP_LIST_ARTISTS] Returning ${formattedArtists.length} of ${totalCount} total artists`);

    return {
      statusCode: 200,
      headers: getCommunityHeaders(),
      body: JSON.stringify({
        artists: formattedArtists,
        pagination: {
          count: totalCount,
          returned: formattedArtists.length,
          offset: offset,
          limit: limit,
          hasMore: offset + limit < totalCount
        }
      })
    };
  } catch (error) {
    console.error('[MCP_LIST_ARTISTS] Error:', error);
    return {
      statusCode: 500,
      headers: getCommunityHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

// CORS headers for community endpoints (B2: dynamic allowlist for wizard)
// Note: event param optional for backwards compat; pass it for proper origin echo
function getCommunityHeaders(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || '';
  const allowedOrigins = [
    'https://live.bndy.co.uk',
    'https://gigmap.bndy.co.uk',
    'https://www.bndy.co.uk',
    'https://bndy.co.uk',
    'http://localhost:3000'
  ];
  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Credentials': 'false'
  };
}

function getCorsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': getAllowedOrigin(),
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Credentials': 'true'
  };
}
// ========== CURATOR HANDLERS (backlog feature 4) ==========
// Role gate + whitelist + activity log. Edits delegate to handleUpdateArtist
// via the internal __curatorApproved flag, so geocoding and validation apply.
// The whitelist excludes `name`: artist identity stays with staff and the
// uniqueness sentinels stay coherent.

const CURATOR_ARTIST_FIELDS = [
  'bio', 'location', 'locationType', 'locationLat', 'locationLng', 'genres', 'actType',
  'facebookUrl', 'instagramUrl', 'websiteUrl', 'socialMediaUrls', 'profileImageUrl'
];

// This lambda holds JWT_SECRET in env — hand curator-core a stub SSM client
// that fails fast, so its env fallback path is the one that runs.
const ARTIST_CURATOR_DEPS = {
  dynamodb,
  ssm: { getParameter: () => ({ promise: () => Promise.reject(new Error('no SSM in artists-lambda')) }) }
};

async function getArtistNameForLog(artistId) {
  try {
    const r = await dynamodb.get({ TableName: 'bndy-artists', Key: { id: artistId } }).promise();
    return r.Item?.name || null;
  } catch {
    return null;
  }
}

async function handleCuratorUpdateArtist(event) {
  const gate = await requireCuratorRole(ARTIST_CURATOR_DEPS, event, ['curator', 'staff']);
  if (gate.error) {
    return { statusCode: gate.statusCode, headers: getCorsHeaders(), body: JSON.stringify({ error: gate.error }) };
  }

  const artistId = event.pathParameters?.id;
  if (!artistId) {
    return { statusCode: 400, headers: getCorsHeaders(), body: JSON.stringify({ error: 'Artist ID is required' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: getCorsHeaders(), body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const fields = pickCuratorFields(body, CURATOR_ARTIST_FIELDS);
  if (Object.keys(fields).length === 0) {
    return { statusCode: 400, headers: getCorsHeaders(), body: JSON.stringify({ error: `No editable field in body. Allowed: ${CURATOR_ARTIST_FIELDS.join(', ')}` }) };
  }

  const delegateEvent = { ...event, body: JSON.stringify(fields), __curatorApproved: true };
  const result = await handleUpdateArtist(delegateEvent);

  if (result.statusCode === 200) {
    await logCuratorActivity(dynamodb, {
      actorCognitoId: gate.user.userId,
      actorName: gate.dbUser.display_name,
      action: 'edit',
      entityType: 'artist',
      entityId: artistId,
      entityName: await getArtistNameForLog(artistId),
      detail: Object.keys(fields).join(',')
    });
  }
  return result;
}

async function handleCuratorHideArtist(event) {
  const gate = await requireCuratorRole(ARTIST_CURATOR_DEPS, event, ['curator', 'staff']);
  if (gate.error) {
    return { statusCode: gate.statusCode, headers: getCorsHeaders(), body: JSON.stringify({ error: gate.error }) };
  }

  const artistId = event.pathParameters?.id;
  if (!artistId) {
    return { statusCode: 400, headers: getCorsHeaders(), body: JSON.stringify({ error: 'Artist ID is required' }) };
  }

  let reason = null;
  try {
    reason = JSON.parse(event.body || '{}').reason || null;
  } catch { /* body optional */ }

  const name = await getArtistNameForLog(artistId);
  try {
    await hideArtistEntity(dynamodb, { tableName: 'bndy-artists', id: artistId, actor: gate.user.userId, reason });
  } catch (e) {
    if (e.code === 'ConditionalCheckFailedException') {
      return { statusCode: 404, headers: getCorsHeaders(), body: JSON.stringify({ error: 'Artist not found' }) };
    }
    throw e;
  }

  await logCuratorActivity(dynamodb, {
    actorCognitoId: gate.user.userId,
    actorName: gate.dbUser.display_name,
    action: 'hide',
    entityType: 'artist',
    entityId: artistId,
    entityName: name,
    detail: reason
  });

  return { statusCode: 200, headers: getCorsHeaders(), body: JSON.stringify({ success: true, id: artistId, hidden: true }) };
}

async function handleCuratorRestoreArtist(event) {
  const gate = await requireCuratorRole(ARTIST_CURATOR_DEPS, event, ['staff']);
  if (gate.error) {
    return { statusCode: gate.statusCode, headers: getCorsHeaders(), body: JSON.stringify({ error: gate.error }) };
  }

  const artistId = event.pathParameters?.id;
  if (!artistId) {
    return { statusCode: 400, headers: getCorsHeaders(), body: JSON.stringify({ error: 'Artist ID is required' }) };
  }

  const name = await getArtistNameForLog(artistId);
  try {
    await restoreArtistEntity(dynamodb, { tableName: 'bndy-artists', id: artistId });
  } catch (e) {
    if (e.code === 'ConditionalCheckFailedException') {
      return { statusCode: 404, headers: getCorsHeaders(), body: JSON.stringify({ error: 'Artist not found' }) };
    }
    throw e;
  }

  await logCuratorActivity(dynamodb, {
    actorCognitoId: gate.user.userId,
    actorName: gate.dbUser.display_name,
    action: 'restore',
    entityType: 'artist',
    entityId: artistId,
    entityName: name
  });

  return { statusCode: 200, headers: getCorsHeaders(), body: JSON.stringify({ success: true, id: artistId, hidden: false }) };
}
