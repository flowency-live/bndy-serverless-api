/**
 * CORS Utilities for Events Lambda
 *
 * Handles CORS headers and cookie parsing.
 * Refactored to accept event parameter instead of global state.
 */

// Allowed CORS origins for frontend access
const ALLOWED_ORIGINS = [
  'https://www.bndy.co.uk',       // Primary domain
  'https://backstage.bndy.co.uk', // Legacy domain
  'https://bndy.co.uk',            // Apex domain
  'https://live.bndy.co.uk',      // Frontstage
  'http://localhost:3000'          // Local development
];

/**
 * Get appropriate origin for CORS based on request origin
 * @param {Object} event - Lambda event object
 * @returns {string} Allowed origin
 */
function getAllowedOrigin(event) {
  const requestOrigin = event?.headers?.origin || event?.headers?.Origin;
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
}

/**
 * Generate CORS headers with dynamic origin
 * @param {Object} event - Lambda event object
 * @returns {Object} CORS headers
 */
function getCorsHeaders(event) {
  return {
    'Access-Control-Allow-Origin': getAllowedOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Credentials': 'true'
  };
}

/**
 * CORS headers for integration API (allows x-api-key header)
 * @returns {Object} Integration CORS headers
 */
function getIntegrationHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,x-api-key',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Credentials': 'false'
  };
}

/**
 * Parse cookies from event
 * @param {string} cookieHeader - Cookie header string
 * @returns {Object} Parsed cookies
 */
function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, value] = cookie.trim().split('=');
    cookies[name] = value;
    return cookies;
  }, {});
}

module.exports = {
  ALLOWED_ORIGINS,
  getAllowedOrigin,
  getCorsHeaders,
  getIntegrationHeaders,
  parseCookies
};
