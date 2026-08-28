// BNDY Auth Lambda Function - Production Implementation
// Cognito OAuth + DynamoDB Integration

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// AWS Services
const dynamodb = new AWS.DynamoDB.DocumentClient();
const cognito = new AWS.CognitoIdentityServiceProvider({ region: 'eu-west-2' });
const SES = new AWS.SES({ region: 'eu-west-2' });

// Configuration
const COGNITO_DOMAIN = 'https://eu-west-2lqtkkhs1p.auth.eu-west-2.amazoncognito.com';
const CLIENT_ID = process.env.COGNITO_USER_POOL_CLIENT_ID;
const CLIENT_SECRET = process.env.COGNITO_USER_POOL_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET;

// Allowed CORS origins for frontend access
const ALLOWED_ORIGINS = [
  'https://www.bndy.co.uk',       // Primary domain
  'https://backstage.bndy.co.uk', // Legacy domain
  'https://bndy.co.uk',            // Apex domain
  'https://live.bndy.co.uk',      // Frontstage
  'https://gigmap.bndy.co.uk',    // GigMap
  'https://map.bndy.co.uk',       // Map (canonical)
  'https://gigs.bndy.co.uk',      // Gigs
  'https://bndy.live',             // New public maps domain
  'https://stage.bndy.live',       // New backstage domain
  'http://localhost:3000'          // Local development
];

// Validate a client-supplied returnTo URL. Accept it only when its origin is
// in ALLOWED_ORIGINS. Returns the full URL string, or null when invalid.
const validateReturnTo = (returnTo) => {
  if (!returnTo || typeof returnTo !== 'string') return null;
  try {
    const url = new URL(returnTo);
    if (!ALLOWED_ORIGINS.includes(url.origin)) return null;
    return url.origin + url.pathname + url.search;
  } catch (e) {
    return null;
  }
};

const API_URL = 'https://api.bndy.co.uk';
const REDIRECT_URI = `${API_URL}/auth/callback`;

const getOAuthCallbackUri = (origin) => {
  if (origin === 'https://bndy.live') {
    return 'https://bndy.live/auth/callback';
  }
  if (origin === 'https://stage.bndy.live') {
    return 'https://stage.bndy.live/auth/callback';
  }
  return REDIRECT_URI;
};

const buildSessionCookie = (sessionToken, origin, maxAge = 7776000) => {
  const validatedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const domainAttribute = validatedOrigin === 'https://bndy.live' ||
    validatedOrigin === 'https://stage.bndy.live'
    ? '; Domain=.bndy.live'
    : '; Domain=.bndy.co.uk';

  return `bndy_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; ` +
    `Max-Age=${maxAge}; Path=/${domainAttribute}`;
};

// Module-level variable to store current request event for CORS
let currentEvent = null;

// Get appropriate origin for CORS based on request origin
const getAllowedOrigin = () => {
  const requestOrigin = currentEvent?.headers?.origin || currentEvent?.headers?.Origin;
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
};

const getValidatedRequestOrigin = (event) => {
  const requestOrigin = event?.headers?.origin || event?.headers?.Origin;
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
};

// Get frontend URL for redirects (checks referer, then origin, then defaults to primary)
const getFrontendUrl = () => {
  // Check referer first (OAuth callbacks have referer from the originating page)
  const referer = currentEvent?.headers?.referer || currentEvent?.headers?.Referer;
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      const refererOrigin = refererUrl.origin;
      if (ALLOWED_ORIGINS.includes(refererOrigin)) {
        return refererOrigin;
      }
    } catch (e) {
      // Invalid referer URL, continue
    }
  }

  // Fall back to origin header
  const requestOrigin = currentEvent?.headers?.origin || currentEvent?.headers?.Origin;
  if (ALLOWED_ORIGINS.includes(requestOrigin)) {
    return requestOrigin;
  }

  // Default to primary domain
  return ALLOWED_ORIGINS[0];
};

// DynamoDB Tables
const USERS_TABLE = 'bndy-users';
const OTP_TABLE = 'bndy-otp-codes';
const MAGIC_TOKEN_TABLE = 'bndy-magic-tokens';
const OAUTH_STATE_TABLE = 'bndy-oauth-states';

// Utility functions
const generateState = () => crypto.randomBytes(32).toString('hex');

// OAuth state management with DynamoDB
const storeOAuthState = async (state, origin, returnTo = null, callbackUri = REDIRECT_URI) => {
  const ttl = Math.floor(Date.now() / 1000) + 300; // 5 minutes from now

  await dynamodb.put({
    TableName: OAUTH_STATE_TABLE,
    Item: {
      state,
      origin,
      return_to: returnTo,
      callback_uri: callbackUri,
      created_at: new Date().toISOString(),
      ttl
    }
  }).promise();

  console.log('AUTH: OAuth state stored in DynamoDB', {
    state: state.substring(0, 8) + '...',
    ttl
  });
};

