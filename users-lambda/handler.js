// BNDY Users Lambda Function - User Profile Management
// Handles profile completion, updates, and user management
// Uses Lambda Authorizer for authentication - receives pre-validated user context

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');

// AWS Services
const dynamodb = new AWS.DynamoDB.DocumentClient();
const ssm = new AWS.SSM({ region: 'eu-west-2' });

// Configuration
const USERS_TABLE = 'bndy-users';
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';

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
    console.log('[USERS] JWT_SECRET loaded from SSM');
    return JWT_SECRET;
  } catch (error) {
    console.error('[USERS] Failed to get JWT_SECRET from SSM:', error.message);
    // Fallback to environment variable
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      console.log('[USERS] JWT_SECRET loaded from environment variable (fallback)');
      return JWT_SECRET;
    }
    throw new Error('JWT_SECRET not available from SSM or environment');
  }
}

// Allowed CORS origins for frontend access
const ALLOWED_ORIGINS = [
  'https://www.bndy.co.uk',       // Primary domain
  'https://backstage.bndy.co.uk', // Legacy domain
  'https://bndy.co.uk',            // Apex domain
  'https://live.bndy.co.uk',      // Frontstage
  'https://gigmap.bndy.co.uk',    // GigMap
  'https://map.bndy.co.uk',       // bndy-app canonical domain
  'http://localhost:3000'          // Local development
];

// Module-level variable to store current request event for CORS
let currentEvent = null;

// Get appropriate origin for CORS based on request origin
const getAllowedOrigin = () => {
  const requestOrigin = currentEvent?.headers?.origin || currentEvent?.headers?.Origin;
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
};

// Generate CORS headers with dynamic origin
const getCorsHeaders = () => ({
  'Access-Control-Allow-Origin': getAllowedOrigin(),
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Credentials': 'true'
});

// Create response
const createResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    ...getCorsHeaders()
  },
  body: JSON.stringify(body)
});

// Parse cookies from event
const parseCookies = (cookieHeader) => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, value] = cookie.trim().split('=');
    cookies[name] = value;
    return cookies;
  }, {});
};

// Authentication validation
const requireAuth = async (event) => {
  // HTTP API v2 passes cookies in event.cookies array
  let sessionToken = null;

  if (event.cookies && Array.isArray(event.cookies)) {
    // HTTP API v2 format
    const cookieString = event.cookies.find(c => c.startsWith('bndy_session='));
    if (cookieString) {
      sessionToken = cookieString.split('=')[1];
    }
  } else {
    // Fallback to headers for compatibility
    const cookies = parseCookies(event.headers?.Cookie || event.headers?.cookie || '');
    sessionToken = cookies.bndy_session;
  }

  console.log('USERS: Checking authentication', {
    hasCookie: !!(event.cookies || event.headers?.Cookie),
    hasSessionToken: !!sessionToken,
    eventCookies: event.cookies?.length || 0
  });

  if (!sessionToken) {
    console.log('USERS: No session token found');
    return { error: 'Not authenticated' };
  }

  try {
    const jwtSecret = await getJWTSecret();
    const session = jwt.verify(sessionToken, jwtSecret);
    console.log('USERS: User authenticated via session', {
      userId: session.userId.substring(0, 8) + '...'
    });
    return { user: session };
  } catch (error) {
    console.error('USERS: Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

// Platform admin authorization - required for godmode endpoints
const requirePlatformAdmin = async (event) => {
  const authResult = await requireAuth(event);
  if (authResult.error) {
    return { error: authResult.error, statusCode: 401 };
  }

  // Look up user in database to check platformAdmin flag
  try {
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: authResult.user.userId }
    }).promise();

    if (!userResult.Item) {
      console.error('USERS: User not found in database for admin check');
      return { error: 'User not found', statusCode: 404 };
    }

    if (!userResult.Item.platformAdmin) {
      console.log('USERS: Access denied - not platform admin', {
        userId: authResult.user.userId.substring(0, 8) + '...'
      });
      return { error: 'Platform admin access required', statusCode: 403 };
    }

    console.log('USERS: Platform admin verified', {
      userId: authResult.user.userId.substring(0, 8) + '...'
    });
    return { user: authResult.user, dbUser: userResult.Item };
  } catch (error) {
    console.error('USERS: Error checking admin status:', error.message);
    return { error: 'Internal server error', statusCode: 500 };
  }
};

