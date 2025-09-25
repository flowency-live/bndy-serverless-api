// BNDY Artists Lambda Function - DynamoDB Version
// Handles: /api/artists, /api/artists/:id

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

exports.handler = async (event, context) => {
  console.log('🎵 Artists Lambda: Request received', {
    httpMethod: event.httpMethod,
    path: event.path,
    pathParameters: event.pathParameters
  });
  console.log('🚀 DynamoDB version - FAST AS FUCK');

  context.callbackWaitsForEmptyEventLoop = false;

  try {
    // Route requests
    if (event.httpMethod === 'GET' && event.path === '/api/artists') {
      return await handleGetAllArtists();
    }

    if (event.httpMethod === 'GET' && event.pathParameters?.id) {
      return await handleGetArtistById(event.pathParameters.id);
    }

    if (event.httpMethod === 'POST' && event.path === '/api/artists') {
      return await handleCreateArtist(JSON.parse(event.body));
    }

    if (event.httpMethod === 'PUT' && event.pathParameters?.id) {
      return await handleUpdateArtist(event.pathParameters.id, JSON.parse(event.body));
    }

    if (event.httpMethod === 'DELETE' && event.pathParameters?.id) {
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

async function handleCreateArtist(artistData) {
  console.log('🎵 Artists Lambda: Creating new artist');

  const now = new Date().toISOString();
  const artist = {
    id: require('crypto').randomUUID(),
    name: artistData.name,
    bio: artistData.bio || '',
    location: artistData.location || '',
    genres: artistData.genres || [],
    facebookUrl: artistData.facebookUrl || '',
    instagramUrl: artistData.instagramUrl || '',
    websiteUrl: artistData.websiteUrl || '',
    socialMediaUrls: artistData.socialMediaUrls || [],
    profileImageUrl: artistData.profileImageUrl || '',
    isVerified: artistData.isVerified || false,
    followerCount: artistData.followerCount || 0,
    claimedByUserId: artistData.claimedByUserId || null,
    created_at: now,
    updated_at: now
  };

  const params = {
    TableName: 'bndy-artists',
    Item: artist
  };

  try {
    await dynamodb.put(params).promise();
    return {
      statusCode: 201,
      headers: getCorsHeaders(),
      body: JSON.stringify(artist)
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

async function handleDeleteArtist(artistId) {
  console.log(`🎵 Artists Lambda: Deleting artist: ${artistId}`);

  const params = {
    TableName: 'bndy-artists',
    Key: { id: artistId }
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