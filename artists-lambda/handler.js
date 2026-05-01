// BNDY Artists Lambda Function - DynamoDB Version
// Handles: /api/artists, /api/artists/:id

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const https = require('https');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });
const s3 = new AWS.S3({ region: 'eu-west-2' });

// Configuration
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';

// Allowed CORS origins for frontend access
const ALLOWED_ORIGINS = [
  'https://www.bndy.co.uk',       // Primary domain
  'https://backstage.bndy.co.uk', // Legacy domain
  'https://bndy.co.uk',            // Apex domain
  'https://live.bndy.co.uk',      // Frontstage
  'http://localhost:3000'          // Local development
];

// Module-level variable to store current request event for CORS
let currentEvent = null;

// Get appropriate origin for CORS based on request origin
const getAllowedOrigin = () => {
  const requestOrigin = currentEvent?.headers?.origin || currentEvent?.headers?.Origin;
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
};

// JWT Secret - cached after first retrieval
let JWT_SECRET = null;

/**
 * Get JWT secret from SSM Parameter Store with fallback to env var
 */
async function getJWTSecret() {
  if (JWT_SECRET) {
    return JWT_SECRET; // Return cached value
  }

  // Try SSM first
  try {
    const result = await ssm.getParameter({
      Name: '/bndy/auth/jwt-secret',
      WithDecryption: true
    }).promise();
    JWT_SECRET = result.Parameter.Value;
    console.log('[ARTISTS] JWT_SECRET loaded from SSM');
    return JWT_SECRET;
  } catch (error) {
    console.error('[ARTISTS] Failed to get JWT_SECRET from SSM:', error.message);
    // Fallback to environment variable
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      console.log('[ARTISTS] JWT_SECRET loaded from environment variable (fallback)');
      return JWT_SECRET;
    }
    throw new Error('JWT_SECRET not available from SSM or environment');
  }
}

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
    const jwtSecret = await getJWTSecret();
    const session = jwt.verify(sessionToken, jwtSecret);

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
      return await handleGetAllArtists();
    }

    // External ID lookup endpoint
    if (method === 'GET' && path === '/api/artists/by-external-id') {
      return await handleGetArtistByExternalId(event);
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
      return await handleGetArtistById(event.pathParameters.id);
    }

    if (method === 'POST' && path === '/api/artists') {
      return await handleCreateArtist(event);
    }

    // Community artist creation endpoint (public, no auth required)
    if (method === 'POST' && path === '/api/artists/community') {
      return await handleCreateCommunityArtist(event);
    }

    if (method === 'PUT' && event.pathParameters?.id) {
      // Check if this is an MCP update request (public, no auth)
      if (path.includes('/mcp')) {
        return await handleMCPUpdateArtist(event);
      }
      return await handleUpdateArtist(event);
    }

    if (method === 'DELETE' && event.pathParameters?.id) {
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

async function handleGetAllArtists() {
  console.log(' Artists Lambda: Scanning all artists from DynamoDB...');

  const params = {
    TableName: 'bndy-artists',
    ProjectionExpression: 'id, #name, bio, #location, locationLat, locationLng, locationType, genres, facebookUrl, instagramUrl, websiteUrl, socialMediaUrls, profileImageUrl, isVerified, followerCount, claimedByUserId, allowedEventTypes, displayColour, artist_type, actType, acoustic, publishAvailability, showMemberVotes, autoDiscardThreshold, #source, ai_created, needs_review, owner_user_id, validated, createdAt',
    ExpressionAttributeNames: {
      '#name': 'name',
      '#location': 'location',
      '#source': 'source'
    }
  };

  try {
    const result = await dynamodb.scan(params).promise();

    // Transform to match expected API format
    const formattedArtists = result.Items.map(artist => ({
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
      showMemberVotes: artist.showMemberVotes || false,
      autoDiscardThreshold: artist.autoDiscardThreshold ?? null,
      facebookUrl: artist.facebookUrl || '',
      instagramUrl: artist.instagramUrl || '',
      websiteUrl: artist.websiteUrl || '',
      socialMediaUrls: artist.socialMediaUrls || [],
      profileImageUrl: artist.profileImageUrl || '',
      externalIds: artist.external_ids || [],
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

    return {
      statusCode: 200,
      headers: {
        ...getCorsHeaders(),
        'Cache-Control': 'public, max-age=300'
      },
      body: JSON.stringify(formattedArtists)
    };
  } catch (error) {
    console.error(' DynamoDB scan failed:', error);
    throw error;
  }
}

async function handleGetArtistById(artistId) {
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
      createdAt: result.Item.createdAt,
      updatedAt: result.Item.updatedAt
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
    // Scan and filter for matching externalId
    const result = await dynamodb.scan({
      TableName: 'bndy-artists'
    }).promise();

    // Find artist with matching externalId
    const matchingArtist = result.Items.find(artist => {
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
      createdAt: matchingArtist.created_at,
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

    created_at: now,
    updated_at: now
  };

  try {
    // Create artist record
    await dynamodb.put({
      TableName: 'bndy-artists',
      Item: artist
    }).promise();

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

  // Check access - platform admin OR member
  if (!user.platformAdmin) {
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
    updateParts.push('genres = :genres');
    expressionAttributeValues[':genres'] = artistData.genres || [];
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

  // Allow updating source (for enabling artists in backstage - platform admin only)
  if (artistData.source !== undefined) {
    expressionAttributeNames['#source'] = 'source';
    updateParts.push('#source = :source');
    expressionAttributeValues[':source'] = artistData.source;
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
    const result = await dynamodb.update(params).promise();

    // Transform response to match frontend expectations (snake_case -> camelCase)
    const transformedArtist = {
      ...result.Attributes,
      artistType: result.Attributes.artist_type || null, // Provide camelCase for compatibility
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
      ProjectionExpression: 'id, #name, #location',
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
    // Step 1: Query all memberships for this artist
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

    // Step 2: Delete all memberships (cascade delete)
    for (const membership of membershipsResult.Items) {
      await dynamodb.delete({
        TableName: MEMBERSHIPS_TABLE,
        Key: { membership_id: membership.membership_id }
      }).promise();
      console.log(` Deleted membership: ${membership.membership_id} for user: ${membership.user_id}`);
    }

    // Step 3: Delete the artist record
    const artistParams = {
      TableName: 'bndy-artists',
      Key: { id: artistId }
    };

    await dynamodb.delete(artistParams).promise();
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
      ProjectionExpression: 'id, #name, #location, locationLat, locationLng, locationType, profileImageUrl',
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
    const { name, location, locationType, locationLat, locationLng, facebookUrl, instagramUrl, websiteUrl, bio, genres, artist_type, artistType, actType, acoustic, profileImageUrl, externalIds } = body;

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
      genres: Array.isArray(genres) ? genres : [],

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

      created_at: now,
      updated_at: now
    };

    await dynamodb.put({
      TableName: 'bndy-artists',
      Item: newArtist
    }).promise();

    console.log(` Community artist created: ${artistId} (${name}) with ${locationType || 'unknown'} location`);

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
          externalIds: newArtist.external_ids
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

    // Security check: Only allow updates to AI-created or community artists
    const source = existingArtist.Item.source || '';
    const aiCreated = existingArtist.Item.ai_created || false;
    const allowedSources = ['mcp', 'mcp_ai_import', 'community_wizard', 'frontstage'];
    const isAllowed = aiCreated || allowedSources.some(s => source.includes(s));

    if (!isAllowed) {
      console.log(`[MCP_UPDATE_ARTIST] Rejected - artist source "${source}" not allowed for MCP updates`);
      return {
        statusCode: 403,
        headers: getCommunityHeaders(),
        body: JSON.stringify({
          error: 'Cannot update this artist via MCP',
          message: 'Only AI-created or community artists can be updated via MCP endpoint'
        })
      };
    }

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
    if (artistData.genres !== undefined) {
      updateParts.push('genres = :genres');
      expressionAttributeValues[':genres'] = artistData.genres || [];
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
      updateParts.push('external_ids = :external_ids');
      expressionAttributeValues[':external_ids'] = artistData.externalIds || [];
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

    const result = await dynamodb.update(params).promise();

    console.log(`[MCP_UPDATE_ARTIST] Successfully updated artist: ${artistId}`);

    return {
      statusCode: 200,
      headers: getCommunityHeaders(),
      body: JSON.stringify({
        ...result.Attributes,
        artistType: result.Attributes.artist_type || null
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

// CORS headers for community endpoints (allows live.bndy.co.uk)
function getCommunityHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://live.bndy.co.uk',
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