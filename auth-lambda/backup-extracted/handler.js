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

const FRONTEND_URL = 'https://backstage.bndy.co.uk';
const API_URL = 'https://api.bndy.co.uk';
const REDIRECT_URI = `${API_URL}/auth/callback`;

// DynamoDB Tables
const USERS_TABLE = 'bndy-users';
const OTP_TABLE = 'bndy-otp-codes';
const MAGIC_TOKEN_TABLE = 'bndy-magic-tokens';

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

  console.log('AUTH: Initiating Google OAuth flow', {
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

  console.log('AUTH CALLBACK: Received callback', {
    hasCode: !!code,
    hasState: !!state,
    error,
    fullEvent: JSON.stringify(event, null, 2)
  });

  try {
    // Verify state to prevent CSRF
    if (!state || !stateStore.has(state)) {
      console.error('AUTH CALLBACK: Invalid or expired state');
      return {
        statusCode: 302,
        headers: { Location: `${FRONTEND_URL}/login?error=invalid_state` },
        body: ''
      };
    }

    stateStore.delete(state);

    if (error) {
      console.error('AUTH CALLBACK: OAuth error:', error);
      return {
        statusCode: 302,
        headers: { Location: `${FRONTEND_URL}/login?error=${encodeURIComponent(error)}` },
        body: ''
      };
    }

    if (!code) {
      console.error('AUTH CALLBACK: No authorization code received');
      return {
        statusCode: 302,
        headers: { Location: `${FRONTEND_URL}/login?error=no_code` },
        body: ''
      };
    }

    // Exchange code for tokens
    console.log('AUTH CALLBACK: Exchanging code for tokens');

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

    // Create or update user in DynamoDB
    await createOrUpdateUser({
      cognitoId: userId,
      email,
      username
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
    const cookieOptions = 'bndy_session=' + sessionToken + '; ' +
      'HttpOnly; Secure; SameSite=Lax; ' +
      'Max-Age=7776000; Path=/; ' +
      'Domain=.bndy.co.uk';

    console.log('AUTH CALLBACK: Session created, redirecting to dashboard');

    // Return 200 with HTML+JS redirect for reliable cookie setting
    const redirectHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Redirecting...</title>
</head>
<body>
  <p>Authentication successful. Redirecting...</p>
  <script>
    window.location.href = '${FRONTEND_URL}/dashboard';
  </script>
</body>
</html>`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html',
        'Set-Cookie': cookieOptions
      },
      body: redirectHtml
    };

  } catch (error) {
    console.error('AUTH CALLBACK: Token exchange failed:', error.message);
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
    console.error('API: /api/me error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

const handleLogout = (event) => {
  console.log('AUTH: User logging out');

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

      const cookieOptions = 'bndy_session=' + sessionToken + '; ' +
        'HttpOnly; Secure; SameSite=Lax; ' +
        'Max-Age=7776000; Path=/; ' +
        'Domain=.bndy.co.uk';

      console.log('[PHONE_AUTH] Existing user logged in');

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': cookieOptions,
          ...corsHeaders
        },
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

    const cookieOptions = 'bndy_session=' + sessionToken + '; ' +
      'HttpOnly; Secure; SameSite=Lax; ' +
      'Max-Age=7776000; Path=/; ' +
      'Domain=.bndy.co.uk';

    console.log('[PHONE_AUTH] New user created and logged in');

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookieOptions,
        ...corsHeaders
      },
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

    const cookieOptions = 'bndy_session=' + sessionToken + '; ' +
      'HttpOnly; Secure; SameSite=Lax; ' +
      'Max-Age=7776000; Path=/; ' +
      'Domain=.bndy.co.uk';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': cookieOptions,
        ...corsHeaders
      },
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
  const { cognitoId, email, username } = userData;

  try {
    // Check if user exists
    const existingUser = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: cognitoId }
    }).promise();

    if (existingUser.Item) {
      console.log('DB: User exists, updating');

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
      console.log('DB: Creating new user');

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
        type: 'email-magic-link'
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
        headers: { Location: `${FRONTEND_URL}/login?error=invalid_token` },
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
      return {
        statusCode: 302,
        headers: { Location: `${FRONTEND_URL}/login?error=token_expired` },
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

      const sessionData = {
        userId: existingUser.cognito_id,
        username: existingUser.username,
        email: existingUser.email,
        issuedAt: Date.now()
      };

      const sessionToken = jwt.sign(sessionData, JWT_SECRET, { expiresIn: '90d' });

      const cookieOptions = 'bndy_session=' + sessionToken + '; ' +
        'HttpOnly; Secure; SameSite=Lax; ' +
        'Max-Age=7776000; Path=/; ' +
        'Domain=.bndy.co.uk';

      console.log('[EMAIL_AUTH] Existing user logged in');

      const redirectHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Redirecting...</title>
</head>
<body>
  <p>Authentication successful. Redirecting...</p>
  <script>
    window.location.href = '${FRONTEND_URL}/dashboard';
  </script>
</body>
</html>`;

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'text/html',
          'Set-Cookie': cookieOptions
        },
        body: redirectHtml
      };
    }

    // New user - auto-create like phone auth does
    console.log('[EMAIL_AUTH] New user, auto-creating in bndy-users');

    const userId = crypto.randomUUID();
    const cognitoId = `email_${userId}`;
    const username = `user_${email.split('@')[0]}`;

    await dynamodb.put({
      TableName: USERS_TABLE,
      Item: {
        cognito_id: cognitoId,
        user_id: userId,
        email,
        username,
        profile_complete: false,
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

    const cookieOptions = 'bndy_session=' + sessionToken + '; ' +
      'HttpOnly; Secure; SameSite=Lax; ' +
      'Max-Age=7776000; Path=/; ' +
      'Domain=.bndy.co.uk';

    console.log('[EMAIL_AUTH] New user created and logged in');

    const redirectHtml = `
<!DOCTYPE html>
<html>
<head>
  <title>Redirecting...</title>
</head>
<body>
  <p>Welcome to bndy! Redirecting...</p>
  <script>
    window.location.href = '${FRONTEND_URL}/dashboard';
  </script>
</body>
</html>`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html',
        'Set-Cookie': cookieOptions
      },
      body: redirectHtml
    };

  } catch (error) {
    console.error('[EMAIL_AUTH] Magic link validation error:', error);
    return {
      statusCode: 302,
      headers: { Location: `${FRONTEND_URL}/login?error=authentication_failed` },
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
const handleAppleAuth = (event) => {
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
    `identity_provider=SignInWithApple`;

  console.log('AUTH: Initiating Apple OAuth flow', {
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

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ''
    };
  }

  try {
    // Route requests using routeKey
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

    // Apple OAuth route
    if (routeKey === 'GET /auth/apple') {
      return handleAppleAuth(event);
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