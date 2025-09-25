// BNDY Songs Lambda Function - DynamoDB Version
// Handles: /api/songs, /api/songs/:id

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

exports.handler = async (event, context) => {
  console.log('🎶 Songs Lambda: Request received', {
    httpMethod: event.httpMethod,
    path: event.path,
    pathParameters: event.pathParameters
  });
  console.log('🚀 DynamoDB version - FAST AS FUCK');

  context.callbackWaitsForEmptyEventLoop = false;

  try {
    // Route requests
    if (event.httpMethod === 'GET' && event.path === '/api/songs') {
      return await handleGetAllSongs();
    }

    if (event.httpMethod === 'GET' && event.pathParameters?.id) {
      return await handleGetSongById(event.pathParameters.id);
    }

    if (event.httpMethod === 'POST' && event.path === '/api/songs') {
      return await handleCreateSong(JSON.parse(event.body));
    }

    if (event.httpMethod === 'PUT' && event.pathParameters?.id) {
      return await handleUpdateSong(event.pathParameters.id, JSON.parse(event.body));
    }

    if (event.httpMethod === 'DELETE' && event.pathParameters?.id) {
      return await handleDeleteSong(event.pathParameters.id);
    }

    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Route not found' })
    };

  } catch (error) {
    console.error('❌ Songs Lambda: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

async function handleGetAllSongs() {
  console.log('🎶 Songs Lambda: Scanning all songs from DynamoDB...');

  const params = {
    TableName: 'bndy-songs',
    ProjectionExpression: 'id, title, artistName, duration, genre, releaseDate, album, spotifyUrl, appleMusicUrl, youtubeUrl, audioFileUrl, isFeatured, tags, createdAt'
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

    console.log(`🎶 Songs Lambda: Served ${formattedSongs.length} songs`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify(formattedSongs)
    };
  } catch (error) {
    console.error('❌ DynamoDB scan failed:', error);
    throw error;
  }
}

async function handleGetSongById(songId) {
  console.log(`🎶 Songs Lambda: Getting song by ID: ${songId}`);

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
    console.error('❌ DynamoDB get failed:', error);
    throw error;
  }
}

async function handleCreateSong(songData) {
  console.log('🎶 Songs Lambda: Creating new song');

  const now = new Date().toISOString();
  const song = {
    id: require('crypto').randomUUID(),
    title: songData.title,
    artistName: songData.artistName || '',
    duration: songData.duration || null,
    genre: songData.genre || '',
    releaseDate: songData.releaseDate || null,
    album: songData.album || null,
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
    console.error('❌ DynamoDB put failed:', error);
    throw error;
  }
}

async function handleUpdateSong(songId, songData) {
  console.log(`🎶 Songs Lambda: Updating song: ${songId}`);

  const now = new Date().toISOString();

  const params = {
    TableName: 'bndy-songs',
    Key: { id: songId },
    UpdateExpression: 'SET title = :title, artistName = :artistName, duration = :duration, genre = :genre, releaseDate = :releaseDate, album = :album, spotifyUrl = :spotifyUrl, appleMusicUrl = :appleMusicUrl, youtubeUrl = :youtubeUrl, audioFileUrl = :audioFileUrl, isFeatured = :isFeatured, tags = :tags, updatedAt = :updatedAt',
    ExpressionAttributeValues: {
      ':title': songData.title,
      ':artistName': songData.artistName || '',
      ':duration': songData.duration || null,
      ':genre': songData.genre || '',
      ':releaseDate': songData.releaseDate || null,
      ':album': songData.album || null,
      ':spotifyUrl': songData.spotifyUrl || '',
      ':appleMusicUrl': songData.appleMusicUrl || '',
      ':youtubeUrl': songData.youtubeUrl || '',
      ':audioFileUrl': songData.audioFileUrl || '',
      ':isFeatured': songData.isFeatured || false,
      ':tags': songData.tags || [],
      ':updatedAt': now
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

async function handleDeleteSong(songId) {
  console.log(`🎶 Songs Lambda: Deleting song: ${songId}`);

  const params = {
    TableName: 'bndy-songs',
    Key: { id: songId }
  };

  try {
    await dynamodb.delete(params).promise();
    return {
      statusCode: 204,
      headers: getCorsHeaders(),
      body: ''
    };
  } catch (error) {
    console.error('❌ DynamoDB delete failed:', error);
    throw error;
  }
}

function getCorsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Credentials': 'true'
  };
}