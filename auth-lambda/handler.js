// BNDY Auth Lambda Function - Production Implementation
// Cognito OAuth + DynamoDB Integration

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// AWS Services
const dynamodb = new AWS.DynamoDB.DocumentClient();
const cognito = new AWS.CognitoIdentityServiceProvider({ region: 'eu-west-2' });

// Configuration
const COGNITO_DOMAIN = 'https://eu-west-2lqtkKHs1P.auth.eu-west-2.amazoncognito.com';
const CLIENT_ID = process.env.COGNITO_USER_POOL_CLIENT_ID;
const CLIENT_SECRET = process.env.COGNITO_USER_POOL_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;

const FRONTEND_URL = 'https://backstage.bndy.co.uk';
const API_URL = 'https://api.bndy.co.uk';
const REDIRECT_URI = `${API_URL}/auth/callback`;

// DynamoDB Tables
const USERS_TABLE = 'bndy-users';
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';
const ARTISTS_TABLE = 'bndy-artists';

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

  console.log('[AUTH] Checking authentication', {
    hasCookie: !!(event.cookies || event.headers?.Cookie),
    hasSessionToken: !!sessionToken,
    eventCookies: event.cookies?.length || 0
  });

  if (!sessionToken) {
    console.log('[AUTH] AUTH: No session token found');
    return { error: 'Not authenticated' };
  }

  try {
    const session = jwt.verify(sessionToken, JWT_SECRET);
    console.log('[AUTH] AUTH: User authenticated via session', {
      userId: session.userId.substring(0, 8) + '...'
    });
    return { user: session };
  } catch (error) {
    console.error('[AUTH] AUTH: Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

// Route handlers
const handleGoogleAuth = (event) => {
  const state = generateState();

  // Store state with expiry
  stateStore.set(state, {
    timestamp: Date.now(),
    origin: event.headers?.referer || FRONTEND_URL
  });

  cleanupExpiredStates();

  const authUrl = `${COGNITO_DOMAIN}/oauth2/authorize?` +
    `response_type=code&` +
    `client_id=${CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `scope=email+openid+profile+phone&` +
    `state=${state}&` +
    `identity_provider=Google`;

  console.log('[AUTH] AUTH: Initiating Google OAuth flow', {
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

  console.log('[AUTH] AUTH CALLBACK: Received callback', {
    hasCode: !!code,
    hasState: !!state,
    error,
    fullEvent: JSON.stringify(event, null, 2)
  });

  try {
    // Verify state to prevent CSRF
    if (!state || !stateStore.has(state)) {
      console.error('[AUTH] AUTH CALLBACK: Invalid or expired state');
      return {
        statusCode: 302,
        headers: { Location: `${FRONTEND_URL}/login?error=invalid_state` },
        body: ''
      };
    }

    stateStore.delete(state);

    if (error) {
      console.error('[AUTH] AUTH CALLBACK: OAuth error:', error);
      return {
        statusCode: 302,
        headers: { Location: `${FRONTEND_URL}/login?error=${encodeURIComponent(error)}` },
        body: ''
      };
    }

    if (!code) {
      console.error('[AUTH] AUTH CALLBACK: No authorization code received');
      return {
        statusCode: 302,
        headers: { Location: `${FRONTEND_URL}/login?error=no_code` },
        body: ''
      };
    }

    // Exchange code for tokens
    console.log('[AUTH] AUTH CALLBACK: Exchanging code for tokens');

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

    console.log('[AUTH] AUTH CALLBACK: Token exchange successful');

    // Decode ID token to get user info
    const decodedIdToken = jwt.decode(id_token);
    const userId = decodedIdToken.sub;
    const email = decodedIdToken.email;
    const username = decodedIdToken['cognito:username'];
    const picture = decodedIdToken.picture; // Google profile picture URL
    const name = decodedIdToken.name; // Full name from Google
    const givenName = decodedIdToken.given_name; // First name
    const familyName = decodedIdToken.family_name; // Last name

    console.log('[AUTH] AUTH CALLBACK: User authenticated', {
      userId: userId.substring(0, 8) + '...',
      email: email ? email.substring(0, 3) + '***' : 'N/A',
      username,
      hasPicture: !!picture,
      hasName: !!name,
      hasGivenName: !!givenName,
      hasFamilyName: !!familyName
    });

    // Create or update user in DynamoDB
    await createOrUpdateUser({
      cognitoId: userId,
      email,
      username,
      profilePicture: picture,
      fullName: name,
      firstName: givenName,
      lastName: familyName
    });

    // Create lightweight session (store large tokens separately if needed)
    const sessionData = {
      userId,
      username,
      email,
      issuedAt: Date.now()
    };

    const sessionToken = jwt.sign(sessionData, JWT_SECRET, {
      expiresIn: '7d'
    });

    // Create secure cookie for cross-site usage with small token
    const cookieOptions = 'bndy_session=' + sessionToken + '; ' +
      'HttpOnly; Secure; SameSite=None; ' +
      'Max-Age=604800; Path=/; ' +
      'Domain=.bndy.co.uk'

    console.log('[AUTH] AUTH CALLBACK: Session created, setting cookie and redirecting');
    console.log('[AUTH] AUTH CALLBACK: Cookie being set:', cookieOptions);

    // Return 200 with HTML redirect instead of 302
    // This ensures Set-Cookie header is preserved by API Gateway HTTP API v2
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html',
        'Set-Cookie': cookieOptions,
        ...corsHeaders
      },
      body: `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="refresh" content="0; url=${FRONTEND_URL}/dashboard">
  <script>window.location.href='${FRONTEND_URL}/dashboard';</script>
</head>
<body>
  <p>Authentication successful. Redirecting...</p>
</body>
</html>`
    };

  } catch (error) {
    console.error('[AUTH] AUTH CALLBACK: Token exchange failed:', error.message);
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
    console.log('[AUTH] API: /api/me called by authenticated user');

    // Get user from DynamoDB
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: user.userId }
    }).promise();

    if (!userResult.Item) {
      console.error('[AUTH] API: User not found in DynamoDB');
      return createResponse(404, { error: 'User not found' });
    }

    const dbUser = userResult.Item;
    console.log('[AUTH] API: User found in DynamoDB');

    // Get user's artist memberships
    let artistMemberships = [];
    try {
      const membershipsResult = await dynamodb.query({
        TableName: MEMBERSHIPS_TABLE,
        IndexName: 'user_id-index',
        KeyConditionExpression: 'user_id = :userId',
        ExpressionAttributeValues: {
          ':userId': user.userId
        }
      }).promise();

      console.log('[AUTH] API: Found', membershipsResult.Items.length, 'memberships');

      // Batch get artist details for all memberships
      if (membershipsResult.Items.length > 0) {
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

        // Combine memberships with artist data and resolve profile inheritance
        artistMemberships = membershipsResult.Items.map(membership => {
          const artist = artists.find(a => a.id === membership.artist_id);

          // Resolve profile with inheritance from user
          const resolvedDisplayName = membership.display_name || dbUser.display_name || dbUser.username;
          const resolvedAvatarUrl = membership.avatar_url || dbUser.avatar_url || dbUser.oauth_profile_picture;
          const resolvedInstrument = membership.instrument || dbUser.instrument || null;

          return {
            // Membership info
            id: membership.membership_id,
            membershipId: membership.membership_id,
            userId: membership.user_id,
            artistId: membership.artist_id,
            role: membership.role,
            membershipType: membership.membership_type,
            status: membership.status,

            // Resolved profile (with inheritance)
            displayName: resolvedDisplayName,
            avatarUrl: resolvedAvatarUrl,
            instrument: resolvedInstrument,

            // Customization flags
            hasCustomDisplayName: membership.display_name !== null && membership.display_name !== undefined,
            hasCustomAvatar: membership.avatar_url !== null && membership.avatar_url !== undefined,
            hasCustomInstrument: membership.instrument !== null && membership.instrument !== undefined,

            // UI fields
            icon: membership.icon,
            color: membership.color,

            // Permissions
            permissions: membership.permissions || [],

            // Artist details (for frontend compatibility with "bands" array)
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
            } : null,

            // Timestamps
            joinedAt: membership.joined_at,
            createdAt: membership.created_at
          };
        });
      }
    } catch (membershipError) {
      console.error('[AUTH] API: Error fetching memberships:', membershipError);
      // Don't fail the whole request - just return empty array
    }

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
        hometown: dbUser.hometown || null,
        profileCompleted: dbUser.profile_complete || false,
        createdAt: dbUser.created_at
      },
      artists: artistMemberships, // New field with full membership data
      bands: artistMemberships, // Backwards compatibility - same data
      session: {
        issuedAt: user.issuedAt,
        expiresAt: user.exp * 1000
      }
    };

    return createResponse(200, responseData);

  } catch (error) {
    console.error('[AUTH] API: /api/me error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

const handleLogout = (event) => {
  console.log('[AUTH] AUTH: User logging out');

  const clearCookie = 'bndy_session=; HttpOnly; Secure; SameSite=None; Max-Age=0; Path=/; Domain=.bndy.co.uk';

  // HTTP API v2 format - uses headers for Set-Cookie
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
  const { cognitoId, email, username, profilePicture, fullName, firstName, lastName } = userData;

  try {
    // Check if user exists
    const existingUser = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: cognitoId }
    }).promise();

    if (existingUser.Item) {
      console.log('[AUTH] DB: User exists, updating');

      // Build update expression - only update OAuth fields if user hasn't set their own
      let updateExpression = 'SET email = :email, username = :username, updated_at = :updatedAt';
      let expressionAttributeValues = {
        ':email': email,
        ':username': username,
        ':updatedAt': new Date().toISOString()
      };

      // If user doesn't have a custom avatar but OAuth provides one, use it
      if (profilePicture && (!existingUser.Item.avatar_url || existingUser.Item.avatar_url === existingUser.Item.oauth_profile_picture)) {
        updateExpression += ', oauth_profile_picture = :oauthPicture';
        expressionAttributeValues[':oauthPicture'] = profilePicture;

        // If no custom avatar is set, use OAuth picture as avatar
        if (!existingUser.Item.avatar_url) {
          updateExpression += ', avatar_url = :avatarUrl';
          expressionAttributeValues[':avatarUrl'] = profilePicture;
        }
      }

      // If user doesn't have names set but OAuth provides them, use them
      if (firstName && !existingUser.Item.first_name) {
        updateExpression += ', first_name = :firstName';
        expressionAttributeValues[':firstName'] = firstName;
      }
      if (lastName && !existingUser.Item.last_name) {
        updateExpression += ', last_name = :lastName';
        expressionAttributeValues[':lastName'] = lastName;
      }

      // Update existing user
      await dynamodb.update({
        TableName: USERS_TABLE,
        Key: { cognito_id: cognitoId },
        UpdateExpression: updateExpression,
        ExpressionAttributeValues: expressionAttributeValues
      }).promise();
    } else {
      console.log('[AUTH] DB: Creating new user');

      // Generate new user ID
      const userId = crypto.randomUUID();

      // Create new user with OAuth data as defaults
      await dynamodb.put({
        TableName: USERS_TABLE,
        Item: {
          cognito_id: cognitoId,
          user_id: userId,
          email,
          username,
          first_name: firstName || null,
          last_name: lastName || null,
          display_name: null,
          avatar_url: profilePicture || null,
          oauth_profile_picture: profilePicture || null,
          instrument: null,
          profile_complete: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }).promise();
    }
  } catch (error) {
    console.error('[AUTH] DB: Error creating/updating user:', error);
    throw error;
  }
};

// Main handler
exports.handler = async (event, context) => {
  // HTTP API v2 payload format compatibility
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;
  const routeKey = `${method} ${path}`;
  const requestId = context.awsRequestId;
  const functionVersion = context.functionVersion;

  // Enhanced telemetry logging
  console.log('[AUTH] Auth Lambda: Request received', {
    requestId,
    functionVersion,
    routeKey,
    method,
    path,
    version: event.version || 'v2.0',
    timestamp: new Date().toISOString(),
    userAgent: event.headers?.['user-agent'] || 'unknown',
    sourceIp: event.requestContext?.http?.sourceIp || 'unknown'
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
    if (routeKey === 'GET /auth/google') {
      return handleGoogleAuth(event);
    }

    if (routeKey === 'GET /auth/callback') {
      return await handleOAuthCallback(event);
    }

    if (routeKey === 'GET /api/me') {
      return await handleGetMe(event);
    }

    if (routeKey === 'POST /auth/logout') {
      return handleLogout(event);
    }

    if (routeKey === 'GET /auth/landing') {
      // Simple landing page - kept for backward compatibility
      // Just redirects to dashboard now that cookies work
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'text/html',
          ...corsHeaders
        },
        body: `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="refresh" content="0; url=${FRONTEND_URL}/dashboard">
  <script>window.location.href='${FRONTEND_URL}/dashboard';</script>
</head>
<body>
  <p>Redirecting to dashboard...</p>
</body>
</html>`
      };
    }

    // Route not found - Enhanced error logging
    console.error('[ERROR] Auth Lambda: Route not found', {
      requestId,
      routeKey,
      path,
      method,
      availableRoutes: ['GET /auth/google', 'GET /auth/callback', 'GET /api/me', 'POST /auth/logout', 'GET /auth/landing'],
      timestamp: new Date().toISOString()
    });

    return createResponse(404, {
      error: 'Route not found',
      routeKey,
      path,
      method,
      requestId
    });

  } catch (error) {
    console.error('[AUTH] Auth Lambda: Unexpected error:', error);
    return createResponse(500, {
      error: 'Internal server error',
      message: error.message
    });
  }
};