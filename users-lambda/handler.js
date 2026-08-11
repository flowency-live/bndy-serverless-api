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
const ACTIVITY_TABLE = 'bndy-activity-log';

// Role ladder (backlog feature 4). platformAdmin stays the godmode gate.
const VALID_ROLES = ['user', 'curator', 'owner', 'staff'];

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

// ========== ACTIVITY LOG (backlog feature 4) ==========
// One entry per curator/admin write. PK = actor cognito_id, SK = at#suffix.
// GSI AllByTime (gsi_pk='ALL', sk) gives godmode the recent feed.

const writeActivity = async ({ actorCognitoId, actorName, action, entityType, entityId, entityName, detail }) => {
  const at = new Date().toISOString();
  const suffix = Math.random().toString(36).slice(2, 10);
  await dynamodb.put({
    TableName: ACTIVITY_TABLE,
    Item: {
      user_id: actorCognitoId,
      sk: `${at}#${suffix}`,
      at,
      actor_name: actorName || null,
      action,
      entity_type: entityType,
      entity_id: entityId,
      entity_name: entityName || null,
      detail: detail || null,
      gsi_pk: 'ALL'
    }
  }).promise();
};

const toActivityEntry = (item) => ({
  at: item.at,
  actorName: item.actor_name || null,
  actorId: item.user_id,
  action: item.action,
  entityType: item.entity_type,
  entityId: item.entity_id,
  entityName: item.entity_name || null,
  detail: item.detail || null
});

// ========== FLAG A PROBLEM (backlog feature 6) ==========
// Anyone flags a record, no account needed. Signed in, the reporter is
// recorded so bndy can come back to them. Flags land in bndy-flags (the
// feature-5 queue store) AND in the activity feed so godmode sees them now.

const FLAGS_TABLE = 'bndy-flags';
const FLAG_ENTITY_TYPES = ['artist', 'venue', 'event'];

