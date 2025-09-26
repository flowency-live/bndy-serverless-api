// BNDY Auth Lambda Function - Production Implementation
// Cognito OAuth + DynamoDB Integration

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// AWS Services
const dynamodb = new AWS.DynamoDB.DocumentClient();
const cognito = new AWS.CognitoIdentityServiceProvider({ region: 'eu-west-2' });

// Configuration
const COGNITO_DOMAIN = 'https://eu-west-2lqtkkhs1p.auth.eu-west-2.amazoncognito.com';
const CLIENT_ID = process.env.COGNITO_USER_POOL_CLIENT_ID;
const CLIENT_SECRET = process.env.COGNITO_USER_POOL_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;

const FRONTEND_URL = 'https://backstage.bndy.co.uk';
const REDIRECT_URI = `${FRONTEND_URL}/auth/callback`;

// DynamoDB Tables
const USERS_TABLE = 'bndy-users';

// State storage for OAuth (in production, use DynamoDB with TTL)
const stateStore = new Map();

// Utility functions
const generateState = () => crypto.randomBytes(32).toString('hex');

const cleanupExpiredStates = () => {
  for (const [key, value] of stateStore.entries()) {
    if (Date.now() - value.timestamp > 300000) { // 5 minutes
      stateStore.delete(key);
    }
  }
};

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

// Create response with cookies
const createResponse = (statusCode, body, cookies = null) => {
  const response = {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    },
    body: JSON.stringify(body)
  };

  if (cookies) {
    response.headers['Set-Cookie'] = cookies;
  }

  return response;
};

