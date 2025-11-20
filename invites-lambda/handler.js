// BNDY Invites Lambda Function - Magic Link Invite Management
// Handles: POST /api/artists/{artistId}/invites/general
//          POST /api/artists/{artistId}/invites/phone
//          GET /api/artists/{artistId}/invites
//          GET /api/invites/{token}
//          DELETE /api/invites/{token}
//          POST /api/invites/{token}/accept

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// AWS Services
const dynamodb = new AWS.DynamoDB.DocumentClient();
const pinpointSMS = new AWS.PinpointSMSVoiceV2({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });

// Configuration
const INVITES_TABLE = 'bndy-invites';
const ARTISTS_TABLE = 'bndy-artists';
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';
const USERS_TABLE = 'bndy-users';
const FRONTEND_URL = 'https://backstage.bndy.co.uk';

const INVITE_EXPIRY_DAYS = 7;

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
    console.log('[INVITES] JWT_SECRET loaded from SSM');
    return JWT_SECRET;
  } catch (error) {
    console.error('[INVITES] Failed to get JWT_SECRET from SSM:', error.message);
    // Fallback to environment variable
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      console.log('[INVITES] JWT_SECRET loaded from environment variable (fallback)');
      return JWT_SECRET;
    }
    throw new Error('JWT_SECRET not available from SSM or environment');
  }
}

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
const requireAuth = async (event) => {
  let cookieHeader = event.headers?.Cookie || event.headers?.cookie;

  if (!cookieHeader && event.cookies && event.cookies.length > 0) {
    cookieHeader = event.cookies.join('; ');
  }

  const cookies = parseCookies(cookieHeader);
  const sessionToken = cookies.bndy_session;

  console.log('[INVITES] Checking authentication', {
    hasCookie: !!cookieHeader,
    hasSessionToken: !!sessionToken
  });

  if (!sessionToken) {
    console.log('[INVITES] No session token found');
    return { error: 'Not authenticated' };
  }

  try {
    const jwtSecret = await getJWTSecret();
    const session = jwt.verify(sessionToken, jwtSecret);
    console.log('[INVITES] User authenticated via session', {
      userId: session.userId.substring(0, 8) + '...'
    });
    return { user: session };
  } catch (error) {
    console.error('[INVITES] Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

// Helper: Send SMS invite
const sendInviteSMS = async (phone, artistName, inviterName, inviteLink) => {
  const message = `${inviterName} invited you to join ${artistName} on bndy!\n\n${inviteLink}\n\n(Link expires in 7 days)`;

  console.log('[INVITES] Sending SMS invite', { phone: phone.substring(0, 6) + '***' });

  try {
    await pinpointSMS.sendTextMessage({
      DestinationPhoneNumber: phone,
      MessageBody: message,
      OriginationIdentity: 'BNDY',
      MessageType: 'TRANSACTIONAL',
      ConfigurationSetName: 'bndy-sms-config'
    }).promise();

    console.log('[INVITES] SMS sent successfully via Pinpoint');
  } catch (error) {
    console.error('[INVITES] Pinpoint SMS send failed:', error);
    throw new Error('Failed to send SMS invite');
  }
};

// Handler: POST /api/artists/{artistId}/invites/general
const handleCreateGeneralInvite = async (event, artistId) => {
  const authResult = await requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const { user } = authResult;

  try {
    console.log('[INVITES] Creating general invite', { artistId, userId: user.userId });

    // Get artist details
    const artistResult = await dynamodb.get({
      TableName: ARTISTS_TABLE,
      Key: { id: artistId }
    }).promise();

    if (!artistResult.Item) {
      return createResponse(404, { error: 'Artist not found' });
    }

    const artist = artistResult.Item;

    // Verify user is admin/owner of this artist
    const membershipResult = await dynamodb.query({
      TableName: MEMBERSHIPS_TABLE,
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      FilterExpression: 'user_id = :userId AND (#role = :admin OR #role = :owner)',
      ExpressionAttributeNames: {
        '#role': 'role'
      },
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':userId': user.userId,
        ':admin': 'admin',
        ':owner': 'owner'
      }
    }).promise();

    if (membershipResult.Items.length === 0) {
      return createResponse(403, { error: 'Insufficient permissions - must be admin or owner' });
    }

    // Get inviter details
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: user.userId }
    }).promise();

    const inviterName = userResult.Item?.display_name || userResult.Item?.username || 'Someone';

    // Generate invite token
    const token = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = Math.floor(Date.now() / 1000) + (INVITE_EXPIRY_DAYS * 24 * 60 * 60); // 7 days

    // Store invite (multi-use enabled)
    const invite = {
      token,
      artistId,
      invitedByUserId: user.userId,
      phone: null, // General invite - no specific phone
      inviteType: 'general',
      status: 'active', // active = multi-use enabled
      expiresAt,
      createdAt: now,
      acceptanceCount: 0,
      acceptedBy: [], // Track who accepted this invite
      metadata: {
        artistName: artist.name,
        inviterName
      }
    };

    await dynamodb.put({
      TableName: INVITES_TABLE,
      Item: invite
    }).promise();

    const inviteLink = `${FRONTEND_URL}/invite/${token}`;

    console.log('[INVITES] General invite created successfully', { token: token.substring(0, 8) + '...' });

    return createResponse(201, {
      success: true,
      inviteLink,
      token,
      expiresAt
    });

  } catch (error) {
    console.error('[INVITES] Create general invite error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Handler: POST /api/artists/{artistId}/invites/phone
const handleCreatePhoneInvite = async (event, artistId) => {
  const authResult = await requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const { user } = authResult;

  try {
    const requestBody = JSON.parse(event.body);
    const { phone } = requestBody;

    if (!phone) {
      return createResponse(400, { error: 'Phone number is required' });
    }

    // Validate phone format
    if (!/^\+[1-9]\d{10,14}$/.test(phone)) {
      return createResponse(400, { error: 'Invalid phone number format. Must start with + and country code.' });
    }

    console.log('[INVITES] Creating phone-specific invite', {
      artistId,
      phone: phone.substring(0, 6) + '***',
      userId: user.userId
    });

    // Get artist details
    const artistResult = await dynamodb.get({
      TableName: ARTISTS_TABLE,
      Key: { id: artistId }
    }).promise();

    if (!artistResult.Item) {
      return createResponse(404, { error: 'Artist not found' });
    }

    const artist = artistResult.Item;

    // Verify user is admin/owner
    const membershipResult = await dynamodb.query({
      TableName: MEMBERSHIPS_TABLE,
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      FilterExpression: 'user_id = :userId AND (#role = :admin OR #role = :owner)',
      ExpressionAttributeNames: {
        '#role': 'role'
      },
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':userId': user.userId,
        ':admin': 'admin',
        ':owner': 'owner'
      }
    }).promise();

    if (membershipResult.Items.length === 0) {
      return createResponse(403, { error: 'Insufficient permissions - must be admin or owner' });
    }

    // Get inviter details
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: user.userId }
    }).promise();

    const inviterName = userResult.Item?.display_name || userResult.Item?.username || 'Someone';

    // Generate invite token
    const token = crypto.randomUUID();
    const now = new Date().toISOString();
    const expiresAt = Math.floor(Date.now() / 1000) + (INVITE_EXPIRY_DAYS * 24 * 60 * 60);

    // Store invite (phone-specific, still single-use)
    const invite = {
      token,
      artistId,
      invitedByUserId: user.userId,
      phone,
      inviteType: 'phone-specific',
      status: 'active',
      expiresAt,
      createdAt: now,
      acceptanceCount: 0,
      acceptedBy: [], // Track who accepted
      metadata: {
        artistName: artist.name,
        inviterName
      }
    };

    await dynamodb.put({
      TableName: INVITES_TABLE,
      Item: invite
    }).promise();

    const inviteLink = `${FRONTEND_URL}/invite/${token}`;

    // Send SMS via Pinpoint
    try {
      await sendInviteSMS(phone, artist.name, inviterName, inviteLink);
    } catch (smsError) {
      console.warn('[INVITES] SMS send failed:', smsError.message);
      // Don't fail the whole request - invite is still created
    }

    console.log('[INVITES] Phone invite created successfully');

    return createResponse(201, {
      success: true,
      phone,
      inviteLink,
      token,
      expiresAt
    });

  } catch (error) {
    console.error('[INVITES] Create phone invite error:', error);
    return createResponse(500, { error: 'Internal server error', message: error.message });
  }
};