const verifyOAuthState = async (state) => {
  try {
    const result = await dynamodb.get({
      TableName: OAUTH_STATE_TABLE,
      Key: { state }
    }).promise();

    if (!result.Item) {
      console.log('AUTH: OAuth state not found in DynamoDB');
      return false;
    }

    // Delete state after verification (one-time use)
    await dynamodb.delete({
      TableName: OAUTH_STATE_TABLE,
      Key: { state }
    }).promise();

    console.log('AUTH: OAuth state verified and deleted');
    // Truthy result carries the stored item so the callback can honour return_to.
    return result.Item;
  } catch (error) {
    console.error('AUTH: Error verifying OAuth state:', error);
    return false;
  }
};

// CORS is now handled by API Gateway CorsConfiguration in template.yaml
const getCorsHeaders = () => ({
  'Content-Type': 'application/json'
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

// Create response with cookies
const createResponse = (statusCode, body, cookies = null) => {
  const response = {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders()
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
  // HTTP API v2 sends cookies in event.cookies array, REST API v1 in headers
  let cookieHeader = event.headers?.Cookie || event.headers?.cookie;

  if (!cookieHeader && event.cookies && event.cookies.length > 0) {
    // HTTP API v2 format - join cookies array
    cookieHeader = event.cookies.join('; ');
  }

  const cookies = parseCookies(cookieHeader);
  const sessionToken = cookies.bndy_session;

  console.log('AUTH: Checking authentication', {
    hasCookieHeader: !!cookieHeader,
    hasCookiesArray: !!(event.cookies && event.cookies.length > 0),
    hasSessionToken: !!sessionToken
  });

  if (!sessionToken) {
    console.log('AUTH: No session token found');
    return { error: 'Not authenticated' };
  }

  try {
    const session = jwt.verify(sessionToken, JWT_SECRET);
    console.log('AUTH: User authenticated via session', {
      userId: session.userId.substring(0, 8) + '...'
    });
    return { user: session };
  } catch (error) {
    console.error('AUTH: Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

// Route handlers
const handleGoogleAuth = async (event) => {
  const state = generateState();
  const origin = getFrontendUrl();
  const returnTo = validateReturnTo(event.queryStringParameters?.returnTo);
  const loginOrigin = returnTo ? new URL(returnTo).origin : origin;
  const callbackUri = getOAuthCallbackUri(loginOrigin);

  // Store state in DynamoDB
  await storeOAuthState(state, loginOrigin, returnTo, callbackUri);

  const authUrl = `${COGNITO_DOMAIN}/oauth2/authorize?` +
    `response_type=code&` +
    `client_id=${CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(callbackUri)}&` +
    `scope=email+openid+profile+phone&` +
    `state=${state}&` +
    `identity_provider=Google`;

  console.log('AUTH: Initiating Google OAuth flow', {
    state: state.substring(0, 8) + '...',
    redirectUri: callbackUri
  });

  return {
    statusCode: 302,
    headers: {
      Location: authUrl,
      ...getCorsHeaders()
    },
    body: ''
  };
};

const handleFacebookAuth = async (event) => {
  const state = generateState();
  const origin = getFrontendUrl();
  const returnTo = validateReturnTo(event.queryStringParameters?.returnTo);
  const loginOrigin = returnTo ? new URL(returnTo).origin : origin;
  const callbackUri = getOAuthCallbackUri(loginOrigin);

  await storeOAuthState(state, loginOrigin, returnTo, callbackUri);

  const authUrl = COGNITO_DOMAIN + '/oauth2/authorize?' +
    'response_type=code&' +
    'client_id=' + CLIENT_ID + '&' +
    'redirect_uri=' + encodeURIComponent(callbackUri) + '&' +
    'scope=email+openid+profile&' +
    'state=' + state + '&' +
    'identity_provider=Facebook';

  console.log('AUTH: Initiating Facebook OAuth flow', {
    state: state.substring(0, 8) + '...',
    redirectUri: callbackUri
  });

  return {
    statusCode: 302,
    headers: {
      Location: authUrl,
      ...getCorsHeaders()
    },
    body: ''
  };
};

const handleOAuthCallback = async (event) => {
  const { code, state, error } = event.queryStringParameters || {};

  console.log('AUTH CALLBACK: Received callback', {
    hasCode: !!code,
    hasState: !!state,
    error,
    fullEvent: JSON.stringify(event, null, 2)
  });

  try {
    // Verify state to prevent CSRF
    const stateValid = await verifyOAuthState(state);
    if (!state || !stateValid) {
      console.error('AUTH CALLBACK: Invalid or expired state');
      return {
        statusCode: 302,
        headers: { Location: `${getFrontendUrl()}/login?error=invalid_state` },
        body: ''
      };
    }

    if (error) {
      console.error('AUTH CALLBACK: OAuth error:', error);
      return {
        statusCode: 302,
        headers: { Location: `${getFrontendUrl()}/login?error=${encodeURIComponent(error)}` },
        body: ''
      };
    }

    if (!code) {
      console.error('AUTH CALLBACK: No authorization code received');
      return {
        statusCode: 302,
        headers: { Location: `${getFrontendUrl()}/login?error=no_code` },
        body: ''
      };
    }

    // Exchange code for tokens
    console.log('AUTH CALLBACK: Exchanging code for tokens');

    // Use the same callback URI selected when this OAuth flow was initiated.
    // REDIRECT_URI preserves compatibility with OAuth states created before
    // callback_uri was persisted.
    const callbackUri = stateValid.callback_uri || REDIRECT_URI;

    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code,
      redirect_uri: callbackUri,
    });

    const tokenResponse = await fetch(`${COGNITO_DOMAIN}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams
    });

    const tokenData = await tokenResponse.json();
    const { access_token, id_token, refresh_token } = tokenData;

    console.log('AUTH CALLBACK: Token exchange successful');

    // Decode ID token to get user info
    const decodedIdToken = jwt.decode(id_token);
    const userId = decodedIdToken.sub;
    const email = decodedIdToken.email;
    const username = decodedIdToken['cognito:username'];

    console.log('AUTH CALLBACK: User authenticated', {
      userId: userId.substring(0, 8) + '...',
      email: email ? email.substring(0, 3) + '***' : 'N/A',
      username
    });

    // Derive user source from origin (where user registered)
    const origin = stateValid?.origin || '';
    const userSource = origin.includes('map.bndy') || origin.includes('gigmap') ? 'map'
                     : origin.includes('backstage') ? 'backstage'
                     : origin.includes('live.bndy') ? 'frontstage'
                     : 'unknown';

    // Create or update user in DynamoDB
    await createOrUpdateUser({
      cognitoId: userId,
      email,
      username,
      userSource
    });

    // Create lightweight session
    const sessionData = {
      userId,
      username,
      email,
      issuedAt: Date.now()
    };

    const sessionToken = jwt.sign(sessionData, JWT_SECRET, {
      expiresIn: '90d'
    });

    // Create secure cookie
    const cookieOptions = buildSessionCookie(sessionToken, stateValid.origin);

    console.log('AUTH CALLBACK: Session created, redirecting');

    // Prefer the return_to stored with the OAuth state (bndy-app flow).
    // Fall back to the legacy backstage destination.
    const storedReturnTo = validateReturnTo(stateValid?.return_to);
    const stateOrigin = stateValid?.origin && ALLOWED_ORIGINS.includes(stateValid.origin)
      ? stateValid.origin
      : getFrontendUrl();
    const successTarget = storedReturnTo || `${stateOrigin}/dashboard`;

    // Return 200 with HTML+JS redirect for reliable cookie setting
    // Check for pending invite in localStorage and redirect accordingly
    const redirectHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Redirecting...</title>
</head>
<body>
  <p>Authentication successful. Redirecting...</p>
  <script>
    // Check for pending invite and redirect accordingly
    const pendingInvite = localStorage.getItem('pendingInvite');
    if (pendingInvite) {
      console.log('AUTH CALLBACK: Found pending invite, redirecting to invite page');
      window.location.href = '${stateOrigin}/invite/' + pendingInvite;
    } else {
      window.location.href = '${successTarget}';
    }
  </script>
</body>
</html>`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html'
      },
      cookies: [cookieOptions],
      body: redirectHtml
    };

  } catch (error) {
    console.error('AUTH CALLBACK: Token exchange failed:', error.message);
    return {
      statusCode: 302,
      headers: { Location: `${getFrontendUrl()}/login?error=token_exchange_failed` },
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
    console.log('API: /api/me called by authenticated user');

    // Get user from DynamoDB
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: user.userId }
    }).promise();

    if (!userResult.Item) {
      console.error('API: User not found in DynamoDB');
      return createResponse(404, { error: 'User not found' });
    }

    const dbUser = userResult.Item;
    console.log('API: User found in DynamoDB');

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
        createdAt: dbUser.created_at,
        // Role ladder: user | curator | owner | staff.
        // Legacy records have no role field. platformAdmin=true reads as staff.
        role: dbUser.role || (dbUser.platformAdmin ? 'staff' : 'user')
      },
      bands: [], // Empty array for now - TODO: Implement artist memberships
      session: {
        issuedAt: user.issuedAt,
        expiresAt: user.exp * 1000
      }
    };

    return createResponse(200, responseData);

  } catch (error) {
    console.error('API: /api/me error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

const handleLogout = (event) => {
  console.log('AUTH: User logging out');

  const clearCookie = buildSessionCookie('', getValidatedRequestOrigin(event), 0);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders()
    },
    cookies: [clearCookie],
    body: JSON.stringify({ success: true })
  };
};

