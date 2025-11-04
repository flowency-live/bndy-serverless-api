// BNDY Artists Lambda Function - DynamoDB Version
// Handles: /api/artists, /api/artists/:id

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

// Configuration
const JWT_SECRET = process.env.JWT_SECRET;
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';
const FRONTEND_URL = 'https://backstage.bndy.co.uk';

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
const requireAuth = (event) => {
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
    return { user: session };
  } catch (error) {
    console.error('🔐 Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

exports.handler = async (event, context) => {
  // HTTP API v2 payload format compatibility
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;

  console.log('🎵 Artists Lambda: Request received', {
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
    console.error('❌ Artists Lambda: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

async function handleGetAllArtists() {
  console.log('🎵 Artists Lambda: Scanning all artists from DynamoDB...');

  const params = {
    TableName: 'bndy-artists',
    ProjectionExpression: 'id, #name, bio, #location, locationLat, locationLng, genres, facebookUrl, instagramUrl, websiteUrl, socialMediaUrls, profileImageUrl, isVerified, followerCount, claimedByUserId, allowedEventTypes, displayColour, createdAt',
    ExpressionAttributeNames: {
      '#name': 'name',
      '#location': 'location'
    }
  };

  try {
    const result = await dynamodb.scan(params).promise();

    // Transform to match expected API format
    const formattedArtists = result.Items.map(artist => ({
      id: artist.id,
      name: artist.name,
      bio: artist.bio || '',
      location: artist.location || '',
      locationLat: artist.locationLat || null,
      locationLng: artist.locationLng || null,
      genres: artist.genres || [],
      facebookUrl: artist.facebookUrl || '',
      instagramUrl: artist.instagramUrl || '',
      websiteUrl: artist.websiteUrl || '',
      socialMediaUrls: artist.socialMediaUrls || [],
      profileImageUrl: artist.profileImageUrl || '',
      isVerified: artist.isVerified || false,
      followerCount: artist.followerCount || 0,
      claimedByUserId: artist.claimedByUserId || null,
      allowedEventTypes: artist.allowedEventTypes || ['practice', 'public_gig'],
      displayColour: artist.displayColour || '#f97316',
      createdAt: artist.createdAt
    }));

    console.log(`🎵 Artists Lambda: Served ${formattedArtists.length} artists`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify(formattedArtists)
    };
  } catch (error) {
    console.error('❌ DynamoDB scan failed:', error);
    throw error;
  }
}

async function handleGetArtistById(artistId) {
  console.log(`🎵 Artists Lambda: Getting artist by ID: ${artistId}`);

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
      bio: result.Item.bio || '',
      location: result.Item.location || '',
      locationLat: result.Item.locationLat || null,
      locationLng: result.Item.locationLng || null,
      genres: result.Item.genres || [],
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
      allowedEventTypes: result.Item.allowedEventTypes || ['practice', 'public_gig'],
      displayColour: result.Item.displayColour || '#f97316',
      createdAt: result.Item.createdAt,
      updatedAt: result.Item.updatedAt
    };

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify(artist)
    };
  } catch (error) {
    console.error('❌ DynamoDB get failed:', error);
    throw error;
  }
}

async function handleCreateArtist(event) {
  console.log('🎵 Artists Lambda: Creating new artist');

  // Require authentication for creating artists
  const authResult = requireAuth(event);
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

  const artist = {
    id: artistId,
    name: artistData.name,
    bio: artistData.bio || '',
    location: artistData.location || '',
    locationLat: artistData.locationLat || null,
    locationLng: artistData.locationLng || null,
    genres: artistData.genres || [],

    // NEW: Artist type field (band, solo, duo, group, dj, collective)
    artist_type: artistData.artistType || artistData.artist_type || 'band',

    // NEW: Owner tracking
    owner_user_id: user.userId,
    member_count: 1, // Creator is first member

    // Social media
    facebookUrl: artistData.facebookUrl || '',
    instagramUrl: artistData.instagramUrl || '',
    websiteUrl: artistData.websiteUrl || '',
    socialMediaUrls: artistData.socialMediaUrls || [],
    profileImageUrl: artistData.profileImageUrl || artistData.avatarUrl || '',

    // Display customization
    displayColour: artistData.displayColour || '#f97316',

    isVerified: false,
    followerCount: 0,
    claimedByUserId: null, // Deprecated - use owner_user_id
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

    console.log('✅ Artist and owner membership created successfully');

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
    console.error('❌ DynamoDB put failed:', error);
    throw error;
  }
}

async function handleUpdateArtist(artistId, artistData) {
  console.log(`🎵 Artists Lambda: Updating artist: ${artistId}`);

  const now = new Date().toISOString();

  const params = {
    TableName: 'bndy-artists',
    Key: { id: artistId },
    UpdateExpression: 'SET #name = :name, bio = :bio, #location = :location, locationLat = :locationLat, locationLng = :locationLng, genres = :genres, isVerified = :isVerified, profileImageUrl = :profileImageUrl, allowedEventTypes = :allowedEventTypes, displayColour = :displayColour, facebookUrl = :facebookUrl, instagramUrl = :instagramUrl, websiteUrl = :websiteUrl, youtubeUrl = :youtubeUrl, spotifyUrl = :spotifyUrl, twitterUrl = :twitterUrl, updated_at = :updated_at',
    ExpressionAttributeNames: {
      '#name': 'name',
      '#location': 'location'
    },
    ExpressionAttributeValues: {
      ':name': artistData.name,
      ':bio': artistData.bio || '',
      ':location': artistData.location || '',
      ':locationLat': artistData.locationLat !== undefined ? artistData.locationLat : null,
      ':locationLng': artistData.locationLng !== undefined ? artistData.locationLng : null,
      ':genres': artistData.genres || [],
      ':isVerified': artistData.isVerified || false,
      ':profileImageUrl': artistData.profileImageUrl || '',
      ':allowedEventTypes': artistData.allowedEventTypes || ['practice', 'public_gig'],
      ':displayColour': artistData.displayColour || '#f97316',
      ':facebookUrl': artistData.facebookUrl || null,
      ':instagramUrl': artistData.instagramUrl || null,
      ':websiteUrl': artistData.websiteUrl || null,
      ':youtubeUrl': artistData.youtubeUrl || null,
      ':spotifyUrl': artistData.spotifyUrl || null,
      ':twitterUrl': artistData.twitterUrl || null,
      ':updated_at': now
    },
    ReturnValues: 'ALL_NEW'
  };

  try {
    const result = await dynamodb.update(params).promise();
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify(result.Attributes)
    };
  } catch (error) {
    console.error('❌ DynamoDB update failed:', error);
    throw error;
  }
}

async function handleCheckName(event) {
  console.log('🎵 Artists Lambda: Checking name availability');

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

    console.log(`🎵 Name "${name}" availability: ${available}, found ${matches.length} matches`);

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
    console.error('❌ DynamoDB scan failed:', error);
    throw error;
  }
}

async function handleDeleteArtist(artistId) {
  console.log(`🎵 Artists Lambda: Deleting artist: ${artistId}`);

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
    console.log(`🎵 Found ${membershipsResult.Items.length} memberships to delete`);

    // Step 2: Delete all memberships (cascade delete)
    for (const membership of membershipsResult.Items) {
      await dynamodb.delete({
        TableName: MEMBERSHIPS_TABLE,
        Key: { membership_id: membership.membership_id }
      }).promise();
      console.log(`✅ Deleted membership: ${membership.membership_id} for user: ${membership.user_id}`);
    }

    // Step 3: Delete the artist record
    const artistParams = {
      TableName: 'bndy-artists',
      Key: { id: artistId }
    };

    await dynamodb.delete(artistParams).promise();
    console.log(`✅ Artist deleted successfully with ${membershipsResult.Items.length} cascaded membership deletions`);

    return {
      statusCode: 204,
      headers: getCorsHeaders(),
      body: ''
    };
  } catch (error) {
    console.error('❌ Artist deletion failed:', error);
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

// Calculate match score (0-100)
function calculateMatchScore(artistName, artistLocation, queryName, queryLocation) {
  const nameLower = artistName.toLowerCase().trim();
  const queryLower = queryName.toLowerCase().trim();

  // Exact match = 100
  if (nameLower === queryLower) {
    // If locations also match, definitely 100
    if (queryLocation && artistLocation) {
      const locLower = artistLocation.toLowerCase().trim();
      const queryLocLower = queryLocation.toLowerCase().trim();
      if (locLower.includes(queryLocLower) || queryLocLower.includes(locLower)) {
        return 100;
      }
      return 80; // Same name, different location
    }
    return 90; // Same name, no location to compare
  }

  // Calculate Levenshtein distance
  const distance = levenshteinDistance(nameLower, queryLower);
  const maxLength = Math.max(nameLower.length, queryLower.length);
  const similarity = (1 - distance / maxLength) * 100;

  // Bonus points for location match
  if (queryLocation && artistLocation) {
    const locLower = artistLocation.toLowerCase().trim();
    const queryLocLower = queryLocation.toLowerCase().trim();
    if (locLower.includes(queryLocLower) || queryLocLower.includes(locLower)) {
      return Math.min(100, similarity + 10);
    }
  }

  return Math.round(similarity);
}

// Search artists (fuzzy matching for duplicate prevention)
async function handleSearchArtists(event) {
  console.log('🔍 Artists Lambda: Searching artists with fuzzy matching');

  const { name, location } = event.queryStringParameters || {};

  if (!name || name.length < 2) {
    return {
      statusCode: 400,
      headers: getCommunityHeaders(),
      body: JSON.stringify({ error: 'Name query must be at least 2 characters' })
    };
  }

  try {
    // Scan all artists (TODO: Optimize with GSI when scale increases)
    const result = await dynamodb.scan({
      TableName: 'bndy-artists',
      ProjectionExpression: 'id, #name, #location, profileImageUrl',
      ExpressionAttributeNames: {
        '#name': 'name',
        '#location': 'location'
      }
    }).promise();

    // Calculate match scores
    const matches = result.Items
      .map(artist => ({
        id: artist.id,
        name: artist.name,
        location: artist.location || '',
        profileImageUrl: artist.profileImageUrl || null,
        matchScore: calculateMatchScore(artist.name, artist.location, name, location || '')
      }))
      .filter(artist => artist.matchScore >= 60)  // Only show matches >= 60%
      .sort((a, b) => b.matchScore - a.matchScore)  // Highest score first
      .slice(0, 10);  // Top 10 matches

    console.log(`🔍 Found ${matches.length} matches for "${name}"`);

    return {
      statusCode: 200,
      headers: getCommunityHeaders(),
      body: JSON.stringify({ matches })
    };
  } catch (error) {
    console.error('❌ Artist search failed:', error);
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
  console.log('🎵 Artists Lambda: Creating community artist');

  try {
    const body = JSON.parse(event.body);
    const { name, location, facebookUrl, instagramUrl, websiteUrl, bio } = body;

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

    const newArtist = {
      id: artistId,
      name: name.trim(),
      location: location.trim(),
      locationLat: null,  // Future: geocode location string
      locationLng: null,
      facebookUrl: facebookUrl || '',
      instagramUrl: instagramUrl || '',
      websiteUrl: websiteUrl || '',
      bio: bio || '',
      profileImageUrl: '',
      isVerified: false,
      claimedByUserId: null,  // Available for claiming
      socialMediaUrls: [],
      followerCount: 0,
      genres: [],

      // Backstage-compatible fields
      owner_user_id: null,  // Community-created = no owner
      artist_type: 'band',
      displayColour: randomColor(),
      member_count: 0,
      allowedEventTypes: ['public_gig'],

      created_at: now,
      updated_at: now
    };

    await dynamodb.put({
      TableName: 'bndy-artists',
      Item: newArtist
    }).promise();

    console.log(`✅ Community artist created: ${artistId} (${name})`);

    return {
      statusCode: 201,
      headers: getCommunityHeaders(),
      body: JSON.stringify({
        message: 'Artist created successfully',
        artist: {
          id: artistId,
          name: newArtist.name,
          location: newArtist.location
        }
      })
    };
  } catch (error) {
    console.error('❌ Community artist creation failed:', error);
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