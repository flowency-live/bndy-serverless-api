// BNDY Songs Lambda Function - DynamoDB Version
// Handles: /api/songs, /api/songs/:id

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });

// JWT Secret - cached after first retrieval
let JWT_SECRET = null;

/**
 * Get JWT secret from SSM Parameter Store with fallback to env var
 */
async function getJWTSecret() {
  if (JWT_SECRET) {
    return JWT_SECRET;
  }

  try {
    const result = await ssm.getParameter({
      Name: '/bndy/auth/jwt-secret',
      WithDecryption: true
    }).promise();
    JWT_SECRET = result.Parameter.Value;
    console.log('[SONGS] JWT_SECRET loaded from SSM');
    return JWT_SECRET;
  } catch (error) {
    console.error('[SONGS] Failed to get JWT_SECRET from SSM:', error.message);
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      console.log('[SONGS] JWT_SECRET loaded from environment variable (fallback)');
      return JWT_SECRET;
    }
    throw new Error('JWT_SECRET not available from SSM or environment');
  }
}

/**
 * Parse cookies from event
 */
const parseCookies = (cookieHeader) => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, value] = cookie.trim().split('=');
    cookies[name] = value;
    return cookies;
  }, {});
};

/**
 * Authentication middleware
 */
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
    console.error('[SONGS] Invalid session token:', error.message);
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

const ALLOWED_ORIGINS = [
  'https://www.bndy.co.uk',       // Primary domain
  'https://backstage.bndy.co.uk', // Legacy domain
  'https://bndy.co.uk',            // Apex domain
  'https://live.bndy.co.uk',      // Frontstage
  'https://gigmap.bndy.co.uk',    // GigMap
  'https://map.bndy.co.uk',       // Map (canonical)
  'https://gigs.bndy.co.uk',      // Gigs
  'http://localhost:3000'          // Local development
];

let currentEvent = null;

const getAllowedOrigin = () => {
  const requestOrigin = currentEvent?.headers?.origin || currentEvent?.headers?.Origin;
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
};

