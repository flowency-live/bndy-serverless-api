/**
 * Authentication Utilities for Events Lambda
 *
 * Handles JWT verification, session management, and membership checks.
 * Dependencies injected via deps object for testability.
 */

const jwt = require('jsonwebtoken');
const { parseCookies } = require('./cors');

// Configuration
const USERS_TABLE = 'bndy-users';
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';

// JWT Secret - cached after first retrieval
let JWT_SECRET = null;

/**
 * Get JWT secret from SSM Parameter Store with fallback to env var
 * @param {Object} ssm - AWS SSM client
 * @returns {Promise<string>} JWT secret
 */
async function getJWTSecret(ssm) {
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
    console.log('[EVENTS] JWT_SECRET loaded from SSM');
    return JWT_SECRET;
  } catch (error) {
    console.error('[EVENTS] Failed to get JWT_SECRET from SSM:', error.message);
    // Fallback to environment variable
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      console.log('[EVENTS] JWT_SECRET loaded from environment variable (fallback)');
      return JWT_SECRET;
    }
    throw new Error('JWT_SECRET not available from SSM or environment');
  }
}

/**
 * Authentication middleware
 * @param {Object} deps - Dependencies { ssm, dynamodb, getCorsHeaders }
 * @param {Object} event - Lambda event
 * @returns {Promise<Object>} { user } on success, { statusCode, headers, body } on failure
 */
async function requireAuth(deps, event) {
  const { ssm, dynamodb, getCorsHeaders } = deps;

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

  if (!sessionToken) {
    return {
      statusCode: 401,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Not authenticated' })
    };
  }

  try {
    const jwtSecret = await getJWTSecret(ssm);
    const session = jwt.verify(sessionToken, jwtSecret);

    // Fetch user to check platformAdmin flag
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: session.userId }
    }).promise();

    const platformAdmin = userResult.Item?.platformAdmin || false;

    return {
      user: {
        ...session,
        platformAdmin
      }
    };
  } catch (error) {
    console.error('AUTH: Invalid session token:', error.message);
    return {
      statusCode: 401,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Invalid session' })
    };
  }
}

/**
 * Verify user is member of artist
 * @param {Object} dynamodb - DynamoDB DocumentClient
 * @param {string} userId - User ID
 * @param {string} artistId - Artist ID
 * @returns {Promise<Object|null>} Membership record or null
 */
async function verifyMembership(dynamodb, userId, artistId) {
  const result = await dynamodb.query({
    TableName: MEMBERSHIPS_TABLE,
    IndexName: 'user_id-index',
    KeyConditionExpression: 'user_id = :userId',
    FilterExpression: 'artist_id = :artistId',
    ExpressionAttributeValues: {
      ':userId': userId,
      ':artistId': artistId
    }
  }).promise();

  return result.Items && result.Items.length > 0 ? result.Items[0] : null;
}

/**
 * Validate API key from request headers
 * @param {Object} event - Lambda event
 * @returns {boolean} True if valid API key present
 */
function validateApiKey(event) {
  const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'];
  if (!apiKey) return false;
  const validKeys = (process.env.INTEGRATION_API_KEYS || '').split(',').filter(Boolean);
  return validKeys.includes(apiKey);
}

/**
 * Reset JWT secret cache (for testing)
 */
function resetJWTCache() {
  JWT_SECRET = null;
}

module.exports = {
  getJWTSecret,
  requireAuth,
  verifyMembership,
  validateApiKey,
  resetJWTCache,
  USERS_TABLE,
  MEMBERSHIPS_TABLE
};