// ========== PHONE AUTHENTICATION HANDLERS ==========

const handlePhoneRequestOTP = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { phone } = body;

    // Validate phone format (+1234567890)
    if (!phone || !/^\+[1-9]\d{10,14}$/.test(phone)) {
      return createResponse(400, { error: 'Invalid phone number format. Must be E.164 format (+1234567890)' });
    }

    console.log('[PHONE_AUTH] OTP requested for phone:', phone.substring(0, 4) + '****');

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + (5 * 60 * 1000); // 5 minutes
    const requestId = crypto.randomUUID();

    // Store OTP in DynamoDB
    await dynamodb.put({
      TableName: OTP_TABLE,
      Item: {
        phone,
        otp,
        expiresAt,
        attempts: 0,
        createdAt: new Date().toISOString(),
        requestId
      }
    }).promise();

    // Send SMS via Pinpoint SMS (AWS End User Messaging)
    try {
      const pinpointSMS = new AWS.PinpointSMSVoiceV2({ region: 'eu-west-2' });
      await pinpointSMS.sendTextMessage({
        DestinationPhoneNumber: phone,
        MessageBody: `Your BNDY verification code is: ${otp}\n\nThis code expires in 5 minutes.`,
        OriginationIdentity: 'BNDY',
        MessageType: 'TRANSACTIONAL',
        ConfigurationSetName: 'bndy-sms-config'
      }).promise();

      console.log('[PHONE_AUTH] OTP sent via Pinpoint SMS successfully');
      return createResponse(200, {
        success: true,
        message: 'OTP sent to your phone',
        requestId,
        expiresIn: 300
      });
    } catch (smsError) {
      console.error('[PHONE_AUTH] SMS send failed:', smsError.message);

      // Return error with details for troubleshooting
      return createResponse(500, {
        success: false,
        error: 'Failed to send SMS',
        message: smsError.message,
        requestId
      });
    }

  } catch (error) {
    console.error('[PHONE_AUTH] Error requesting OTP:', error);
    return createResponse(500, { error: 'Failed to request OTP' });
  }
};

