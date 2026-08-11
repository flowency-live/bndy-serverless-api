/**
 * Venue Admission Validation (RUNBOOK §0.23)
 *
 * Enforces: "No fixed building, no venue"
 *
 * Rejects venue creates/edits where the resolved Google Place is not a
 * building — i.e., it's a city, town, street, or other geographic area.
 *
 * This gate is for clear-cut cases only. Parks and fields with genuine
 * Google place_ids are accepted because the caller made a deliberate choice.
 */

'use strict';

/**
 * Place types that represent geographic areas, not buildings.
 * If a place's types include ANY of these, it's not a venue.
 */
const LOCALITY_TYPES = new Set([
  'locality',
  'postal_town',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'administrative_area_level_3',
  'administrative_area_level_4',
  'sublocality',
  'sublocality_level_1',
  'sublocality_level_2',
  'sublocality_level_3',
  'sublocality_level_4',
  'sublocality_level_5',
  'route',
  'neighborhood',
  'political',
  'country',
  'continent'
]);

/**
 * Check if the place types indicate a locality (city/town/area) rather than a building.
 *
 * @param {string[]|null|undefined} types - Google Places types array
 * @returns {boolean} True if this is a locality type (should be rejected)
 */
function isLocalityType(types) {
  if (!Array.isArray(types) || types.length === 0) {
    return false;
  }
  return types.some(t => LOCALITY_TYPES.has(t));
}

/**
 * Check if the venue name is just the address with no real premises indicators.
 *
 * This catches cases like "Derby, UK" where:
 * - The name equals the address stripped of ", UK" / ", United Kingdom"
 * - There's no postcode in the address
 * - There's no street number in the address
 *
 * @param {string} name - Venue name
 * @param {string} address - Formatted address from Google
 * @param {Object[]} addressComponents - Google address_components array
 * @returns {boolean} True if this looks like an address-only name (should be rejected)
 */
function isAddressOnlyName(name, address, addressComponents) {
  const components = Array.isArray(addressComponents) ? addressComponents : [];

  // Check for postcode - if present, this is a real address
  const hasPostcode = components.some(c =>
    Array.isArray(c.types) && c.types.includes('postal_code')
  );
  if (hasPostcode) {
    return false;
  }

  // Check for street number - if present, this is a real address
  const hasStreetNumber = components.some(c =>
    Array.isArray(c.types) && c.types.includes('street_number')
  );
  if (hasStreetNumber) {
    return false;
  }

  // Strip UK suffixes from address
  const strippedAddress = (address || '')
    .replace(/,\s*United Kingdom\s*$/i, '')
    .replace(/,\s*UK\s*$/i, '')
    .trim();

  // Compare name to stripped address (case-insensitive)
  const normalizedName = (name || '').trim().toLowerCase();
  const normalizedAddress = strippedAddress.toLowerCase();

  return normalizedName === normalizedAddress;
}

/**
 * Validate whether a Google Place represents a valid venue (a building).
 *
 * @param {Object} placeData - Google Places result with types, name, formatted_address, address_components
 * @returns {{ valid: boolean, code?: string, reason?: string }}
 */
function validateVenueAdmission(placeData) {
  const types = placeData?.types || [];
  const name = placeData?.name || '';
  const address = placeData?.formatted_address || '';
  const addressComponents = placeData?.address_components || [];

  // Rule 1: Reject locality types (cities, towns, streets, etc.)
  if (isLocalityType(types)) {
    const matchedTypes = types.filter(t => LOCALITY_TYPES.has(t));
    return {
      valid: false,
      code: 'LOCALITY_NOT_VENUE',
      reason: `Place type "${matchedTypes[0]}" indicates a geographic area, not a building. ` +
              `Venues must have a fixed premises. Types: [${types.join(', ')}]`
    };
  }

  // Rule 2: Reject address-only names with no postcode/street number
  // (catches "Derby, UK" style records that slip through type checks)
  if (isAddressOnlyName(name, address, addressComponents)) {
    return {
      valid: false,
      code: 'ADDRESS_ONLY_NAME',
      reason: `Venue name "${name}" appears to be a location name, not a premises name. ` +
              `No postcode or street number found in address. ` +
              `Address: "${address}"`
    };
  }

  // Valid venue
  return { valid: true };
}

module.exports = {
  LOCALITY_TYPES: Array.from(LOCALITY_TYPES), // Export as array for tests
  isLocalityType,
  isAddressOnlyName,
  validateVenueAdmission
};