// Handler: GET /api/artists/{artistId}/invites
const handleListInvites = async (event, artistId) => {
  const authResult = await requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const { user } = authResult;

  try {
    console.log('[INVITES] Listing invites for artist', { artistId, userId: user.userId });

    // Verify user is admin/owner of this artist
    const membershipResult = await dynamodb.query({
      TableName: MEMBERSHIPS_TABLE,
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      FilterExpression: 'user_id = :userId AND (#role = :admin OR #role = :owner)',
      ExpressionAttributeNames: {
        '#role': 'role'
      },
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':userId': user.userId,
        ':admin': 'admin',
        ':owner': 'owner'
      }
    }).promise();

    if (membershipResult.Items.length === 0) {
      return createResponse(403, { error: 'Insufficient permissions - must be admin or owner' });
    }

    // Query invites for this artist using GSI
    const invitesResult = await dynamodb.query({
      TableName: INVITES_TABLE,
      IndexName: 'artistId-expiresAt-index',
      KeyConditionExpression: 'artistId = :artistId',
      ExpressionAttributeValues: {
        ':artistId': artistId
      }
    }).promise();

    console.log('[INVITES] Found invites', { count: invitesResult.Items.length });

    return createResponse(200, invitesResult.Items);

  } catch (error) {
    console.error('[INVITES] List invites error:', error);
    return createResponse(500, { error: 'Internal server error', message: error.message });
  }
};