const handlePhoneVerifyOTP = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { phone, otp } = body;

    if (!phone || !otp) {
      return createResponse(400, { error: 'Phone and OTP are required' });
    }

    console.log('[PHONE_AUTH] Verifying OTP for phone:', phone.substring(0, 4) + '****');

    // Get OTP record from DynamoDB
    const otpResult = await dynamodb.get({
      TableName: OTP_TABLE,
      Key: { phone }
    }).promise();

    if (!otpResult.Item) {
      console.log('[PHONE_AUTH] No OTP found for phone');
      return createResponse(404, { error: 'No OTP request found for this phone number' });
    }

    const otpRecord = otpResult.Item;

    // Check expiry
    if (Date.now() > otpRecord.expiresAt) {
      console.log('[PHONE_AUTH] OTP expired');
      await dynamodb.delete({
        TableName: OTP_TABLE,
        Key: { phone }
      }).promise();
      return createResponse(400, { error: 'OTP has expired. Please request a new one.' });
    }

    // Check attempts (max 3)
    if (otpRecord.attempts >= 3) {
      console.log('[PHONE_AUTH] Too many attempts');
      await dynamodb.delete({
        TableName: OTP_TABLE,
        Key: { phone }
      }).promise();
      return createResponse(400, { error: 'Too many failed attempts. Please request a new OTP.' });
    }

    // Verify OTP
    if (otpRecord.otp !== otp) {
      console.log('[PHONE_AUTH] Invalid OTP');

      // Increment attempts
      await dynamodb.update({
        TableName: OTP_TABLE,
        Key: { phone },
        UpdateExpression: 'SET attempts = attempts + :inc',
        ExpressionAttributeValues: { ':inc': 1 }
      }).promise();

      return createResponse(400, {
        error: 'Invalid OTP',
        attemptsRemaining: 2 - otpRecord.attempts
      });
    }

    // OTP is valid - delete it
    await dynamodb.delete({
      TableName: OTP_TABLE,
      Key: { phone }
    }).promise();

    console.log('[PHONE_AUTH] OTP verified successfully');

    // Check if user already exists with this phone
    const usersResult = await dynamodb.query({
      TableName: USERS_TABLE,
      IndexName: 'phone-index',
      KeyConditionExpression: 'phone = :phone',
      ExpressionAttributeValues: { ':phone': phone }
    }).promise();

    if (usersResult.Items && usersResult.Items.length > 0) {
      // User exists - log them in
      const existingUser = usersResult.Items[0];

      const sessionData = {
        userId: existingUser.cognito_id,
        username: existingUser.username,
        email: existingUser.email,
        phone: existingUser.phone,
        issuedAt: Date.now()
      };

      const sessionToken = jwt.sign(sessionData, JWT_SECRET, { expiresIn: '90d' });

      const cookieOptions = buildSessionCookie(sessionToken, getValidatedRequestOrigin(event));

      console.log('[PHONE_AUTH] Existing user logged in');

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          ...getCorsHeaders()
        },
        cookies: [cookieOptions],
        body: JSON.stringify({
          success: true,
          user: {
            id: existingUser.user_id,
            phone: existingUser.phone,
            displayName: existingUser.display_name,
            profileCompleted: existingUser.profile_complete || false
          }
        })
      };
    }

    // User doesn't exist - auto-create like Google OAuth does
    console.log('[PHONE_AUTH] New user, auto-creating in bndy-users');

    const userId = crypto.randomUUID();
    const cognitoId = `phone_${userId}`;
    const username = `user_${phone.substring(phone.length - 4)}`;

    await dynamodb.put({
      TableName: USERS_TABLE,
      Item: {
        cognito_id: cognitoId,
        user_id: userId,
        phone,
        email: null,
        username,
        first_name: null,
        last_name: null,
        display_name: null,
        hometown: null,
        avatar_url: null,
        instrument: null,
        profile_complete: false,  // Just like Google OAuth
        role: 'user',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    }).promise();

    // Create session
    const sessionData = {
      userId: cognitoId,
      username,
      phone,
      issuedAt: Date.now()
    };

    const sessionToken = jwt.sign(sessionData, JWT_SECRET, { expiresIn: '90d' });

    const cookieOptions = buildSessionCookie(sessionToken, getValidatedRequestOrigin(event));

    console.log('[PHONE_AUTH] New user created and logged in');

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        ...getCorsHeaders()
      },
      cookies: [cookieOptions],
      body: JSON.stringify({
        success: true,
        user: {
          id: userId,
          phone,
          displayName: null,
          profileCompleted: false
        }
      })
    };

  } catch (error) {
    console.error('[PHONE_AUTH] Error verifying OTP:', error);
    return createResponse(500, { error: 'Failed to verify OTP' });
  }
};