// Get user profile
const handleGetProfile = async (event) => {
  const authResult = await requireAuth(event);

  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const { user } = authResult;

  try {
    console.log(' USERS: Get profile request');

    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: user.userId }
    }).promise();

    if (!userResult.Item) {
      console.error(' USERS: User not found in DynamoDB');
      return createResponse(404, { error: 'User not found' });
    }

    const dbUser = userResult.Item;
    console.log(' USERS: User profile retrieved');

    const profileData = {
      id: dbUser.user_id,
      cognitoId: dbUser.cognito_id,
      email: dbUser.email,
      username: dbUser.username,
      firstName: dbUser.first_name,
      lastName: dbUser.last_name,
      displayName: dbUser.display_name,
      hometown: dbUser.hometown,
      avatarUrl: dbUser.avatar_url,
      instrument: dbUser.instrument,
      profileCompleted: dbUser.profile_complete,
      platformAdmin: dbUser.platformAdmin || false,
      createdAt: dbUser.created_at,
      updatedAt: dbUser.updated_at
    };

    return createResponse(200, { user: profileData });

  } catch (error) {
    console.error(' USERS: Get profile error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Update user profile
const handleUpdateProfile = async (event) => {
  const authResult = await requireAuth(event);

  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const { user } = authResult;

  try {
    const requestBody = JSON.parse(event.body);
    const { firstName, lastName, displayName, avatarUrl, instrument, hometown } = requestBody;

    console.log(' USERS: Update profile request', {
      hasFirstName: !!firstName,
      hasLastName: !!lastName,
      hasDisplayName: !!displayName
    });

    // Validate required fields for profile completion
    const profileComplete = !!(firstName && lastName && displayName);

    // Get current user to verify exists
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: user.userId }
    }).promise();

    if (!userResult.Item) {
      console.error(' USERS: User not found for profile update');
      return createResponse(404, { error: 'User not found' });
    }

    // Update user profile
    const updateResult = await dynamodb.update({
      TableName: USERS_TABLE,
      Key: { cognito_id: user.userId },
      UpdateExpression: 'SET first_name = :firstName, last_name = :lastName, display_name = :displayName, avatar_url = :avatarUrl, instrument = :instrument, hometown = :hometown, profile_complete = :profileComplete, updated_at = :updatedAt',
      ExpressionAttributeValues: {
        ':firstName': firstName || null,
        ':lastName': lastName || null,
        ':displayName': displayName || null,
        ':avatarUrl': avatarUrl || null,
        ':instrument': instrument || null,
        ':hometown': hometown || null,
        ':profileComplete': profileComplete,
        ':updatedAt': new Date().toISOString()
      },
      ReturnValues: 'ALL_NEW'
    }).promise();

    const updatedUser = updateResult.Attributes;

    console.log(' USERS: Profile updated successfully', {
      profileComplete,
      displayName: updatedUser.display_name
    });

    const responseData = {
      id: updatedUser.user_id,
      cognitoId: updatedUser.cognito_id,
      email: updatedUser.email,
      username: updatedUser.username,
      firstName: updatedUser.first_name,
      lastName: updatedUser.last_name,
      displayName: updatedUser.display_name,
      hometown: updatedUser.hometown,
      avatarUrl: updatedUser.avatar_url,
      instrument: updatedUser.instrument,
      profileCompleted: updatedUser.profile_complete,
      createdAt: updatedUser.created_at,
      updatedAt: updatedUser.updated_at
    };

    return createResponse(200, {
      user: responseData,
      message: profileComplete ? 'Profile completed successfully!' : 'Profile updated successfully!'
    });

  } catch (error) {
    console.error(' USERS: Update profile error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// ========== FAVOURITES (backlog feature 3) ==========
// Model A (Jason ruling 2026-08-11): string sets on the bndy-users record.
// favourite_artist_ids / favourite_venue_ids. No separate table.

const FAVOURITE_ATTRS = {
  artist: 'favourite_artist_ids',
  venue: 'favourite_venue_ids'
};

const setToArray = (attr) => {
  if (!attr) return [];
  if (Array.isArray(attr.values)) return attr.values; // DocumentClient set
  if (Array.isArray(attr)) return attr;               // plain list fallback
  return [];
};

// GET /users/favourites
const handleGetFavourites = async (event) => {
  const authResult = await requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  try {
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: authResult.user.userId }
    }).promise();

    if (!userResult.Item) {
      return createResponse(404, { error: 'User not found' });
    }

    return createResponse(200, {
      artistIds: setToArray(userResult.Item.favourite_artist_ids),
      venueIds: setToArray(userResult.Item.favourite_venue_ids)
    });
  } catch (error) {
    console.error('USERS: Get favourites error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// POST /users/favourites/toggle  body: { type: 'artist'|'venue', id, favourite: boolean }
// Idempotent: ADD when favourite=true, DELETE when favourite=false. No read needed.
const handleToggleFavourite = async (event) => {
  const authResult = await requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return createResponse(400, { error: 'Invalid JSON body' });
  }

  const { type, id, favourite } = body;
  const attrName = FAVOURITE_ATTRS[type];

  if (!attrName) {
    return createResponse(400, { error: "type must be 'artist' or 'venue'" });
  }
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
    return createResponse(400, { error: 'id must be a non-empty string' });
  }
  if (typeof favourite !== 'boolean') {
    return createResponse(400, { error: 'favourite must be a boolean' });
  }

  try {
    const op = favourite ? 'ADD' : 'DELETE';
    await dynamodb.update({
      TableName: USERS_TABLE,
      Key: { cognito_id: authResult.user.userId },
      UpdateExpression: `${op} ${attrName} :ids`,
      ExpressionAttributeValues: {
        ':ids': dynamodb.createSet([id])
      }
    }).promise();

    console.log('USERS: Favourite toggled', { type, favourite });
    return createResponse(200, { success: true, type, id, favourite });
  } catch (error) {
    console.error('USERS: Toggle favourite error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Determine auth type from cognito_id and username
const getAuthType = (cognitoId, username) => {
  if (cognitoId.startsWith('phone_')) {
    return 'Phone';
  }
  if (username.startsWith('google_')) {
    return 'Google';
  }
  if (username.startsWith('facebook_')) {
    return 'Facebook';
  }
  // Default to email-based auth
  return 'Email';
};

// List all users (admin function - godmode)
const handleListUsers = async (event) => {
  // SEC-AUD-002: Require platformAdmin for godmode endpoints
  const authResult = await requirePlatformAdmin(event);

  if (authResult.statusCode) {
    return createResponse(authResult.statusCode, { error: authResult.error });
  }

  try {
    console.log(' USERS: List users request (godmode)');

    // Fetch all users
    const usersResult = await dynamodb.scan({
      TableName: USERS_TABLE,
      ProjectionExpression: 'user_id, cognito_id, email, phone, username, first_name, last_name, display_name, profile_complete, user_source, created_at'
    }).promise();

    // Fetch all memberships to count per user
    const membershipsResult = await dynamodb.scan({
      TableName: MEMBERSHIPS_TABLE,
      ProjectionExpression: 'user_id, membership_id'
    }).promise();

    // Create membership count map using cognito_id (memberships.user_id = users.cognito_id)
    const membershipCounts = {};
    membershipsResult.Items.forEach(membership => {
      const cognitoId = membership.user_id; // membership.user_id contains cognito_id
      membershipCounts[cognitoId] = (membershipCounts[cognitoId] || 0) + 1;
    });

    // Build user list with membership counts and auth type
    const users = usersResult.Items.map(user => ({
      id: user.user_id,
      cognitoId: user.cognito_id, // Added for matching with memberships
      email: user.email || null,
      phone: user.phone || null,
      username: user.username,
      firstName: user.first_name || null,
      lastName: user.last_name || null,
      displayName: user.display_name || null,
      profileCompleted: user.profile_complete || false,
      membershipCount: membershipCounts[user.cognito_id] || 0,
      authType: getAuthType(user.cognito_id, user.username),
      userSource: user.user_source || null,
      createdAt: user.created_at
    }));

    console.log(` USERS: Retrieved ${users.length} users with membership counts`);

    return createResponse(200, { users, count: users.length });

  } catch (error) {
    console.error(' USERS: List users error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Delete user (admin function - godmode)
const handleDeleteUser = async (event) => {
  // SEC-AUD-002: Require platformAdmin for godmode endpoints
  const authResult = await requirePlatformAdmin(event);

  if (authResult.statusCode) {
    return createResponse(authResult.statusCode, { error: authResult.error });
  }

  try {
    // Extract user_id from path parameters
    const userId = event.pathParameters?.userId;

    if (!userId) {
      return createResponse(400, { error: 'User ID is required' });
    }

    console.log(` USERS: Delete user request (godmode)`, { userId: userId.substring(0, 8) + '...' });

    // Get user to find cognito_id
    const userResult = await dynamodb.scan({
      TableName: USERS_TABLE,
      FilterExpression: 'user_id = :userId',
      ExpressionAttributeValues: {
        ':userId': userId
      }
    }).promise();

    if (!userResult.Items || userResult.Items.length === 0) {
      console.error(` USERS: User not found for deletion: ${userId}`);
      return createResponse(404, { error: 'User not found' });
    }

    const user = userResult.Items[0];
    const cognitoId = user.cognito_id;

    console.log(` USERS: Found user to delete`, { cognitoId: cognitoId.substring(0, 8) + '...' });

    // Get all memberships for this user (using cognito_id)
    const membershipsResult = await dynamodb.scan({
      TableName: MEMBERSHIPS_TABLE,
      FilterExpression: 'user_id = :cognitoId',
      ExpressionAttributeValues: {
        ':cognitoId': cognitoId
      }
    }).promise();

    console.log(` USERS: Found ${membershipsResult.Items?.length || 0} memberships to delete`);

    // Delete all memberships
    if (membershipsResult.Items && membershipsResult.Items.length > 0) {
      const deletePromises = membershipsResult.Items.map(membership =>
        dynamodb.delete({
          TableName: MEMBERSHIPS_TABLE,
          Key: { membership_id: membership.membership_id }
        }).promise()
      );
      await Promise.all(deletePromises);
      console.log(` USERS: Deleted ${membershipsResult.Items.length} memberships`);
    }

    // Delete the user
    await dynamodb.delete({
      TableName: USERS_TABLE,
      Key: { cognito_id: cognitoId }
    }).promise();

    console.log(` USERS: User deleted successfully`, { userId });

    return createResponse(200, {
      message: 'User deleted successfully',
      deletedMemberships: membershipsResult.Items?.length || 0
    });

  } catch (error) {
    console.error(' USERS: Delete user error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Main handler
exports.handler = async (event, context) => {
  // Store event for CORS headers
  currentEvent = event;

  // HTTP API v2 payload format compatibility
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;
  const routeKey = `${method} ${path}`;

  console.log(' Users Lambda: Request received', {
    routeKey,
    method,
    path,
    version: event.version || 'v2.0'
  });

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: ''
    };
  }

  try {
    // Route requests (HTTP API v2 format)
    if (routeKey === 'GET /users/profile') {
      return await handleGetProfile(event);
    }

    if (routeKey === 'GET /users/favourites') {
      return await handleGetFavourites(event);
    }

    if (routeKey === 'POST /users/favourites/toggle') {
      return await handleToggleFavourite(event);
    }

    if (routeKey === 'PUT /users/profile') {
      return await handleUpdateProfile(event);
    }

    if (routeKey === 'GET /users') {
      return await handleListUsers(event);
    }

    if (routeKey.startsWith('DELETE /users/')) {
      return await handleDeleteUser(event);
    }

    // Route not found
    return createResponse(404, {
      error: 'Route not found',
      routeKey,
      path,
      method
    });

  } catch (error) {
    console.error(' Users Lambda: Unexpected error:', error);
    return createResponse(500, {
      error: 'Internal server error',
      message: error.message
    });
  }
};