// Authentication middleware
const requireAuth = (event) => {
  const cookies = parseCookies(event.headers.Cookie || event.headers.cookie);
  const sessionToken = cookies.bndy_session;

  console.log('🔐 AUTH: Checking authentication', {
    hasCookie: !!event.headers.Cookie,
    hasSessionToken: !!sessionToken
  });

  if (!sessionToken) {
    console.log('🔐 AUTH: No session token found');
    return { error: 'Not authenticated' };
  }

  try {
    const session = jwt.verify(sessionToken, JWT_SECRET);
    console.log('🔐 AUTH: User authenticated via session', {
      userId: session.userId.substring(0, 8) + '...'
    });
    return { user: session };
  } catch (error) {
    console.error('🔐 AUTH: Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

// Route handlers
const handleGoogleAuth = (event) => {
  const state = generateState();

  // Store state with expiry
  stateStore.set(state, {
    timestamp: Date.now(),
    origin: event.headers.referer || FRONTEND_URL
  });

  cleanupExpiredStates();

  const authUrl = `${COGNITO_DOMAIN}/oauth2/authorize?` +
    `response_type=code&` +
    `client_id=${CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `scope=email+openid+profile+phone&` +
    `state=${state}&` +
    `identity_provider=Google`;

  console.log('🔐 AUTH: Initiating Google OAuth flow', {
    state: state.substring(0, 8) + '...',
    redirectUri: REDIRECT_URI
  });

  return {
    statusCode: 302,
    headers: {
      Location: authUrl,
      ...corsHeaders
    },
    body: ''
  };
};

const handleOAuthCallback = async (event) => {
  const { code, state, error } = event.queryStringParameters || {};

  console.log('🔐 AUTH CALLBACK: Received callback', {
    hasCode: !!code,
    hasState: !!state,
    error,
    fullEvent: JSON.stringify(event, null, 2)
  });

  try {
    // Verify state to prevent CSRF
    if (!state || !stateStore.has(state)) {
      console.error('🔐 AUTH CALLBACK: Invalid or expired state');
      return {
        statusCode: 302,
        headers: { Location: `${FRONTEND_URL}/login?error=invalid_state` },
        body: ''
      };
    }

    stateStore.delete(state);

    if (error) {
      console.error('🔐 AUTH CALLBACK: OAuth error:', error);
      return {
        statusCode: 302,
        headers: { Location: `${FRONTEND_URL}/login?error=${encodeURIComponent(error)}` },
        body: ''
      };
    }

    if (!code) {
      console.error('🔐 AUTH CALLBACK: No authorization code received');
      return {
        statusCode: 302,
        headers: { Location: `${FRONTEND_URL}/login?error=no_code` },
        body: ''
      };
    }

    // Exchange code for tokens
    console.log('🔐 AUTH CALLBACK: Exchanging code for tokens');

    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code,
      redirect_uri: REDIRECT_URI,
    });

    const tokenResponse = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams
    });

    const tokenData = await tokenResponse.json();
    const { access_token, id_token, refresh_token } = tokenData;

    console.log('🔐 AUTH CALLBACK: Token exchange successful');

    // Decode ID token to get user info
    const decodedIdToken = jwt.decode(id_token);
    const userId = decodedIdToken.sub;
    const email = decodedIdToken.email;
    const username = decodedIdToken['cognito:username'];

    console.log('🔐 AUTH CALLBACK: User authenticated', {
      userId: userId.substring(0, 8) + '...',
      email: email ? email.substring(0, 3) + '***' : 'N/A',
      username
    });

    // Create or update user in DynamoDB
    await createOrUpdateUser({
      cognitoId: userId,
      email,
      username
    });

    // Create secure session
    const sessionData = {
      userId,
      username,
      email,
      accessToken: access_token,
      idToken: id_token,
      refreshToken: refresh_token,
      issuedAt: Date.now()
    };

    const sessionToken = jwt.sign(sessionData, JWT_SECRET, {
      expiresIn: '7d'
    });

    // Create secure cookie
    const cookieOptions = 'bndy_session=' + sessionToken + '; ' +
      'HttpOnly; Secure; SameSite=None; ' +
      'Max-Age=604800; Path=/; ' +
      'Domain=.bndy.co.uk';

    console.log('🔐 AUTH CALLBACK: Session created, redirecting to success page');

    return {
      statusCode: 302,
      headers: {
        Location: `${FRONTEND_URL}/auth-success`,
        'Set-Cookie': cookieOptions
      },
      body: ''
    };

  } catch (error) {
    console.error('🔐 AUTH CALLBACK: Token exchange failed:', error.message);
    return {
      statusCode: 302,
      headers: { Location: `${FRONTEND_URL}/login?error=token_exchange_failed` },
      body: ''
    };
  }
};

const handleGetMe = async (event) => {
  const authResult = requireAuth(event);

  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const { user } = authResult;

  try {
    console.log('🔐 API: /api/me called by authenticated user');

    // Get user from DynamoDB
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: user.userId }
    }).promise();

    if (!userResult.Item) {
      console.error('🔐 API: User not found in DynamoDB');
      return createResponse(404, { error: 'User not found' });
    }

    const dbUser = userResult.Item;
    console.log('🔐 API: User found in DynamoDB');

    const responseData = {
      user: {
        id: dbUser.user_id,
        cognitoId: dbUser.cognito_id,
        username: dbUser.username || user.username,
        email: dbUser.email || user.email,
        firstName: dbUser.first_name || null,
        lastName: dbUser.last_name || null,
        displayName: dbUser.display_name || null,
        avatarUrl: dbUser.avatar_url || null,
        instrument: dbUser.instrument || null,
        profileCompleted: dbUser.profile_complete || false,
        createdAt: dbUser.created_at
      },
      bands: [], // Empty array for now - TODO: Implement artist memberships
      session: {
        issuedAt: user.issuedAt,
        expiresAt: user.exp * 1000
      }
    };

    return createResponse(200, responseData);

  } catch (error) {
    console.error('🔐 API: /api/me error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

const handleLogout = (event) => {
  console.log('🔐 AUTH: User logging out');

  const clearCookie = 'bndy_session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/; Domain=.bndy.co.uk';

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearCookie,
      ...corsHeaders
    },
    body: JSON.stringify({ success: true })
  };
};

// Helper function to create or update user in DynamoDB
const createOrUpdateUser = async (userData) => {
  const { cognitoId, email, username } = userData;

  try {
    // Check if user exists
    const existingUser = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: cognitoId }
    }).promise();

    if (existingUser.Item) {
      console.log('🔐 DB: User exists, updating');

      // Update existing user
      await dynamodb.update({
        TableName: USERS_TABLE,
        Key: { cognito_id: cognitoId },
        UpdateExpression: 'SET email = :email, username = :username, updated_at = :updatedAt',
        ExpressionAttributeValues: {
          ':email': email,
          ':username': username,
          ':updatedAt': new Date().toISOString()
        }
      }).promise();
    } else {
      console.log('🔐 DB: Creating new user');

      // Generate new user ID
      const userId = crypto.randomUUID();

      // Create new user with profile incomplete
      await dynamodb.put({
        TableName: USERS_TABLE,
        Item: {
          cognito_id: cognitoId,
          user_id: userId,
          email,
          username,
          first_name: null,
          last_name: null,
          display_name: null,
          avatar_url: null,
          instrument: null,
          profile_complete: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }).promise();
    }
  } catch (error) {
    console.error('🔐 DB: Error creating/updating user:', error);
    throw error;
  }
};

// Main handler
exports.handler = async (event, context) => {
  console.log('🔐 Auth Lambda: Request received', {
    httpMethod: event.httpMethod,
    path: event.path,
    resource: event.resource
  });

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ''
    };
  }

  try {
    // Route requests
    if (event.resource === '/auth/google' && event.httpMethod === 'GET') {
      return handleGoogleAuth(event);
    }

    if (event.resource === '/auth/callback' && event.httpMethod === 'GET') {
      return await handleOAuthCallback(event);
    }

    if (event.resource === '/api/me' && event.httpMethod === 'GET') {
      return await handleGetMe(event);
    }

    if (event.resource === '/auth/logout' && event.httpMethod === 'POST') {
      return handleLogout(event);
    }

    // Route not found
    return createResponse(404, {
      error: 'Route not found',
      path: event.path,
      method: event.httpMethod
    });

  } catch (error) {
    console.error('🔐 Auth Lambda: Unexpected error:', error);
    return createResponse(500, {
      error: 'Internal server error',
      message: error.message
    });
  }
};