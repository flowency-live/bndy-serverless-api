// BNDY Memberships Lambda Function - Artist Membership Management
// Handles: /api/artists/{id}/members, /api/memberships/{id}

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// AWS Services
const dynamodb = new AWS.DynamoDB.DocumentClient();
const ssm = new AWS.SSM({ region: 'eu-west-2' });

// Configuration
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';
const ARTISTS_TABLE = 'bndy-artists';
const USERS_TABLE = 'bndy-users';

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
    console.log('[MEMBERSHIPS] JWT_SECRET loaded from SSM');
    return JWT_SECRET;
  } catch (error) {
    console.error('[MEMBERSHIPS] Failed to get JWT_SECRET from SSM:', error.message);
    // Fallback to environment variable
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      console.log('[MEMBERSHIPS] JWT_SECRET loaded from environment variable (fallback)');
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
  'https://gigs.bndy.co.uk',      // Gigs
  'https://bndy.live',             // Public maps domain
  'https://stage.bndy.live',       // Backstage domain
  'http://localhost:3000'          // Local development
];

// Module-level variable to store current request event for CORS
let currentEvent = null;

// Get appropriate origin for CORS based on request origin
const getAllowedOrigin = () => {
  const requestOrigin = currentEvent?.headers?.origin || currentEvent?.headers?.Origin;
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
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

// Create response
const createResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    ...getCorsHeaders()
  },
  body: JSON.stringify(body)
});