// Handler: DELETE /api/invites/{token}
const handleDisableInvite = async (event, token) => {
  const authResult = await requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const { user } = authResult;

  try {
    console.log('[INVITES] Disabling invite', { token: token.substring(0, 8) + '...', userId: user.userId });

    // Get invite first to check permissions
    const inviteResult = await dynamodb.get({
      TableName: INVITES_TABLE,
      Key: { token }
    }).promise();

    if (!inviteResult.Item) {
      return createResponse(404, { error: 'Invite not found' });
    }

    const invite = inviteResult.Item;

    // Verify user is admin/owner of the artist
    const membershipResult = await dynamodb.query({
      TableName: MEMBERSHIPS_TABLE,
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      FilterExpression: 'user_id = :userId AND (#role = :admin OR #role = :owner)',
      ExpressionAttributeNames: {
        '#role': 'role'
      },
      ExpressionAttributeValues: {
        ':artistId': invite.artistId,
        ':userId': user.userId,
        ':admin': 'admin',
        ':owner': 'owner'
      }
    }).promise();

    if (membershipResult.Items.length === 0) {
      return createResponse(403, { error: 'Insufficient permissions - must be admin or owner' });
    }

    // Update invite status to disabled
    await dynamodb.update({
      TableName: INVITES_TABLE,
      Key: { token },
      UpdateExpression: 'SET #status = :disabled',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':disabled': 'disabled' }
    }).promise();

    console.log('[INVITES] Invite disabled successfully');

    return createResponse(200, { success: true, message: 'Invite disabled' });

  } catch (error) {
    console.error('[INVITES] Disable invite error:', error);
    return createResponse(500, { error: 'Internal server error', message: error.message });
  }
};

