/**
 * Fuzzy Matching Utilities for Venue Deduplication
 *
 * Pure functions for string similarity, geolocation distance, and token overlap.
 * Used by venue-deduplication.js for multi-level matching.
 */

// Common stop words to ignore in venue search
const STOP_WORDS = ['the', 'a', 'an'];

/**
 * Normalize string for search by removing stop words
 * @param {string} str - Input string
 * @returns {string} Normalized string
 */
function normalizeForSearch(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(/\s+/)
    .filter(word => !STOP_WORDS.includes(word))
    .join(' ')
    .trim();
}

/**
 * Check if two lat/lng coordinates are within specified distance in meters
 * Uses Haversine formula for great-circle distance
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lng1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lng2 - Longitude of point 2
 * @param {number} meters - Maximum distance in meters
 * @returns {boolean} True if within distance
 */
function isWithinDistance(lat1, lng1, lat2, lng2, meters) {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;
  return distance <= meters;
}

/**
 * Levenshtein distance algorithm for string comparison
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Edit distance between strings
 */
function levenshteinDistance(str1, str2) {
  const matrix = [];
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[str2.length][str1.length];
}

/**
 * Calculate string similarity percentage using Levenshtein distance
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} Similarity percentage (0-100)
 */
function calculateSimilarity(str1, str2) {
  const distance = levenshteinDistance(str1.toLowerCase(), str2.toLowerCase());
  const maxLength = Math.max(str1.length, str2.length);
  return ((maxLength - distance) / maxLength) * 100;
}

/**
 * Calculate address overlap percentage using token-based Jaccard similarity
 * @param {string} addr1 - First address
 * @param {string} addr2 - Second address
 * @returns {number} Overlap percentage (0-100)
 */
function calculateAddressOverlap(addr1, addr2) {
  const tokens1 = new Set(addr1.toLowerCase().split(/[\s,]+/));
  const tokens2 = new Set(addr2.toLowerCase().split(/[\s,]+/));
  const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);
  return (intersection.size / union.size) * 100;
}

module.exports = {
  STOP_WORDS,
  normalizeForSearch,
  isWithinDistance,
  levenshteinDistance,
  calculateSimilarity,
  calculateAddressOverlap
};
