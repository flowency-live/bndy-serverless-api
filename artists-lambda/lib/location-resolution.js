/**
 * Location Resolution (Work Order 2026-08-30)
 *
 * Artist identity = name + location. This module handles location compatibility
 * checking for the find-or-create resolution flow.
 *
 * Rules:
 * - Same region (case-insensitive) → compatible
 * - Different region → conflict (forces review)
 * - Missing location on either side → unknown (forces review with warning)
 */

const { regionBucket } = require('./identity');

const UNKNOWN_REGION = 'unknown';

// An act that tours nationally has no home region to conflict with. Its stored
// location says so explicitly; treat it as compatible with any resolvable region
// rather than as missing (Backline finding 06/09/2026).
const NATIONAL_LOCATIONS = new Set(['uk wide', 'ukwide', 'uk touring', 'national', 'nationwide', 'touring', 'uk and europe', 'uk europe']);

function isNationalLocation(location) {
  if (!location || typeof location !== 'string') return false;
  return NATIONAL_LOCATIONS.has(location.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim());
}

/**
 * Check if two locations are compatible for artist identity matching.
 *
 * @param {string|undefined} inputLocation - Location from the incoming request
 * @param {string|undefined} candidateLocation - Location of the existing candidate
 * @returns {{
 *   compatible: boolean,
 *   inputRegion: string,
 *   candidateRegion: string,
 *   reason?: 'input_missing' | 'candidate_missing' | 'both_missing' | 'conflict'
 * }}
 */
function areLocationsCompatible(inputLocation, candidateLocation) {
  const inputRegion = regionBucket(inputLocation || '');
  const candidateRegion = regionBucket(candidateLocation || '');

  const inputMissing = !inputLocation || inputLocation.trim() === '' || inputRegion === UNKNOWN_REGION;
  const candidateMissing = !candidateLocation || candidateLocation.trim() === '' || candidateRegion === UNKNOWN_REGION;

  if (isNationalLocation(candidateLocation) && !inputMissing) {
    return { compatible: true, inputRegion, candidateRegion: 'national', reason: 'national' };
  }
  if (isNationalLocation(inputLocation) && !candidateMissing) {
    return { compatible: true, inputRegion: 'national', candidateRegion, reason: 'national' };
  }

  // Both missing
  if (inputMissing && candidateMissing) {
    return {
      compatible: false,
      inputRegion,
      candidateRegion,
      reason: 'both_missing'
    };
  }

  // Input missing
  if (inputMissing) {
    return {
      compatible: false,
      inputRegion,
      candidateRegion,
      reason: 'input_missing'
    };
  }

  // Candidate missing
  if (candidateMissing) {
    return {
      compatible: false,
      inputRegion,
      candidateRegion,
      reason: 'candidate_missing'
    };
  }

  // Both have locations - compare regions
  const compatible = inputRegion === candidateRegion;

  return {
    compatible,
    inputRegion,
    candidateRegion,
    ...(compatible ? {} : { reason: 'conflict' })
  };
}

/**
 * Calculate location score for confidence multiplier.
 *
 * @param {{ compatible: boolean, reason?: string }} compatibility
 * @returns {number} 1.0 for compatible, 0.5 for missing location, 0.0 for conflict
 */
function calculateLocationScore(compatibility) {
  if (compatibility.compatible) {
    return 1.0;
  }

  // Missing location on either side - reduce confidence but don't block
  if (compatibility.reason === 'candidate_missing' ||
      compatibility.reason === 'input_missing' ||
      compatibility.reason === 'both_missing') {
    return 0.5;
  }

  // Location conflict - block automatic matching
  return 0.0;
}

/**
 * Build audit log entry for resolution decision.
 *
 * @param {Object} params
 * @returns {Object} Structured log entry
 */
function buildResolutionAuditLog({
  inputName,
  inputLocation,
  candidateId,
  candidateName,
  candidateLocation,
  nameScore,
  locationScore,
  result,
  matchedBy
}) {
  return {
    action: 'artist_resolution',
    timestamp: new Date().toISOString(),
    inputName,
    inputLocation: inputLocation || null,
    candidateId: candidateId || null,
    candidateName: candidateName || null,
    candidateLocation: candidateLocation || null,
    nameScore,
    locationScore,
    result,
    matchedBy: matchedBy || null,
    resolverVersion: '2.0'
  };
}

module.exports = {
  isNationalLocation,
  areLocationsCompatible,
  calculateLocationScore,
  buildResolutionAuditLog
};