// Handler: GET /api/invites/{token}
const handleGetInvite = async (event, token) => {
  // Public endpoint - no auth required

  try {
    console.log('[INVITES] Getting invite details', { token: token.substring(0, 8) + '...' });

    // Get invite
    const inviteResult = await dynamodb.get({
      TableName: INVITES_TABLE,
      Key: { token }
    }).promise();

    if (!inviteResult.Item) {
      return createResponse(404, { error: 'Invite not found' });
    }

    const invite = inviteResult.Item;

    // Check if expired
    const now = Math.floor(Date.now() / 1000);
    if (invite.expiresAt < now) {
      // Mark as expired
      await dynamodb.update({
        TableName: INVITES_TABLE,
        Key: { token },
        UpdateExpression: 'SET #status = :expired',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':expired': 'expired' }
      }).promise();

      return createResponse(410, { error: 'Invite has expired' });
    }

    // Check if disabled
    if (invite.status === 'disabled') {
      return createResponse(410, { error: 'This invite has been disabled' });
    }

    // Check if active (multi-use invites are always 'active')
    if (invite.status !== 'active') {
      return createResponse(410, { error: 'Invite is no longer valid' });
    }

    console.log('[INVITES] Invite found and valid');

    // Return invite details (without sensitive info)
    return createResponse(200, {
      token: invite.token,
      artistId: invite.artistId,
      inviteType: invite.inviteType,
      status: invite.status,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
      metadata: invite.metadata
    });

  } catch (error) {
    console.error('[INVITES] Get invite error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Handler: POST /api/invites/{token}/accept
const handleAcceptInvite = async (event, token) => {
  try {
    console.log('[INVITES] handleAcceptInvite called', {
      hasToken: !!token,
      tokenType: typeof token,
      tokenValue: token ? token.substring(0, 20) : 'undefined'
    });

    const authResult = await requireAuth(event);
    if (authResult.error) {
      return createResponse(401, { error: authResult.error });
    }

    const { user } = authResult;

    console.log('[INVITES] Accepting invite', {
      token: token ? token.substring(0, 8) + '...' : 'undefined',
      userId: user.userId
    });

    // Get invite
    console.log('[INVITES] About to call DynamoDB get', {
      tableName: INVITES_TABLE,
      tokenLength: token ? token.length : 0
    });

    const inviteResult = await dynamodb.get({
      TableName: INVITES_TABLE,
      Key: { token }
    }).promise();

    console.log('[INVITES] DynamoDB get completed', {
      hasItem: !!inviteResult.Item
    });

    console.log('[INVITES] CHECK 1: About to check if item exists');

    if (!inviteResult.Item) {
      console.log('[INVITES] CHECK 2: Item not found, returning 404');

      return createResponse(404, { error: 'Invite not found' });
    }

    const invite = inviteResult.Item;

    console.log('[INVITES] CHECK 3: Got invite item', {
      status: invite.status,
      expiresAt: invite.expiresAt
    });

    // Check if expired
    const now = Math.floor(Date.now() / 1000);
    if (invite.expiresAt < now) {
      console.log('[INVITES] CHECK 4: Invite expired');
      return createResponse(410, { error: 'Invite has expired' });
    }

    // Check if already accepted
    if (invite.status === 'accepted') {
      console.log('[INVITES] CHECK 5: Invite already accepted');
      return createResponse(400, { error: 'Invite has already been accepted' });
    }

    console.log('[INVITES] CHECK 6: Invite valid, checking membership');

    // Check if user is already a member - query by user_id GSI and filter in code
    console.log('[INVITES] CHECK 7: Querying user memberships');

    const existingMembershipResult = await dynamodb.query({
      TableName: MEMBERSHIPS_TABLE,
      IndexName: 'user_id-index',
      KeyConditionExpression: 'user_id = :userId',
      ExpressionAttributeValues: {
        ':userId': user.userId
      }
    }).promise();

    console.log('[INVITES] CHECK 8: Membership query completed', {
      totalMemberships: existingMembershipResult.Items.length
    });

    // Check if user is already a member of THIS artist
    const existingMembership = existingMembershipResult.Items.find(
      m => m.artist_id === invite.artistId
    );

    if (existingMembership) {
      console.log('[INVITES] CHECK 9: User already member of this artist');
      return createResponse(400, { error: 'You are already a member of this artist' });
    }

    console.log('[INVITES] CHECK 10: User not yet a member, proceeding');

    // Get artist details
    const artistResult = await dynamodb.get({
      TableName: ARTISTS_TABLE,
      Key: { id: invite.artistId }
    }).promise();

    if (!artistResult.Item) {
      return createResponse(404, { error: 'Artist not found' });
    }

    const artist = artistResult.Item;

    // Create membership
    const membershipId = crypto.randomUUID();
    const nowISO = new Date().toISOString();

    const membership = {
      membership_id: membershipId,
      user_id: user.userId,
      artist_id: invite.artistId,
      membership_type: 'performer',
      role: 'member', // Default role for invited members

      // Profile (nullable = inherit from user)
      display_name: null,
      avatar_url: null,
      instrument: null,
      bio: null,

      // UI
      icon: 'fa-music',
      color: '#708090',

      // Permissions
      permissions: [],

      // Metadata
      joined_at: nowISO,
      invited_at: invite.createdAt,
      invited_by_user_id: invite.invitedByUserId,
      status: 'active',

      created_at: nowISO,
      updated_at: nowISO
    };

    await dynamodb.put({
      TableName: MEMBERSHIPS_TABLE,
      Item: membership
    }).promise();

    // Update artist member_count
    await dynamodb.update({
      TableName: ARTISTS_TABLE,
      Key: { id: invite.artistId },
      UpdateExpression: 'ADD member_count :inc',
      ExpressionAttributeValues: { ':inc': 1 }
    }).promise();

    // Track acceptance (multi-use: increment count, add to acceptedBy list)
    await dynamodb.update({
      TableName: INVITES_TABLE,
      Key: { token },
      UpdateExpression: 'ADD acceptanceCount :inc SET acceptedBy = list_append(if_not_exists(acceptedBy, :emptyList), :newAcceptance), lastAcceptedAt = :now',
      ExpressionAttributeValues: {
        ':inc': 1,
        ':emptyList': [],
        ':newAcceptance': [{
          userId: user.userId,
          membershipId: membershipId,
          acceptedAt: nowISO
        }],
        ':now': nowISO
      }
    }).promise();

    console.log('[INVITES] Invite accepted successfully, membership created');

    return createResponse(200, {
      success: true,
      membership: {
        id: membershipId,
        role: membership.role,
        joinedAt: nowISO
      },
      artist: {
        id: artist.id,
        name: artist.name,
        profileImageUrl: artist.profileImageUrl
      }
    });

  } catch (error) {
    console.error('[INVITES] Accept invite error:', error);
    console.error('[INVITES] Error stack:', error.stack);
    console.error('[INVITES] Error details:', JSON.stringify({
      name: error.name,
      message: error.message,
      code: error.code,
      type: typeof error,
      keys: Object.keys(error)
    }));
    return createResponse(500, { error: 'Internal server error', message: error.message });
  }
};

// Main handler
exports.handler = async (event, context) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;
  const routeKey = `${method} ${path}`;

  console.log('[INVITES] Request received', {
    method,
    path,
    routeKey,
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
    const artistId = event.pathParameters?.artistId;
    const token = event.pathParameters?.token;

    // Route requests
    if (method === 'POST' && path.includes('/artists/') && path.includes('/invites/general')) {
      return await handleCreateGeneralInvite(event, artistId);
    }

    if (method === 'POST' && path.includes('/artists/') && path.includes('/invites/phone')) {
      return await handleCreatePhoneInvite(event, artistId);
    }

    if (method === 'GET' && path.includes('/artists/') && path.includes('/invites') && artistId) {
      return await handleListInvites(event, artistId);
    }

    if (method === 'GET' && path.includes('/invites/') && token && !path.includes('/accept')) {
      return await handleGetInvite(event, token);
    }

    if (method === 'DELETE' && path.includes('/invites/') && token) {
      return await handleDisableInvite(event, token);
    }

    if (method === 'POST' && path.includes('/invites/') && path.includes('/accept')) {
      return await handleAcceptInvite(event, token);
    }

    // Route not found
    return createResponse(404, {
      error: 'Route not found',
      routeKey,
      path,
      method
    });

  } catch (error) {
    console.error('[INVITES] Unexpected error:', error);
    return createResponse(500, {
      error: 'Internal server error',
      message: error.message
    });
  }
};