const handlePhoneVerifyAndOnboard = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { phone, otp, firstName, lastName, hometown } = body;

    if (!phone || !otp || !firstName || !hometown) {
      return createResponse(400, {
        error: 'Phone, OTP, first name, and hometown are required'
      });
    }

    console.log('[PHONE_AUTH] Verify and onboard for phone:', phone.substring(0, 4) + '****');

    // Verify OTP first (same logic as handlePhoneVerifyOTP)
    const otpResult = await dynamodb.get({
      TableName: OTP_TABLE,
      Key: { phone }
    }).promise();

    if (!otpResult.Item) {
      return createResponse(404, { error: 'No OTP request found' });
    }

    const otpRecord = otpResult.Item;

    if (Date.now() > otpRecord.expiresAt) {
      await dynamodb.delete({ TableName: OTP_TABLE, Key: { phone } }).promise();
      return createResponse(400, { error: 'OTP has expired' });
    }

    if (otpRecord.attempts >= 3) {
      await dynamodb.delete({ TableName: OTP_TABLE, Key: { phone } }).promise();
      return createResponse(400, { error: 'Too many failed attempts' });
    }

    if (otpRecord.otp !== otp) {
      await dynamodb.update({
        TableName: OTP_TABLE,
        Key: { phone },
        UpdateExpression: 'SET attempts = attempts + :inc',
        ExpressionAttributeValues: { ':inc': 1 }
      }).promise();
      return createResponse(400, { error: 'Invalid OTP' });
    }

    // OTP verified - delete it
    await dynamodb.delete({
      TableName: OTP_TABLE,
      Key: { phone }
    }).promise();

    // Check if user already exists
    const usersResult = await dynamodb.query({
      TableName: USERS_TABLE,
      IndexName: 'phone-index',
      KeyConditionExpression: 'phone = :phone',
      ExpressionAttributeValues: { ':phone': phone }
    }).promise();

    if (usersResult.Items && usersResult.Items.length > 0) {
      return createResponse(400, {
        error: 'User already exists with this phone number. Please use verify-otp to login.'
      });
    }

    // Create new user
    const userId = crypto.randomUUID();
    const cognitoId = `phone_${userId}`; // Synthetic Cognito ID for phone-auth users
    const username = `user_${phone.substring(phone.length - 4)}`;
    const displayName = lastName ? `${firstName} ${lastName}` : firstName;

    // Derive user source from request origin
    const origin = event.headers?.origin || event.headers?.Origin || '';
    const userSource = origin.includes('map.bndy') || origin.includes('gigmap') ? 'map'
                     : origin.includes('backstage') ? 'backstage'
                     : origin.includes('live.bndy') ? 'frontstage'
                     : 'unknown';

    await dynamodb.put({
      TableName: USERS_TABLE,
      Item: {
        cognito_id: cognitoId,
        user_id: userId,
        phone,
        email: null,
        username,
        first_name: firstName,
        last_name: lastName || null,
        display_name: displayName,
        hometown,
        avatar_url: null,
        instrument: null,
        profile_complete: true,
        role: 'user',
        user_source: userSource,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    }).promise();

    console.log('[PHONE_AUTH] New user created:', userId.substring(0, 8) + '...');

    // Create session
    const sessionData = {
      userId: cognitoId,
      username,
      phone,
      issuedAt: Date.now()
    };

    const sessionToken = jwt.sign(sessionData, JWT_SECRET, { expiresIn: '90d' });

    const cookieOptions = buildSessionCookie(sessionToken, getValidatedRequestOrigin(event));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        ...getCorsHeaders()
      },
      cookies: [cookieOptions],
      body: JSON.stringify({
        success: true,
        user: {
          id: userId,
          phone,
          displayName,
          hometown,
          profileCompleted: true
        }
      })
    };

  } catch (error) {
    console.error('[PHONE_AUTH] Error in verify-and-onboard:', error);
    return createResponse(500, { error: 'Failed to complete onboarding' });
  }
};