// Authentication middleware
const requireAuth = async (event) => {
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
    const jwtSecret = await getJWTSecret();
    const session = jwt.verify(sessionToken, jwtSecret);

    // Fetch platformAdmin flag from users table
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: session.userId }
    }).promise();

    const platformAdmin = userResult.Item?.platformAdmin || false;

    console.log('[MEMBERSHIPS] User authenticated via session', {
      userId: session.userId.substring(0, 8) + '...',
      platformAdmin
    });
    return { user: { ...session, platformAdmin } };
  } catch (error) {
    console.error('[MEMBERSHIPS] Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

// SEC-AUD-003: Platform admin authorization - required for godmode endpoints
const requirePlatformAdmin = async (event) => {
  const authResult = await requireAuth(event);
  if (authResult.error) {
    return { error: authResult.error, statusCode: 401 };
  }

  if (!authResult.user.platformAdmin) {
    console.log('[MEMBERSHIPS] Access denied - not platform admin', {
      userId: authResult.user.userId.substring(0, 8) + '...'
    });
    return { error: 'Platform admin access required', statusCode: 403 };
  }

  return authResult;
};

// SEC-AUD-003: Artist admin authorization - required for membership mutations
const requireArtistAdmin = async (event, artistId) => {
  const authResult = await requireAuth(event);
  if (authResult.error) {
    return { error: authResult.error, statusCode: 401 };
  }

  // Platform admins can manage any artist
  if (authResult.user.platformAdmin) {
    console.log('[MEMBERSHIPS] Platform admin - artist access granted', {
      userId: authResult.user.userId.substring(0, 8) + '...',
      artistId
    });
    return authResult;
  }

  // Check if user is admin of this artist
  const membershipResult = await dynamodb.query({
    TableName: MEMBERSHIPS_TABLE,
    IndexName: 'artist_id-index',
    KeyConditionExpression: 'artist_id = :artistId',
    FilterExpression: 'user_id = :userId',
    ExpressionAttributeValues: {
      ':artistId': artistId,
      ':userId': authResult.user.userId
    }
  }).promise();

  const membership = membershipResult.Items?.[0];

  if (!membership || !['admin', 'owner'].includes(membership.role)) {
    console.log('[MEMBERSHIPS] Access denied - not artist admin', {
      userId: authResult.user.userId.substring(0, 8) + '...',
      artistId,
      hasRole: membership?.role || 'none'
    });
    return { error: 'Artist admin or owner access required', statusCode: 403 };
  }

  console.log('[MEMBERSHIPS] Artist admin verified', {
    userId: authResult.user.userId.substring(0, 8) + '...',
    artistId
  });
  return authResult;
};

// Helper: Resolve membership profile with inheritance from user
const resolveMembershipProfile = async (membership, userId) => {
  // Get user profile for inheritance
  // Note: membership.user_id contains cognito_id (not user_id from users table)
  const userResult = await dynamodb.get({
    TableName: USERS_TABLE,
    Key: { cognito_id: userId }
  }).promise();

  const userProfile = userResult.Item || {};

  return {
    // Frontend-expected format
    id: membership.membership_id,
    displayName: membership.display_name || userProfile.display_name || userProfile.username || 'Unknown',
    avatarUrl: membership.avatar_url || userProfile.avatar_url || userProfile.oauth_profile_picture,
    instrument: membership.instrument || userProfile.instrument || null,
    role: membership.role,
    status: membership.status,
    icon: membership.icon || 'fa-music',
    color: membership.color || '#708090',
    joinedAt: membership.joined_at,

    // User data for additional info
    user: {
      firstName: userProfile.first_name || userProfile.firstName || null,
      lastName: userProfile.last_name || userProfile.lastName || null,
      email: userProfile.email || null
    },

    // Keep original fields for backend use
    membership_id: membership.membership_id,
    user_id: membership.user_id,
    artist_id: membership.artist_id,
    membership_type: membership.membership_type,
    permissions: membership.permissions || [],

    // Resolved profile fields (with inheritance) - for backward compatibility
    resolved_display_name: membership.display_name || userProfile.display_name || userProfile.username,
    resolved_avatar_url: membership.avatar_url || userProfile.avatar_url || userProfile.oauth_profile_picture,
    resolved_instrument: membership.instrument || userProfile.instrument || null,

    // Customization flags
    has_custom_display_name: membership.display_name !== null && membership.display_name !== undefined,
    has_custom_avatar: membership.avatar_url !== null && membership.avatar_url !== undefined,
    has_custom_instrument: membership.instrument !== null && membership.instrument !== undefined
  };
};

// Get all memberships (godmode admin function)
const handleGetAllMemberships = async (event) => {
  // SEC-AUD-003: Require platformAdmin for godmode endpoints
  const authResult = await requirePlatformAdmin(event);
  if (authResult.statusCode) {
    return createResponse(authResult.statusCode, { error: authResult.error });
  }

  try {
    console.log('[MEMBERSHIPS] Getting all memberships (godmode)');

    // Scan all memberships
    const result = await dynamodb.scan({
      TableName: MEMBERSHIPS_TABLE
    }).promise();

    console.log(`[MEMBERSHIPS] Retrieved ${result.Items.length} memberships`);

    // Return raw membership data for godmode (no profile resolution needed)
    const memberships = result.Items.map(m => ({
      membership_id: m.membership_id,
      user_id: m.user_id,
      artist_id: m.artist_id,
      role: m.role,
      display_name: m.display_name,
      status: m.status
    }));

    return createResponse(200, { memberships, count: memberships.length });

  } catch (error) {
    console.error('[MEMBERSHIPS] Get all memberships error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Get all members for an artist
const handleGetArtistMembers = async (event, artistId) => {
  const authResult = await requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const { user } = authResult;

  try {
    console.log(`[MEMBERSHIPS] Getting members for artist: ${artistId}`, {
      platformAdmin: user.platformAdmin
    });

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
  // SEC-AUD-003: Require artist admin to add members
  const authResult = await requireArtistAdmin(event, artistId);
  if (authResult.statusCode) {
    return createResponse(authResult.statusCode, { error: authResult.error });
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
  const authResult = await requireAuth(event);
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

    const existingMembership = existingResult.Item;
    const isOwnMembership = existingMembership.user_id === user.userId;
    const isRoleChange = role !== undefined && role !== existingMembership.role;

    // Ownership is a separate lifecycle. It cannot be demoted through generic
    // membership editing; use the explicit transfer/relinquish operation.
    if (existingMembership.role === 'owner' && isRoleChange && !user.platformAdmin) {
      return createResponse(409, { error: 'Owner role must be changed through ownership transfer', code: 'OWNER_LIFECYCLE_REQUIRED' });
    }

    // SEC-AUD-003: Authorization check
    // Users can update their own membership (except role)
    // Artist admins can update any membership in their artist
    // Platform admins can update any membership
    if (!isOwnMembership && !user.platformAdmin) {
      // Check if user is admin of this artist
      const adminCheckResult = await dynamodb.query({
        TableName: MEMBERSHIPS_TABLE,
        IndexName: 'artist_id-index',
        KeyConditionExpression: 'artist_id = :artistId',
        FilterExpression: 'user_id = :userId',
        ExpressionAttributeValues: {
          ':artistId': existingMembership.artist_id,
          ':userId': user.userId
        }
      }).promise();

      const userMembership = adminCheckResult.Items?.[0];
      if (!userMembership || !['admin', 'owner'].includes(userMembership.role)) {
        console.log('[MEMBERSHIPS] Access denied - not authorized to update membership', {
          userId: user.userId.substring(0, 8) + '...',
          membershipId,
          targetUserId: existingMembership.user_id.substring(0, 8) + '...'
        });
        return createResponse(403, { error: 'Not authorized to update this membership' });
      }
    }

    // SEC-AUD-003: Prevent role escalation by non-admins
    if (isRoleChange) {
      // Only artist admins or platform admins can change roles
      if (!user.platformAdmin) {
        const adminCheckResult = await dynamodb.query({
          TableName: MEMBERSHIPS_TABLE,
          IndexName: 'artist_id-index',
          KeyConditionExpression: 'artist_id = :artistId',
          FilterExpression: 'user_id = :userId',
          ExpressionAttributeValues: {
            ':artistId': existingMembership.artist_id,
            ':userId': user.userId
          }
        }).promise();

        const userMembership = adminCheckResult.Items?.[0];
        if (!userMembership || !['admin', 'owner'].includes(userMembership.role)) {
          console.log('[MEMBERSHIPS] Access denied - cannot escalate role', {
            userId: user.userId.substring(0, 8) + '...',
            requestedRole: role
          });
          return createResponse(403, { error: 'Only artist admins or owners can change roles' });
        }
      }
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
  const authResult = await requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const { user } = authResult;

  try {
    console.log('[MEMBERSHIPS] Deleting membership', { membershipId });

    // Get membership to get artist_id and user_id for cleanup
    const membershipResult = await dynamodb.get({
      TableName: MEMBERSHIPS_TABLE,
      Key: { membership_id: membershipId }
    }).promise();

    if (!membershipResult.Item) {
      return createResponse(404, { error: 'Membership not found' });
    }

    const existingMembership = membershipResult.Item;
    const isOwnMembership = existingMembership.user_id === user.userId;

    // Never let an Artist owner accidentally orphan the entity by leaving like a
    // normal member. Ownership must be transferred or deliberately relinquished.
    if (existingMembership.role === 'owner' && !user.platformAdmin) {
      return createResponse(409, { error: 'Transfer or relinquish ownership before removing the owner membership', code: 'OWNER_LIFECYCLE_REQUIRED' });
    }

    // SEC-AUD-003: Authorization check
    // Users can delete their own membership (self-removal / leave band)
    // Artist admins can delete any membership in their artist
    // Platform admins can delete any membership
    if (!isOwnMembership && !user.platformAdmin) {
      // Check if user is admin of this artist
      const adminCheckResult = await dynamodb.query({
        TableName: MEMBERSHIPS_TABLE,
        IndexName: 'artist_id-index',
        KeyConditionExpression: 'artist_id = :artistId',
        FilterExpression: 'user_id = :userId',
        ExpressionAttributeValues: {
          ':artistId': existingMembership.artist_id,
          ':userId': user.userId
        }
      }).promise();

      const userMembership = adminCheckResult.Items?.[0];
      if (!userMembership || !['admin', 'owner'].includes(userMembership.role)) {
        console.log('[MEMBERSHIPS] Access denied - not authorized to delete membership', {
          userId: user.userId.substring(0, 8) + '...',
          membershipId,
          targetUserId: existingMembership.user_id.substring(0, 8) + '...'
        });
        return createResponse(403, { error: 'Not authorized to delete this membership' });
      }
    }

    const artistId = membershipResult.Item.artist_id;
    const userId = membershipResult.Item.user_id;

    console.log('[MEMBERSHIPS] Cleaning up votes for removed member', { artistId, userId });

    // Get all songs for this artist
    const songsResult = await dynamodb.scan({
      TableName: 'bndy-artist-songs',
      FilterExpression: 'artist_id = :artistId',
      ExpressionAttributeValues: {
        ':artistId': artistId
      }
    }).promise();

    // Remove user's votes from all songs
    const updatePromises = songsResult.Items
      .filter(song => song.votes && song.votes[userId])
      .map(song => {
        return dynamodb.update({
          TableName: 'bndy-artist-songs',
          Key: { id: song.id },
          UpdateExpression: 'REMOVE votes.#userId',
          ExpressionAttributeNames: {
            '#userId': userId
          }
        }).promise();
      });

    await Promise.all(updatePromises);

    console.log('[MEMBERSHIPS] Removed votes from', updatePromises.length, 'songs');

    // Delete member's unavailability events
    console.log('[MEMBERSHIPS] Deleting member unavailability events', { artistId, userId });

    const eventsResult = await dynamodb.query({
      TableName: 'bndy-events',
      IndexName: 'artistId-date-index',
      KeyConditionExpression: 'artistId = :artistId',
      FilterExpression: '#type = :eventType AND ownerUserId = :userId',
      ExpressionAttributeNames: {
        '#type': 'type' // 'type' is a reserved word in DynamoDB
      },
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':eventType': 'unavailable',
        ':userId': userId
      }
    }).promise();

    const deleteEventPromises = eventsResult.Items.map(event =>
      dynamodb.delete({
        TableName: 'bndy-events',
        Key: { id: event.id }
      }).promise()
    );

    await Promise.all(deleteEventPromises);
    console.log('[MEMBERSHIPS] Deleted', deleteEventPromises.length, 'unavailability events');

    // Delete membership
    await dynamodb.delete({
      TableName: MEMBERSHIPS_TABLE,
      Key: { membership_id: membershipId }
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
  const authResult = await requireAuth(event);
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

    // Batch get artist details (deduplicate artist IDs)
    const artistIds = membershipsResult.Items.map(m => m.artist_id);
    const uniqueArtistIds = [...new Set(artistIds)];
    const artistKeys = uniqueArtistIds.map(id => ({ id }));

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
            allowedEventTypes: artist.allowedEventTypes || ['practice', 'public_gig'],
            displayColour: artist.displayColour || '#f97316',
            showMemberVotes: artist.showMemberVotes || false,
            autoDiscardThreshold: artist.autoDiscardThreshold ?? null,
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

// GET /api/memberships/artist/{artistId} - Get all memberships for an artist
const handleGetArtistMemberships = async (artistId) => {
  try {
    console.log('[MEMBERSHIPS] Getting memberships for artist', { artistId });

    const result = await dynamodb.query({
      TableName: MEMBERSHIPS_TABLE,
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      ExpressionAttributeValues: {
        ':artistId': artistId
      }
    }).promise();

    console.log('[MEMBERSHIPS] Found', result.Items.length, 'memberships for artist');

    // Resolve profiles with inheritance (to get display names from user profiles)
    const resolvedMemberships = await Promise.all(
      result.Items.map(membership => resolveMembershipProfile(membership, membership.user_id))
    );

    return createResponse(200, {
      memberships: resolvedMemberships
    });

  } catch (error) {
    console.error('[MEMBERSHIPS] Get artist memberships error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

// Main handler
exports.handler = async (event, context) => {
  // Store event for CORS headers
  currentEvent = event;

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
      headers: getCorsHeaders(),
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

    if (method === 'GET' && path === '/api/memberships/all') {
      return await handleGetAllMemberships(event);
    }

    if (method === 'GET' && path.match(/\/api\/memberships\/artist\/[^/]+$/)) {
      return await handleGetArtistMemberships(artistId);
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
