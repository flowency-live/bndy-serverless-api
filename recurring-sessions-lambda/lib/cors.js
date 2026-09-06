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
  'https://gigs.bndy.co.uk',      // Gigs
  'https://bndy.live',             // Public maps domain
  'https://stage.bndy.live',       // Backstage domain
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
 * CORS is now handled by API Gateway CorsConfiguration in template.yaml
 * Lambda should NOT set Access-Control-Allow-Origin to avoid conflicts
 * @param {Object} event - Lambda event object
 * @returns {Object} CORS headers
 */
function getCorsHeaders(event) {
  return {
    'Content-Type': 'application/json'
  };
}

/**
 * CORS headers for integration API
 * CORS is now handled by API Gateway CorsConfiguration in template.yaml
 * Lambda should NOT set Access-Control-Allow-Origin to avoid conflicts
 * @returns {Object} Integration headers
 */
function getIntegrationHeaders() {
  return {
    'Content-Type': 'application/json'
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
