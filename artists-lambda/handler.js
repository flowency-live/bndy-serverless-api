// BNDY Artists Lambda Function - DynamoDB Version
// Handles: /api/artists, /api/artists/:id

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const https = require('https');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });

// Configuration
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';
const FRONTEND_URL = 'https://backstage.bndy.co.uk';

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
    return { user: session };
  } catch (error) {
    console.error(' Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

exports.handler = async (event, context) => {
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
      return await handleUpdateArtist(event.pathParameters.id, JSON.parse(event.body));
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
    ProjectionExpression: 'id, #name, bio, #location, locationLat, locationLng, locationType, genres, facebookUrl, instagramUrl, websiteUrl, socialMediaUrls, profileImageUrl, isVerified, followerCount, claimedByUserId, allowedEventTypes, displayColour, artist_type, actType, acoustic, #source, ai_created, needs_review, owner_user_id, validated, createdAt',
    ExpressionAttributeNames: {
      '#name': 'name',
      '#location': 'location',
      '#source': 'source'
    }
  };

  try {
    const result = await dynamodb.scan(params).promise();

    // Get event counts for all artists in parallel
    const eventCountPromises = result.Items.map(async (artist) => {
      try {
        // Query events table using artist_id-index to count events
        const eventCountResult = await dynamodb.query({
          TableName: 'bndy-events',
          IndexName: 'artist_id-index',
          KeyConditionExpression: 'artist_id = :artistId',
          ExpressionAttributeValues: {
            ':artistId': artist.id
          },
          Select: 'COUNT'
        }).promise();

        return { artistId: artist.id, count: eventCountResult.Count || 0 };
      } catch (error) {
        console.error(`Error counting events for artist ${artist.id}:`, error);
        return { artistId: artist.id, count: 0 };
      }
    });

    const eventCounts = await Promise.all(eventCountPromises);
    const eventCountMap = eventCounts.reduce((map, { artistId, count }) => {
      map[artistId] = count;
      return map;
    }, {});

    // Transform to match expected API format
    const formattedArtists = result.Items.map(artist => ({
      id: artist.id,
      name: artist.name,
      artist_type: artist.artist_type || null,
      artistType: artist.artist_type || null, // Provide both formats for compatibility
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
      socialMediaUrls: artist.socialMediaUrls || [],
      profileImageUrl: artist.profileImageUrl || '',
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
      eventCount: eventCountMap[artist.id] || 0,
      createdAt: artist.createdAt
    }));

    console.log(` Artists Lambda: Served ${formattedArtists.length} artists`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
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

async function handleUpdateArtist(artistId, artistData) {
  console.log(` Artists Lambda: Updating artist: ${artistId}`);

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
    const { name, location, locationType, locationLat, locationLng, facebookUrl, instagramUrl, websiteUrl, bio, genres, artist_type, artistType, actType, acoustic } = body;

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

    // Fetch Facebook profile picture if Facebook URL provided
    let profileImageUrl = '';
    if (facebookUrl) {
      console.log('[CREATE_COMMUNITY_ARTIST] Attempting to fetch Facebook profile image...');
      const fbImage = await fetchFacebookProfilePicture(facebookUrl);
      if (fbImage) {
        profileImageUrl = fbImage;
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
      profileImageUrl,
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
          locationType: newArtist.locationType
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
    'Access-Control-Allow-Origin': FRONTEND_URL,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Credentials': 'true'
  };
}