// Helper function to create or update user in DynamoDB
const createOrUpdateUser = async (userData) => {
  const { cognitoId, email, username, userSource } = userData;

  try {
    // Check if user exists
    const existingUser = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: cognitoId }
    }).promise();

    if (existingUser.Item) {
      console.log('DB: User exists, updating');

      // Update existing user (don't change user_source on existing users)
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
      console.log('DB: Creating new user', { userSource });

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
          role: 'user',
          user_source: userSource || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }).promise();
    }
  } catch (error) {
    console.error('DB: Error creating/updating user:', error);
    throw error;
  }
};

// ========== EMAIL MAGIC LINK AUTHENTICATION HANDLERS ==========

// Handler: POST /auth/email/request-magic
const handleEmailRequestMagic = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { email } = body;
    // Where to send the user after the link is clicked. Origin must be allowed.
    const returnTo = validateReturnTo(body.returnTo);

    // Validate email format
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return createResponse(400, { error: 'Invalid email format' });
    }

    console.log('[EMAIL_AUTH] Magic link requested for email:', email.substring(0, 3) + '***');

    // Generate magic token (UUID)
    const token = crypto.randomUUID();
    const expiresAt = Date.now() + (5 * 60 * 1000); // 5 minutes
    const requestId = crypto.randomUUID();

    // Store token in DynamoDB
    await dynamodb.put({
      TableName: MAGIC_TOKEN_TABLE,
      Item: {
        token,
        email,
        expiresAt,
        attempts: 0,
        createdAt: new Date().toISOString(),
        requestId,
        type: 'email-magic-link',
        return_to: returnTo
      }
    }).promise();

    // Send email via SES
    const magicLink = `https://api.bndy.co.uk/auth/magic/${token}`;

    try {
      await SES.sendEmail({
        Source: 'noreply@bndy.co.uk',
        Destination: { ToAddresses: [email] },
        Message: {
          Subject: { Data: 'Sign in to bndy' },
          Body: {
            Html: {
              Data: `
                <h2>Sign in to bndy</h2>
                <p>Click the link below to sign in to your account:</p>
                <p><a href="${magicLink}" style="background: #f97316; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Sign In to bndy</a></p>
                <p>Or copy this link: ${magicLink}</p>
                <p><small>This link expires in 5 minutes. If you didn't request this, you can safely ignore this email.</small></p>
              `
            },
            Text: {
              Data: `Sign in to bndy\n\nClick here to sign in: ${magicLink}\n\nThis link expires in 5 minutes.`
            }
          }
        }
      }).promise();

      console.log('[EMAIL_AUTH] Magic link sent successfully');
      return createResponse(200, {
        success: true,
        message: 'Magic link sent to your email',
        requestId,
        expiresIn: 300
      });
    } catch (sesError) {
      console.error('[EMAIL_AUTH] SES send failed:', sesError.message);
      return createResponse(500, {
        success: false,
        error: 'Failed to send email',
        message: sesError.message,
        requestId
      });
    }

  } catch (error) {
    console.error('[EMAIL_AUTH] Error requesting magic link:', error);
    return createResponse(500, { error: 'Failed to request magic link' });
  }
};

