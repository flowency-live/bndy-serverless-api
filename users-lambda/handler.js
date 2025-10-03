// BNDY Users Lambda Function - User Profile Management
// Handles profile completion, updates, and user management
// Uses Lambda Authorizer for authentication - receives pre-validated user context

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');

// AWS Services
const dynamodb = new AWS.DynamoDB.DocumentClient();

// Configuration
const USERS_TABLE = 'bndy-users';
const FRONTEND_URL = 'https://backstage.bndy.co.uk';
const JWT_SECRET = process.env.JWT_SECRET;

const corsHeaders = {
  'Access-Control-Allow-Origin': FRONTEND_URL,
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Credentials': 'true'
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
const requireAuth = (event) => {
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
    const session = jwt.verify(sessionToken, JWT_SECRET);
    console.log('USERS: User authenticated via session', {
      userId: session.userId.substring(0, 8) + '...'
    });
    return { user: session };
  } catch (error) {
    console.error('USERS: Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

// Get user profile
const handleGetProfile = async (event) => {
  const authResult = requireAuth(event);

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
      avatarUrl: dbUser.avatar_url,
      instrument: dbUser.instrument,
      profileCompleted: dbUser.profile_complete,
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
  const authResult = requireAuth(event);

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

// List all users (admin function - future god mode)
const handleListUsers = async (event) => {
  const authResult = requireAuth(event);

  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  try {
    console.log(' USERS: List users request');

    const result = await dynamodb.scan({
      TableName: USERS_TABLE,
      ProjectionExpression: 'user_id, cognito_id, email, username, display_name, profile_complete, created_at'
    }).promise();

    const users = result.Items.map(user => ({
      id: user.user_id,
      cognitoId: user.cognito_id,
      email: user.email,
      username: user.username,
      displayName: user.display_name,
      profileCompleted: user.profile_complete,
      createdAt: user.created_at
    }));

    console.log(` USERS: Retrieved ${users.length} users`);

    return createResponse(200, { users, count: users.length });

  } catch (error) {
    console.error(' USERS: List users error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Main handler
exports.handler = async (event, context) => {
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
      headers: corsHeaders,
      body: ''
    };
  }

  try {
    // Route requests (HTTP API v2 format)
    if (routeKey === 'GET /users/profile') {
      return await handleGetProfile(event);
    }

    if (routeKey === 'PUT /users/profile') {
      return await handleUpdateProfile(event);
    }

    if (routeKey === 'GET /users') {
      return await handleListUsers(event);
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