// POST /api/community/flags — PUBLIC, WAF rate-limited like the other community routes
const handleCreateFlag = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return createResponse(400, { error: 'Invalid JSON body' });
  }

  const { entityType, entityId, entityName, reason } = body;

  if (!FLAG_ENTITY_TYPES.includes(entityType)) {
    return createResponse(400, { error: "entityType must be 'artist', 'venue' or 'event'" });
  }
  if (typeof entityId !== 'string' || entityId.length === 0 || entityId.length > 200) {
    return createResponse(400, { error: 'entityId must be a non-empty string' });
  }
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
    return createResponse(400, { error: 'reason must be 3 to 500 characters' });
  }

  // Optional identity: a valid session records the reporter. Failure = anonymous.
  let reporterId = null;
  let reporterName = null;
  const authResult = await requireAuth(event);
  if (!authResult.error) {
    reporterId = authResult.user.userId;
    try {
      const u = await dynamodb.get({ TableName: USERS_TABLE, Key: { cognito_id: reporterId } }).promise();
      reporterName = u.Item?.display_name || null;
    } catch (e) { /* name is optional */ }
  }

  const now = new Date().toISOString();
  const flagId = `flag_${now.replace(/[:.]/g, '')}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    await dynamodb.put({
      TableName: FLAGS_TABLE,
      Item: {
        id: flagId,
        entity_type: entityType,
        entity_id: entityId,
        entity_name: (typeof entityName === 'string' && entityName.length <= 300) ? entityName : null,
        reason: reason.trim(),
        reporter_user_id: reporterId,
        reporter_name: reporterName,
        status: 'open',
        gsi_status: 'open',
        created_at: now
      }
    }).promise();

    // Surface in the godmode activity feed immediately.
    await writeActivity({
      actorCognitoId: reporterId || 'anonymous',
      actorName: reporterName || 'Anonymous visitor',
      action: 'flag',
      entityType,
      entityId,
      entityName: (typeof entityName === 'string' && entityName.length <= 300) ? entityName : null,
      detail: reason.trim()
    });

    console.log('USERS: Flag created', { entityType, anonymous: !reporterId });
    return createResponse(200, { success: true, flagId });
  } catch (error) {
    console.error('USERS: Create flag error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// GET /users/flags — platformAdmin, open flags newest first
const handleGetFlags = async (event) => {
  const authResult = await requirePlatformAdmin(event);
  if (authResult.statusCode) {
    return createResponse(authResult.statusCode, { error: authResult.error });
  }

  try {
    const status = event.queryStringParameters?.status === 'resolved' ? 'resolved' : 'open';
    const result = await dynamodb.query({
      TableName: FLAGS_TABLE,
      IndexName: 'ByStatus',
      KeyConditionExpression: 'gsi_status = :open',
      ExpressionAttributeValues: { ':open': status },
      ScanIndexForward: false,
      Limit: 200
    }).promise();

    const flags = (result.Items || []).map((f) => ({
      id: f.id,
      entityType: f.entity_type,
      entityId: f.entity_id,
      entityName: f.entity_name || null,
      reason: f.reason,
      reporterUserId: f.reporter_user_id || null,
      reporterName: f.reporter_name || null,
      status: f.status,
      createdAt: f.created_at,
      resolvedAt: f.resolved_at || null
    }));

    return createResponse(200, { flags });
  } catch (error) {
    console.error('USERS: Get flags error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// PUT /users/flags/{flagId}/resolve — platformAdmin
const handleResolveFlag = async (event) => {
  const authResult = await requirePlatformAdmin(event);
  if (authResult.statusCode) {
    return createResponse(authResult.statusCode, { error: authResult.error });
  }

  const flagId = event.pathParameters?.flagId;
  if (!flagId) return createResponse(400, { error: 'Flag ID is required' });

  try {
    await dynamodb.update({
      TableName: FLAGS_TABLE,
      Key: { id: flagId },
      ConditionExpression: 'attribute_exists(id)',
      UpdateExpression: 'SET #status = :resolved, gsi_status = :resolved, resolved_at = :at, resolved_by = :by',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':resolved': 'resolved',
        ':at': new Date().toISOString(),
        ':by': authResult.user.userId
      }
    }).promise();

    return createResponse(200, { success: true, flagId, status: 'resolved' });
  } catch (error) {
    if (error.code === 'ConditionalCheckFailedException') {
      return createResponse(404, { error: 'Flag not found' });
    }
    console.error('USERS: Resolve flag error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// PUT /users/{userId}/role — platformAdmin only
const handleSetUserRole = async (event) => {
  const authResult = await requirePlatformAdmin(event);
  if (authResult.statusCode) {
    return createResponse(authResult.statusCode, { error: authResult.error });
  }

  const userId = event.pathParameters?.userId;
  if (!userId) {
    return createResponse(400, { error: 'User ID is required' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return createResponse(400, { error: 'Invalid JSON body' });
  }

  if (!VALID_ROLES.includes(body.role)) {
    return createResponse(400, { error: `role must be one of: ${VALID_ROLES.join(', ')}` });
  }

  try {
    // user_id (uuid) → cognito_id, same pattern as delete
    const found = await dynamodb.scan({
      TableName: USERS_TABLE,
      FilterExpression: 'user_id = :userId',
      ExpressionAttributeValues: { ':userId': userId }
    }).promise();

    if (!found.Items || found.Items.length === 0) {
      return createResponse(404, { error: 'User not found' });
    }

    const target = found.Items[0];

    await dynamodb.update({
      TableName: USERS_TABLE,
      Key: { cognito_id: target.cognito_id },
      UpdateExpression: 'SET #role = :role, updated_at = :updatedAt',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: {
        ':role': body.role,
        ':updatedAt': new Date().toISOString()
      }
    }).promise();

    await writeActivity({
      actorCognitoId: authResult.user.userId,
      actorName: authResult.dbUser?.display_name,
      action: 'set-role',
      entityType: 'user',
      entityId: userId,
      entityName: target.display_name || target.username || null,
      detail: body.role
    });

    console.log('USERS: Role set', { role: body.role });
    return createResponse(200, { success: true, userId, role: body.role });
  } catch (error) {
    console.error('USERS: Set role error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// GET /users/activity — the caller's own activity, newest first
const handleGetMyActivity = async (event) => {
  const authResult = await requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  try {
    const limit = Math.min(Number(event.queryStringParameters?.limit) || 50, 100);
    const result = await dynamodb.query({
      TableName: ACTIVITY_TABLE,
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': authResult.user.userId },
      ScanIndexForward: false,
      Limit: limit
    }).promise();

    return createResponse(200, { entries: (result.Items || []).map(toActivityEntry) });
  } catch (error) {
    console.error('USERS: Get activity error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// GET /users/activity/all — platformAdmin recent feed, optional ?action= filter
const handleGetAllActivity = async (event) => {
  const authResult = await requirePlatformAdmin(event);
  if (authResult.statusCode) {
    return createResponse(authResult.statusCode, { error: authResult.error });
  }

  try {
    const qp = event.queryStringParameters || {};
    const limit = Math.min(Number(qp.limit) || 100, 200);
    const params = {
      TableName: ACTIVITY_TABLE,
      IndexName: 'AllByTime',
      KeyConditionExpression: 'gsi_pk = :all',
      ExpressionAttributeValues: { ':all': 'ALL' },
      ScanIndexForward: false,
      Limit: limit
    };
    if (qp.action) {
      params.FilterExpression = '#action = :action';
      params.ExpressionAttributeNames = { '#action': 'action' };
      params.ExpressionAttributeValues[':action'] = qp.action;
    }
    const result = await dynamodb.query(params).promise();
    return createResponse(200, { entries: (result.Items || []).map(toActivityEntry) });
  } catch (error) {
    console.error('USERS: Get all activity error:', error);
    return createResponse(500, { error: 'Internal server error' });
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
      role: dbUser.role || (dbUser.platformAdmin ? 'staff' : 'user'),
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
      ProjectionExpression: 'user_id, cognito_id, email, phone, username, first_name, last_name, display_name, profile_complete, user_source, #role, platformAdmin, created_at',
      ExpressionAttributeNames: { '#role': 'role' }
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
      role: user.role || (user.platformAdmin ? 'staff' : 'user'),
      platformAdmin: user.platformAdmin || false,
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

    if (routeKey === 'POST /api/community/flags') {
      return await handleCreateFlag(event);
    }

    if (routeKey === 'GET /users/flags') {
      return await handleGetFlags(event);
    }

    if (routeKey.startsWith('PUT /users/flags/') && routeKey.endsWith('/resolve')) {
      return await handleResolveFlag(event);
    }

    if (routeKey === 'GET /users/activity') {
      return await handleGetMyActivity(event);
    }

    if (routeKey === 'GET /users/activity/all') {
      return await handleGetAllActivity(event);
    }

    if (routeKey.startsWith('PUT /users/') && routeKey.endsWith('/role')) {
      return await handleSetUserRole(event);
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