// Handler: GET /auth/magic/{token}
const handleMagicLinkAuth = async (event) => {
  try {
    const token = event.pathParameters?.token;

    if (!token) {
      return createResponse(400, { error: 'Token required' });
    }

    console.log('[EMAIL_AUTH] Validating magic link:', token.substring(0, 8) + '...');

    // Get token from DynamoDB
    const tokenResult = await dynamodb.get({
      TableName: MAGIC_TOKEN_TABLE,
      Key: { token }
    }).promise();

    if (!tokenResult.Item) {
      console.log('[EMAIL_AUTH] Token not found');
      return {
        statusCode: 302,
        headers: { Location: `${getFrontendUrl()}/login?error=invalid_token` },
        body: ''
      };
    }

    const tokenRecord = tokenResult.Item;

    // Check expiry
    if (Date.now() > tokenRecord.expiresAt) {
      console.log('[EMAIL_AUTH] Token expired');
      await dynamodb.delete({
        TableName: MAGIC_TOKEN_TABLE,
        Key: { token }
      }).promise();
      const expiredReturnTo = validateReturnTo(tokenRecord.return_to);
      const expiredOrigin = expiredReturnTo ? new URL(expiredReturnTo).origin : getFrontendUrl();
      return {
        statusCode: 302,
        headers: { Location: `${expiredOrigin}/login?error=token_expired` },
        body: ''
      };
    }

    // Token valid - delete it (one-time use)
    await dynamodb.delete({
      TableName: MAGIC_TOKEN_TABLE,
      Key: { token }
    }).promise();

    const email = tokenRecord.email;
    console.log('[EMAIL_AUTH] Token verified for email:', email.substring(0, 3) + '***');

    // Check if user exists with this email
    const usersResult = await dynamodb.scan({
      TableName: USERS_TABLE,
      FilterExpression: 'email = :email',
      ExpressionAttributeValues: { ':email': email }
    }).promise();

    if (usersResult.Items && usersResult.Items.length > 0) {
      // Existing user - log them in
      const existingUser = usersResult.Items[0];
      const storedReturnTo = validateReturnTo(tokenRecord.return_to);
      const cookieOrigin = storedReturnTo
        ? new URL(storedReturnTo).origin
        : ALLOWED_ORIGINS[0];

      const sessionData = {
        userId: existingUser.cognito_id,
        username: existingUser.username,
        email: existingUser.email,
        issuedAt: Date.now()
      };

      const sessionToken = jwt.sign(sessionData, JWT_SECRET, { expiresIn: '90d' });

      const cookieOptions = buildSessionCookie(sessionToken, cookieOrigin);

      console.log('[EMAIL_AUTH] Existing user logged in');

      const successTarget = storedReturnTo || `${getFrontendUrl()}/dashboard`;
      const inviteOrigin = storedReturnTo ? new URL(storedReturnTo).origin : getFrontendUrl();

      const redirectHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Redirecting...</title>
</head>
<body>
  <p>Authentication successful. Redirecting...</p>
  <script>
    // Check for pending invite and redirect accordingly
    const pendingInvite = localStorage.getItem('pendingInvite');
    if (pendingInvite) {
      console.log('EMAIL AUTH: Found pending invite, redirecting to invite page');
      window.location.href = '${inviteOrigin}/invite/' + pendingInvite;
    } else {
      window.location.href = '${successTarget}';
    }
  </script>
</body>
</html>`;

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'text/html'
        },
        cookies: [cookieOptions],
        body: redirectHtml
      };
    }

    // New user - auto-create like phone auth does
    console.log('[EMAIL_AUTH] New user, auto-creating in bndy-users');

    const userId = crypto.randomUUID();
    const cognitoId = `email_${userId}`;
    const username = `user_${email.split('@')[0]}`;

    // Derive user source from return_to origin
    const returnToOrigin = tokenRecord.return_to ? new URL(tokenRecord.return_to).origin : '';
    const userSource = returnToOrigin.includes('map.bndy') || returnToOrigin.includes('gigmap') ? 'map'
                     : returnToOrigin.includes('backstage') ? 'backstage'
                     : returnToOrigin.includes('live.bndy') ? 'frontstage'
                     : 'unknown';

    await dynamodb.put({
      TableName: USERS_TABLE,
      Item: {
        cognito_id: cognitoId,
        user_id: userId,
        email,
        username,
        profile_complete: false,
        role: 'user',
        user_source: userSource,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    }).promise();

    // Create session
    const sessionData = {
      userId: cognitoId,
      username,
      email,
      issuedAt: Date.now()
    };

    const sessionToken = jwt.sign(sessionData, JWT_SECRET, { expiresIn: '90d' });

    const storedReturnTo = validateReturnTo(tokenRecord.return_to);
    const cookieOrigin = storedReturnTo
      ? new URL(storedReturnTo).origin
      : ALLOWED_ORIGINS[0];
    const cookieOptions = buildSessionCookie(sessionToken, cookieOrigin);

    console.log('[EMAIL_AUTH] New user created and logged in');

    const newUserTarget = storedReturnTo || `${getFrontendUrl()}/dashboard`;

    const redirectHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Redirecting...</title>
</head>
<body>
  <p>Welcome to bndy! Redirecting...</p>
  <script>
    window.location.href = '${newUserTarget}';
  </script>
</body>
</html>`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html'
      },
      cookies: [cookieOptions],
      body: redirectHtml
    };

  } catch (error) {
    console.error('[EMAIL_AUTH] Magic link validation error:', error);
    return {
      statusCode: 302,
      headers: { Location: `${getFrontendUrl()}/login?error=authentication_failed` },
      body: ''
    };
  }
};