exports.handler = async (event, context) => {
  currentEvent = event;
  // HTTP API v2 payload format compatibility
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;

  console.log('Songs Lambda: Request received', {
    method,
    path,
    pathParameters: event.pathParameters,
    queryStringParameters: event.queryStringParameters
  });

  context.callbackWaitsForEmptyEventLoop = false;

  try {
    // Route requests
    if (method === 'GET' && path === '/api/songs') {
      // If search query provided, use search handler
      if (event.queryStringParameters?.q) {
        return await handleSearchSongs(event.queryStringParameters.q);
      }
      return await handleGetAllSongs();
    }

    if (method === 'GET' && event.pathParameters?.id) {
      return await handleGetSongById(event.pathParameters.id);
    }

    if (method === 'POST' && path === '/api/songs') {
      // SEC-04: Require authentication for song creation
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return {
          statusCode: 401,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: authResult.error })
        };
      }
      return await handleCreateSong(JSON.parse(event.body));
    }

    if (method === 'PUT' && event.pathParameters?.id) {
      // SEC-04: Require authentication for song updates
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return {
          statusCode: 401,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: authResult.error })
        };
      }
      return await handleUpdateSong(event.pathParameters.id, JSON.parse(event.body));
    }

    if (method === 'DELETE' && event.pathParameters?.id) {
      // SEC-XX: Require platformAdmin for song deletion (godmode only)
      const authResult = await requirePlatformAdmin(event);
      if (authResult.error) {
        return {
          statusCode: authResult.statusCode || 401,
          headers: getCorsHeaders(),
          body: JSON.stringify({ error: authResult.error })
        };
      }

      const queryParams = event.queryStringParameters || {};
      if (queryParams.force === 'true') {
        return await handleForceDeleteSong(event.pathParameters.id);
      }
      return await handleDeleteSong(event.pathParameters.id);
    }

    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Route not found', method, path })
    };

  } catch (error) {
    console.error('Songs Lambda: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

async function handleSearchSongs(query) {
  console.log('Songs Lambda: Searching songs with query:', query);

  const params = {
    TableName: 'bndy-songs'
  };

  try {
    const result = await dynamodb.scan(params).promise();

    // Filter songs by title or artist name
    const lowerQuery = query.toLowerCase();
    const filteredSongs = result.Items.filter(song =>
      song.title?.toLowerCase().includes(lowerQuery) ||
      song.artistName?.toLowerCase().includes(lowerQuery)
    );

    // Transform to match expected API format
    const formattedSongs = filteredSongs.map(song => ({
      id: song.id,
      title: song.title,
      artistName: song.artistName || '',
      duration: song.duration || null,
      genre: song.genre || '',
      releaseDate: song.releaseDate || null,
      album: song.album || null,
      albumImageUrl: song.albumImageUrl || null,
      spotifyUrl: song.spotifyUrl || '',
      appleMusicUrl: song.appleMusicUrl || '',
      youtubeUrl: song.youtubeUrl || '',
      audioFileUrl: song.audioFileUrl || '',
      isFeatured: song.isFeatured || false,
      tags: song.tags || [],
      createdAt: song.createdAt
    }));

    console.log('Songs Lambda: Found', formattedSongs.length, 'matching songs');

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify(formattedSongs)
    };
  } catch (error) {
    console.error('DynamoDB scan failed:', error);
    throw error;
  }
}

async function handleGetAllSongs() {
  console.log('Songs Lambda: Scanning all songs from DynamoDB...');

  const params = {
    TableName: 'bndy-songs'
  };

  try {
    const result = await dynamodb.scan(params).promise();

    // Transform to match expected API format
    const formattedSongs = result.Items.map(song => ({
      id: song.id,
      title: song.title,
      artistName: song.artistName || '',
      duration: song.duration || null,
      genre: song.genre || '',
      releaseDate: song.releaseDate || null,
      album: song.album || null,
      spotifyUrl: song.spotifyUrl || '',
      appleMusicUrl: song.appleMusicUrl || '',
      youtubeUrl: song.youtubeUrl || '',
      audioFileUrl: song.audioFileUrl || '',
      isFeatured: song.isFeatured || false,
      tags: song.tags || [],
      createdAt: song.createdAt
    }));

    console.log(`Songs Lambda: Served ${formattedSongs.length} songs`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify(formattedSongs)
    };
  } catch (error) {
    console.error('DynamoDB scan failed:', error);
    throw error;
  }
}

async function handleGetSongById(songId) {
  console.log(`Songs Lambda: Getting song by ID: ${songId}`);

  const params = {
    TableName: 'bndy-songs',
    Key: { id: songId }
  };

  try {
    const result = await dynamodb.get(params).promise();

    if (!result.Item) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Song not found' })
      };
    }

    // Transform to match expected API format
    const song = {
      id: result.Item.id,
      title: result.Item.title,
      artistName: result.Item.artistName || '',
      duration: result.Item.duration || null,
      genre: result.Item.genre || '',
      releaseDate: result.Item.releaseDate || null,
      album: result.Item.album || null,
      albumImageUrl: result.Item.albumImageUrl || null,
      spotifyUrl: result.Item.spotifyUrl || '',
      appleMusicUrl: result.Item.appleMusicUrl || '',
      youtubeUrl: result.Item.youtubeUrl || '',
      audioFileUrl: result.Item.audioFileUrl || '',
      isFeatured: result.Item.isFeatured || false,
      tags: result.Item.tags || [],
      createdAt: result.Item.createdAt,
      updatedAt: result.Item.updatedAt
    };

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify(song)
    };
  } catch (error) {
    console.error('DynamoDB get failed:', error);
    throw error;
  }
}

async function handleCreateSong(songData) {
  console.log('Songs Lambda: Creating new song');

  const now = new Date().toISOString();
  const song = {
    id: require('crypto').randomUUID(),
    title: songData.title,
    artistName: songData.artistName || '',
    duration: songData.duration || null,
    genre: songData.genre || '',
    releaseDate: songData.releaseDate || null,
    album: songData.album || null,
    albumImageUrl: songData.albumImageUrl || null,
    previewUrl: songData.previewUrl || null,
    spotifyUrl: songData.spotifyUrl || '',
    appleMusicUrl: songData.appleMusicUrl || '',
    youtubeUrl: songData.youtubeUrl || '',
    audioFileUrl: songData.audioFileUrl || '',
    isFeatured: songData.isFeatured || false,
    tags: songData.tags || [],
    createdAt: now,
    updatedAt: now
  };

  const params = {
    TableName: 'bndy-songs',
    Item: song
  };

  try {
    await dynamodb.put(params).promise();
    return {
      statusCode: 201,
      headers: getCorsHeaders(),
      body: JSON.stringify(song)
    };
  } catch (error) {
    console.error('DynamoDB put failed:', error);
    throw error;
  }
}

