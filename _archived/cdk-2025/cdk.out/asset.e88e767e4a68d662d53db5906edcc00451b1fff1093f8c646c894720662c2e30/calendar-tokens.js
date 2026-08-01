/**
 * Calendar Token Service
 *
 * Manages calendar subscription tokens for iCal feed authentication.
 * Tokens allow calendar apps to access feeds without session cookies.
 */

const AWS = require('aws-sdk');
const crypto = require('crypto');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

const TOKENS_TABLE = 'bndy-calendar-tokens';
const API_BASE_URL = 'https://api.bndy.co.uk';

// Single scope: shows public gigs and rehearsals only
const VALID_SCOPES = ['default'];

/**
 * Generate a new calendar token with cal_ prefix.
 * Uses UUID v4 for uniqueness.
 *
 * @returns {string} - Token in format cal_<uuid>
 */
function generateToken() {
  const uuid = crypto.randomUUID();
  return `cal_${uuid}`;
}

/**
 * Create a new calendar subscription token.
 *
 * @param {Object} params
 * @param {string} params.userId - User ID who owns this token
 * @param {string} params.artistId - Artist ID this token grants access to
 * @param {string} params.scope - Scope: 'full', 'public', or 'personal'
 * @returns {Promise<Object>} - Created token with subscription URLs
 */
async function createCalendarToken({ userId, artistId, scope }) {
  if (!VALID_SCOPES.includes(scope)) {
    throw new Error(`Invalid scope: ${scope}. Must be one of: ${VALID_SCOPES.join(', ')}`);
  }

  const token = generateToken();
  const now = new Date().toISOString();

  const tokenData = {
    token,
    userId,
    artistId,
    scope,
    createdAt: now,
    lastUsedAt: now,
    revokedAt: null
  };

  await dynamodb.put({
    TableName: TOKENS_TABLE,
    Item: tokenData
  }).promise();

  // Generate subscription URLs
  const subscriptionUrl = `${API_BASE_URL}/api/calendar/ical/${token}`;
  const webcalUrl = `webcal://api.bndy.co.uk/api/calendar/ical/${token}`;

  return {
    ...tokenData,
    subscriptionUrl,
    webcalUrl
  };
}

/**
 * Validate a calendar token.
 *
 * @param {string} token - Token to validate
 * @returns {Promise<Object|null>} - Token data if valid, null otherwise
 */
async function validateToken(token) {
  // Reject tokens without cal_ prefix
  if (!token || !token.startsWith('cal_')) {
    return null;
  }

  const result = await dynamodb.get({
    TableName: TOKENS_TABLE,
    Key: { token }
  }).promise();

  const tokenData = result.Item;

  if (!tokenData) {
    return null;
  }

  // Check if token has been revoked
  if (tokenData.revokedAt) {
    return null;
  }

  return tokenData;
}

/**
 * Get all active tokens for a user and artist.
 *
 * @param {string} userId - User ID
 * @param {string} artistId - Artist ID
 * @returns {Promise<Array>} - Array of token records
 */
async function getCalendarTokens(userId, artistId) {
  const result = await dynamodb.query({
    TableName: TOKENS_TABLE,
    IndexName: 'userId-index',
    KeyConditionExpression: 'userId = :userId',
    FilterExpression: 'artistId = :artistId AND attribute_not_exists(revokedAt)',
    ExpressionAttributeValues: {
      ':userId': userId,
      ':artistId': artistId
    }
  }).promise();

  return result.Items || [];
}

/**
 * Revoke a calendar token.
 *
 * @param {string} token - Token to revoke
 * @param {string} userId - User ID (must match token owner)
 * @returns {Promise<void>}
 */
async function revokeCalendarToken(token, userId) {
  // First, verify the token exists and belongs to this user
  const result = await dynamodb.get({
    TableName: TOKENS_TABLE,
    Key: { token }
  }).promise();

  if (!result.Item) {
    throw new Error('Token not found');
  }

  if (result.Item.userId !== userId) {
    throw new Error('Unauthorized: Token belongs to another user');
  }

  // Mark as revoked
  await dynamodb.update({
    TableName: TOKENS_TABLE,
    Key: { token },
    UpdateExpression: 'SET revokedAt = :revokedAt',
    ExpressionAttributeValues: {
      ':revokedAt': new Date().toISOString()
    }
  }).promise();
}

/**
 * Update the lastUsedAt timestamp for a token.
 * Called when the token is used to fetch a calendar feed.
 *
 * @param {string} token - Token to update
 * @returns {Promise<void>}
 */
async function updateTokenLastUsed(token) {
  await dynamodb.update({
    TableName: TOKENS_TABLE,
    Key: { token },
    UpdateExpression: 'SET lastUsedAt = :lastUsedAt',
    ExpressionAttributeValues: {
      ':lastUsedAt': new Date().toISOString()
    }
  }).promise();
}

module.exports = {
  generateToken,
  createCalendarToken,
  validateToken,
  getCalendarTokens,
  revokeCalendarToken,
  updateTokenLastUsed,
  VALID_SCOPES
};