// Handler: POST /auth/check-identity (for dynamic welcome message)
const handleCheckIdentity = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const { phone, email } = body;

    if (!phone && !email) {
      return createResponse(400, { error: 'Phone or email required' });
    }

    console.log('[AUTH] Checking identity existence');

    if (phone) {
      const result = await dynamodb.query({
        TableName: USERS_TABLE,
        IndexName: 'phone-index',
        KeyConditionExpression: 'phone = :phone',
        ExpressionAttributeValues: { ':phone': phone }
      }).promise();

      if (result.Items && result.Items.length > 0) {
        const user = result.Items[0];
        return createResponse(200, {
          exists: true,
          displayName: user.display_name || user.first_name,
          method: 'phone'
        });
      }
    }

    if (email) {
      const result = await dynamodb.scan({
        TableName: USERS_TABLE,
        FilterExpression: 'email = :email',
        ExpressionAttributeValues: { ':email': email }
      }).promise();

      if (result.Items && result.Items.length > 0) {
        const user = result.Items[0];
        return createResponse(200, {
          exists: true,
          displayName: user.display_name || user.first_name,
          method: 'email'
        });
      }
    }

    // Not found
    return createResponse(200, {
      exists: false,
      method: phone ? 'phone' : 'email'
    });

  } catch (error) {
    console.error('[AUTH] Check identity error:', error);
    return createResponse(500, { error: 'Failed to check identity' });
  }
};

// Handler: GET /auth/apple
const handleAppleAuth = async (event) => {
  const state = generateState();
  const origin = getFrontendUrl();
  const returnTo = validateReturnTo(event.queryStringParameters?.returnTo);

  // Store state in DynamoDB
  await storeOAuthState(state, origin, returnTo);

  const authUrl = `${COGNITO_DOMAIN}/oauth2/authorize?` +
    `response_type=code&` +
    `client_id=${CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `scope=email+openid+profile+phone&` +
    `state=${state}&` +
    `identity_provider=SignInWithApple`;

  console.log('AUTH: Initiating Apple OAuth flow', {
    state: state.substring(0, 8) + '...',
    redirectUri: REDIRECT_URI
  });

  return {
    statusCode: 302,
    headers: {
      Location: authUrl,
      ...getCorsHeaders()
    },
    body: ''
  };
};

// Main handler
exports.handler = async (event, context) => {
  // Support both HTTP API v2 and REST API v1 event formats
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;
  const routeKey = `${method} ${path}`;

  console.log('Auth Lambda: Request received', {
    method,
    path,
    routeKey,
    eventVersion: event.version || 'v1'
  });

  // Store event for CORS headers
  currentEvent = event;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: ''
    };
  }

  try {
    // Route requests using routeKey
    if (routeKey === 'GET /auth/google') {
      return await handleGoogleAuth(event);
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

    // Phone authentication routes
    if (routeKey === 'POST /auth/phone/request-otp') {
      return await handlePhoneRequestOTP(event);
    }

    if (routeKey === 'POST /auth/phone/verify-otp') {
      return await handlePhoneVerifyOTP(event);
    }

    if (routeKey === 'POST /auth/phone/verify-and-onboard') {
      return await handlePhoneVerifyAndOnboard(event);
    }

    // Email magic link routes
    if (routeKey === 'POST /auth/email/request-magic') {
      return await handleEmailRequestMagic(event);
    }

    if (routeKey.startsWith('GET /auth/magic/') || (method === 'GET' && path.includes('/auth/magic/'))) {
      return await handleMagicLinkAuth(event);
    }

    // Check identity route (for dynamic welcome message)
    if (routeKey === 'POST /auth/check-identity') {
      return await handleCheckIdentity(event);
    }

    // Facebook OAuth route via Cognito. Meta remains an identity provider; BNDY owns the session and Join/Claim flow.
    if (routeKey === 'GET /auth/facebook') {
      return await handleFacebookAuth(event);
    }

    // Apple OAuth route
    if (routeKey === 'GET /auth/apple') {
      return await handleAppleAuth(event);
    }

    // Route not found
    console.error('Route not found:', { routeKey, method, path });
    return createResponse(404, {
      error: 'Route not found',
      path,
      method,
      routeKey
    });

  } catch (error) {
    console.error('Auth Lambda: Unexpected error:', error);
    return createResponse(500, {
      error: 'Internal server error',
      message: error.message
    });
  }
};
