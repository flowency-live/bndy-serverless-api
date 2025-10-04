// BNDY Memberships Lambda Function - Artist Membership Management
// Handles: /api/artists/{id}/members, /api/memberships/{id}

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// AWS Services
const dynamodb = new AWS.DynamoDB.DocumentClient();

// Configuration
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';
const ARTISTS_TABLE = 'bndy-artists';
const USERS_TABLE = 'bndy-users';
const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = 'https://backstage.bndy.co.uk';

const corsHeaders = {
  'Access-Control-Allow-Origin': FRONTEND_URL,
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Credentials': 'true'
};

// Parse cookies from event
const parseCookies = (cookieHeader) => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, value] = cookie.trim().split('=');
    cookies[name] = value;
    return cookies;
  }, {});
};

// Create response
const createResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    ...corsHeaders
  },
  body: JSON.stringify(body)
});

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

  console.log('[MEMBERSHIPS] Checking authentication', {
    hasCookie: !!(event.cookies || event.headers?.Cookie),
    hasSessionToken: !!sessionToken
  });

  if (!sessionToken) {
    console.log('[MEMBERSHIPS] No session token found');
    return { error: 'Not authenticated' };
  }

  try {
    const session = jwt.verify(sessionToken, JWT_SECRET);
    console.log('[MEMBERSHIPS] User authenticated via session', {
      userId: session.userId.substring(0, 8) + '...'
    });
    return { user: session };
  } catch (error) {
    console.error('[MEMBERSHIPS] Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

// Helper: Resolve membership profile with inheritance from user
const resolveMembershipProfile = async (membership, userId) => {
  // Get user profile for inheritance
  const userResult = await dynamodb.get({
    TableName: USERS_TABLE,
    Key: { cognito_id: userId }
  }).promise();

  const userProfile = userResult.Item || {};

  return {
    ...membership,

    // Resolved profile fields (with inheritance)
    resolved_display_name: membership.display_name || userProfile.display_name || userProfile.username,
    resolved_avatar_url: membership.avatar_url || userProfile.avatar_url || userProfile.oauth_profile_picture,
    resolved_instrument: membership.instrument || userProfile.instrument || null,

    // Customization flags
    has_custom_display_name: membership.display_name !== null && membership.display_name !== undefined,
    has_custom_avatar: membership.avatar_url !== null && membership.avatar_url !== undefined,
    has_custom_instrument: membership.instrument !== null && membership.instrument !== undefined
  };
};

// Get all members for an artist
const handleGetArtistMembers = async (event, artistId) => {
  const authResult = requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  try {
    console.log(`[MEMBERSHIPS] Getting members for artist: ${artistId}`);

    // Query memberships by artist_id
    const result = await dynamodb.query({
      TableName: MEMBERSHIPS_TABLE,
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      ExpressionAttributeValues: {
        ':artistId': artistId
      }
    }).promise();

    // Resolve profiles with inheritance
    const memberships = await Promise.all(
      result.Items.map(membership => resolveMembershipProfile(membership, membership.user_id))
    );

    console.log(`[MEMBERSHIPS] Retrieved ${memberships.length} members`);

    return createResponse(200, {
      members: memberships,
      count: memberships.length
    });

  } catch (error) {
    console.error('[MEMBERSHIPS] Get artist members error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Add member to artist (create membership)
const handleAddMember = async (event, artistId) => {
  const authResult = requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const { user } = authResult;

  try {
    const requestBody = JSON.parse(event.body);
    const {
      userId,
      role = 'member',
      membershipType = 'performer',
      displayName = null,
      avatarUrl = null,
      instrument = null,
      icon = 'fa-music',
      color = '#708090',
      permissions = []
    } = requestBody;

    console.log('[MEMBERSHIPS] Adding member to artist', {
      artistId,
      userId,
      role,
      invitedBy: user.userId
    });

    // Verify artist exists
    const artistResult = await dynamodb.get({
      TableName: ARTISTS_TABLE,
      Key: { id: artistId }
    }).promise();

    if (!artistResult.Item) {
      return createResponse(404, { error: 'Artist not found' });
    }

    // Check if membership already exists
    const existingResult = await dynamodb.query({
      TableName: MEMBERSHIPS_TABLE,
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      FilterExpression: 'user_id = :userId',
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':userId': userId
      }
    }).promise();

    if (existingResult.Items.length > 0) {
      return createResponse(400, { error: 'User is already a member of this artist' });
    }

    // Create membership
    const membershipId = crypto.randomUUID();
    const now = new Date().toISOString();

    const membership = {
      membership_id: membershipId,
      user_id: userId,
      artist_id: artistId,
      membership_type: membershipType,
      role: role,

      // Context-specific profile (nullable = inherit from user)
      display_name: displayName,
      avatar_url: avatarUrl,
      instrument: instrument,
      bio: null,

      // UI fields
      icon: icon,
      color: color,

      // Permissions
      permissions: permissions,

      // Metadata
      joined_at: now,
      invited_at: now,
      invited_by_user_id: user.userId,
      status: 'active',

      created_at: now,
      updated_at: now
    };

    await dynamodb.put({
      TableName: MEMBERSHIPS_TABLE,
      Item: membership
    }).promise();

    // Update artist member_count
    await dynamodb.update({
      TableName: ARTISTS_TABLE,
      Key: { id: artistId },
      UpdateExpression: 'ADD member_count :inc',
      ExpressionAttributeValues: {
        ':inc': 1
      }
    }).promise();

    // Resolve profile with inheritance
    const resolvedMembership = await resolveMembershipProfile(membership, userId);

    console.log('[MEMBERSHIPS] Member added successfully');

    return createResponse(201, {
      membership: resolvedMembership,
      message: 'Member added successfully'
    });

  } catch (error) {
    console.error('[MEMBERSHIPS] Add member error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Update membership
const handleUpdateMembership = async (event, membershipId) => {
  const authResult = requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const { user } = authResult;

  try {
    const requestBody = JSON.parse(event.body);
    const {
      role,
      displayName,
      avatarUrl,
      instrument,
      bio,
      icon,
      color,
      permissions,
      status
    } = requestBody;

    console.log('[MEMBERSHIPS] Updating membership', {
      membershipId,
      hasDisplayName: displayName !== undefined,
      hasRole: role !== undefined
    });

    // Get existing membership
    const existingResult = await dynamodb.get({
      TableName: MEMBERSHIPS_TABLE,
      Key: { membership_id: membershipId }
    }).promise();

    if (!existingResult.Item) {
      return createResponse(404, { error: 'Membership not found' });
    }

    // Build update expression
    const updateParts = [];
    const expressionAttributeValues = {};
    const expressionAttributeNames = {};

    if (role !== undefined) {
      updateParts.push('#role = :role');
      expressionAttributeNames['#role'] = 'role';
      expressionAttributeValues[':role'] = role;
    }

    if (displayName !== undefined) {
      updateParts.push('display_name = :displayName');
      expressionAttributeValues[':displayName'] = displayName;
    }

    if (avatarUrl !== undefined) {
      updateParts.push('avatar_url = :avatarUrl');
      expressionAttributeValues[':avatarUrl'] = avatarUrl;
    }

    if (instrument !== undefined) {
      updateParts.push('instrument = :instrument');
      expressionAttributeValues[':instrument'] = instrument;
    }

    if (bio !== undefined) {
      updateParts.push('bio = :bio');
      expressionAttributeValues[':bio'] = bio;
    }

    if (icon !== undefined) {
      updateParts.push('icon = :icon');
      expressionAttributeValues[':icon'] = icon;
    }

    if (color !== undefined) {
      updateParts.push('#color = :color');
      expressionAttributeNames['#color'] = 'color';
      expressionAttributeValues[':color'] = color;
    }

    if (permissions !== undefined) {
      updateParts.push('permissions = :permissions');
      expressionAttributeValues[':permissions'] = permissions;
    }

    if (status !== undefined) {
      updateParts.push('#status = :status');
      expressionAttributeNames['#status'] = 'status';
      expressionAttributeValues[':status'] = status;
    }

    // Always update timestamp
    updateParts.push('updated_at = :updatedAt');
    expressionAttributeValues[':updatedAt'] = new Date().toISOString();

    const updateExpression = 'SET ' + updateParts.join(', ');

    // Update membership
    const updateParams = {
      TableName: MEMBERSHIPS_TABLE,
      Key: { membership_id: membershipId },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    };

    if (Object.keys(expressionAttributeNames).length > 0) {
      updateParams.ExpressionAttributeNames = expressionAttributeNames;
    }

    const result = await dynamodb.update(updateParams).promise();

    // Resolve profile with inheritance
    const resolvedMembership = await resolveMembershipProfile(
      result.Attributes,
      result.Attributes.user_id
    );

    console.log('[MEMBERSHIPS] Membership updated successfully');

    return createResponse(200, {
      membership: resolvedMembership,
      message: 'Membership updated successfully'
    });

  } catch (error) {
    console.error('[MEMBERSHIPS] Update membership error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Delete membership (remove member from artist)
const handleDeleteMembership = async (event, membershipId) => {
  const authResult = requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  try {
    console.log('[MEMBERSHIPS] Deleting membership', { membershipId });

    // Get membership to get artist_id for member_count update
    const membershipResult = await dynamodb.get({
      TableName: MEMBERSHIPS_TABLE,
      Key: { membership_id: membershipId }
    }).promise();

    if (!membershipResult.Item) {
      return createResponse(404, { error: 'Membership not found' });
    }

    const artistId = membershipResult.Item.artist_id;

    // Delete membership
    await dynamodb.delete({
      TableName: MEMBERSHIPS_TABLE,
      Key: { membership_id: membershipId }
    }).promise();

    // Update artist member_count
    await dynamodb.update({
      TableName: ARTISTS_TABLE,
      Key: { id: artistId },
      UpdateExpression: 'ADD member_count :dec',
      ExpressionAttributeValues: {
        ':dec': -1
      }
    }).promise();

    console.log('[MEMBERSHIPS] Membership deleted successfully');

    return createResponse(200, { message: 'Membership deleted successfully' });

  } catch (error) {
    console.error('[MEMBERSHIPS] Delete membership error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Get current user's memberships with resolved profiles
const handleGetMyMemberships = async (event) => {
  const authResult = requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const { user } = authResult;

  try {
    console.log('[MEMBERSHIPS] Getting memberships for user', { userId: user.userId });

    // Query memberships by user_id
    const membershipsResult = await dynamodb.query({
      TableName: MEMBERSHIPS_TABLE,
      IndexName: 'user_id-index',
      KeyConditionExpression: 'user_id = :userId',
      ExpressionAttributeValues: {
        ':userId': user.userId
      }
    }).promise();

    console.log('[MEMBERSHIPS] Found', membershipsResult.Items.length, 'memberships');

    if (membershipsResult.Items.length === 0) {
      return createResponse(200, { user: { id: user.userId }, artists: [] });
    }

    // Batch get artist details
    const artistIds = membershipsResult.Items.map(m => m.artist_id);
    const artistKeys = artistIds.map(id => ({ id }));

    const artistsResult = await dynamodb.batchGet({
      RequestItems: {
        [ARTISTS_TABLE]: {
          Keys: artistKeys
        }
      }
    }).promise();

    const artists = artistsResult.Responses[ARTISTS_TABLE] || [];

    // Resolve profile inheritance for each membership
    const resolvedMemberships = await Promise.all(
      membershipsResult.Items.map(async (membership) => {
        const resolvedMembership = await resolveMembershipProfile(membership, user.userId);
        const artist = artists.find(a => a.id === membership.artist_id);

        return {
          ...resolvedMembership,
          // Add full artist details
          name: artist?.name || 'Unknown Artist',
          artist: artist ? {
            id: artist.id,
            name: artist.name,
            artistType: artist.artist_type || 'band',
            bio: artist.bio,
            location: artist.location,
            genres: artist.genres || [],
            profileImageUrl: artist.profileImageUrl,
            isVerified: artist.isVerified || false,
            memberCount: artist.member_count || 0,
            createdAt: artist.created_at
          } : null
        };
      })
    );

    return createResponse(200, {
      user: { id: user.userId },
      artists: resolvedMemberships
    });

  } catch (error) {
    console.error('[MEMBERSHIPS] Get my memberships error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Main handler
exports.handler = async (event, context) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;
  const routeKey = `${method} ${path}`;

  console.log('[MEMBERSHIPS] Memberships Lambda: Request received', {
    routeKey,
    method,
    path,
    pathParameters: event.pathParameters
  });

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ''
    };
  }

  try {
    // Extract IDs from path parameters
    const artistId = event.pathParameters?.artistId || event.pathParameters?.id;
    const membershipId = event.pathParameters?.membershipId;

    // Route requests
    if (method === 'GET' && path === '/api/memberships/me') {
      return await handleGetMyMemberships(event);
    }

    if (method === 'GET' && path.includes('/artists/') && path.includes('/members')) {
      return await handleGetArtistMembers(event, artistId);
    }

    if (method === 'POST' && path.includes('/artists/') && path.includes('/members')) {
      return await handleAddMember(event, artistId);
    }

    if (method === 'PUT' && membershipId) {
      return await handleUpdateMembership(event, membershipId);
    }

    if (method === 'DELETE' && membershipId) {
      return await handleDeleteMembership(event, membershipId);
    }

    // Route not found
    return createResponse(404, {
      error: 'Route not found',
      routeKey,
      path,
      method
    });

  } catch (error) {
    console.error('[MEMBERSHIPS] Memberships Lambda: Unexpected error:', error);
    return createResponse(500, {
      error: 'Internal server error',
      message: error.message
    });
  }
};
