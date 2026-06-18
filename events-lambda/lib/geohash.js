/**
 * Geohash Utilities for Events Lambda
 *
 * Handles geohash computation for venue locations.
 */

const ngeohash = require('ngeohash');

/**
 * Compute geohash fields from venue location
 * @param {Object} venue - Venue with latitude/longitude
 * @returns {Object} Geohash fields {geohash6, geohash4, geoLat, geoLng}
 */
function computeGeohashFields(venue) {
  if (!venue || !venue.latitude || !venue.longitude) {
    return {
      geohash6: null,
      geohash4: null,
      geoLat: null,
      geoLng: null
    };
  }

  return {
    geohash6: ngeohash.encode(venue.latitude, venue.longitude, 6),
    geohash4: ngeohash.encode(venue.latitude, venue.longitude, 4),
    geoLat: venue.latitude,
    geoLng: venue.longitude
  };
}

/**
 * Get neighboring geohashes for geo queries
 * @param {string} geohash - Center geohash
 * @returns {Array<string>} Array of neighboring geohashes
 */
function getGeohashNeighbors(geohash) {
  if (!geohash) return [];
  return ngeohash.neighbors(geohash);
}

module.exports = {
  computeGeohashFields,
  getGeohashNeighbors
};