async function handleUpdateSong(songId, songData) {
  console.log(`Songs Lambda: Updating song: ${songId}`, { songId, fields: Object.keys(songData) });

  const now = new Date().toISOString();

  // Build dynamic update expression based on provided fields
  const updateExpressions = [];
  const expressionAttributeValues = {};
  const expressionAttributeNames = {};

  // Always update the updatedAt timestamp
  updateExpressions.push('#updatedAt = :updatedAt');
  expressionAttributeNames['#updatedAt'] = 'updatedAt';
  expressionAttributeValues[':updatedAt'] = now;

  // Add each provided field to the update
  const fieldMapping = {
    title: 'title',
    artistName: 'artistName',
    duration: 'duration',
    genre: 'genre',
    releaseDate: 'releaseDate',
    album: 'album',
    albumImageUrl: 'albumImageUrl',
    previewUrl: 'previewUrl',
    spotifyUrl: 'spotifyUrl',
    appleMusicUrl: 'appleMusicUrl',
    youtubeUrl: 'youtubeUrl',
    audioFileUrl: 'audioFileUrl',
    isFeatured: 'isFeatured',
    tags: 'tags'
  };

  for (const [key, dbField] of Object.entries(fieldMapping)) {
    if (songData.hasOwnProperty(key)) {
      updateExpressions.push(`#${dbField} = :${dbField}`);
      expressionAttributeNames[`#${dbField}`] = dbField;
      expressionAttributeValues[`:${dbField}`] = songData[key];
    }
  }

  const params = {
    TableName: 'bndy-songs',
    Key: { id: songId },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW'
  };

  console.log('Songs Lambda: Update params:', JSON.stringify(params, null, 2));

  try {
    const result = await dynamodb.update(params).promise();
    console.log('Songs Lambda: Update successful');
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify(result.Attributes)
    };
  } catch (error) {
    console.error('DynamoDB update failed:', error);
    throw error;
  }
}

async function handleDeleteSong(songId) {
  console.log(`Songs Lambda: Deleting song: ${songId}`);

  try {
    // First, check how many artist-songs reference this song
    const artistSongsQuery = {
      TableName: 'bndy-artist-songs',
      IndexName: 'song_id-index',
      KeyConditionExpression: 'song_id = :songId',
      ExpressionAttributeValues: {
        ':songId': songId
      }
    };

    const artistSongsResult = await dynamodb.query(artistSongsQuery).promise();
    const artistSongCount = artistSongsResult.Items?.length || 0;

    console.log(`Found ${artistSongCount} artist-songs referencing this song`);

    // If artist-songs exist, return info for frontend to confirm
    if (artistSongCount > 0) {
      return {
        statusCode: 409, // Conflict
        headers: getCorsHeaders(),
        body: JSON.stringify({
          message: `This song is in ${artistSongCount} band playbook(s). Delete everywhere?`,
          artistSongCount: artistSongCount,
          requiresConfirmation: true
        })
      };
    }

    // No artist-songs, safe to delete from bndy-songs only
    const deleteParams = {
      TableName: 'bndy-songs',
      Key: { id: songId }
    };

    await dynamodb.delete(deleteParams).promise();

    return {
      statusCode: 204,
      headers: getCorsHeaders(),
      body: ''
    };
  } catch (error) {
    console.error('DynamoDB delete failed:', error);
    throw error;
  }
}

async function handleForceDeleteSong(songId) {
  console.log(`Songs Lambda: Force deleting song and all artist-songs: ${songId}`);

  try {
    // Get all artist-songs that reference this song
    const artistSongsQuery = {
      TableName: 'bndy-artist-songs',
      IndexName: 'song_id-index',
      KeyConditionExpression: 'song_id = :songId',
      ExpressionAttributeValues: {
        ':songId': songId
      }
    };

    const artistSongsResult = await dynamodb.query(artistSongsQuery).promise();
    const artistSongs = artistSongsResult.Items || [];

    console.log(`Deleting ${artistSongs.length} artist-songs`);

    // Delete all artist-songs
    await Promise.all(
      artistSongs.map(artistSong =>
        dynamodb.delete({
          TableName: 'bndy-artist-songs',
          Key: { id: artistSong.id }
        }).promise()
      )
    );

    // Delete the base song
    await dynamodb.delete({
      TableName: 'bndy-songs',
      Key: { id: songId }
    }).promise();

    console.log(`Successfully deleted song ${songId} and ${artistSongs.length} artist-songs`);

    return {
      statusCode: 204,
      headers: getCorsHeaders(),
      body: ''
    };
  } catch (error) {
    console.error('Force delete failed:', error);
    throw error;
  }
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