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
    ProjectionExpression: 'id, #name, bio, #location, genres, facebookUrl, instagramUrl, websiteUrl, socialMediaUrls, profileImageUrl, isVerified, followerCount, claimedByUserId, createdAt',
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
      genres: artist.genres || [],
      facebookUrl: artist.facebookUrl || '',
      instagramUrl: artist.instagramUrl || '',
      websiteUrl: artist.websiteUrl || '',
      socialMediaUrls: artist.socialMediaUrls || [],
      profileImageUrl: artist.profileImageUrl || '',
      isVerified: artist.isVerified || false,
      followerCount: artist.followerCount || 0,
      claimedByUserId: artist.claimedByUserId || null,
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
      genres: result.Item.genres || [],
      facebookUrl: result.Item.facebookUrl || '',
      instagramUrl: result.Item.instagramUrl || '',
      websiteUrl: result.Item.websiteUrl || '',
      socialMediaUrls: result.Item.socialMediaUrls || [],
      profileImageUrl: result.Item.profileImageUrl || '',
      isVerified: result.Item.isVerified || false,
      followerCount: result.Item.followerCount || 0,
      claimedByUserId: result.Item.claimedByUserId || null,
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
    UpdateExpression: 'SET #name = :name, bio = :bio, #location = :location, genres = :genres, isVerified = :isVerified, updated_at = :updated_at',
    ExpressionAttributeNames: {
      '#name': 'name',
      '#location': 'location'
    },
    ExpressionAttributeValues: {
      ':name': artistData.name,
      ':bio': artistData.bio || '',
      ':location': artistData.location || '',
      ':genres': artistData.genres || [],
      ':isVerified': artistData.isVerified || false,
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

function getCorsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': FRONTEND_URL,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Credentials': 'true'
  };
}