/**
 * Google Places API Integration
 *
 * Handles venue lookup via Google Places API.
 * Used for geocoding and venue verification.
 */

const { Client, PlaceInputType } = require('@googlemaps/google-maps-services-js');

// Google Places API client
const placesClient = new Client({});

/**
 * Validate API key from request headers
 * Keys are stored in INTEGRATION_API_KEYS env var (comma-separated)
 * @param {Object} event - Lambda event object
 * @returns {boolean} True if valid API key present
 */
function validateApiKey(event) {
  const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'];
  if (!apiKey) return false;

  const validKeys = (process.env.INTEGRATION_API_KEYS || '').split(',').filter(Boolean);
  return validKeys.includes(apiKey);
}

/**
 * Search Google Places API for a venue by name and city
 * Returns place details or null if not found
 * @param {string} name - Venue name
 * @param {string} city - City name
 * @returns {Promise<{placeId: string, name: string, address: string, latitude: number, longitude: number, types?: string[], addressComponents?: Object[]}|null>}
 */
async function findPlaceFromGoogle(name, city) {
  const query = `${name}, ${city}`;
  console.log(`[Integration] Searching Google Places for: "${query}"`);

  try {
    const response = await placesClient.findPlaceFromText({
      params: {
        input: query,
        inputtype: PlaceInputType.textQuery,
        fields: ['place_id', 'name', 'formatted_address', 'geometry', 'types'],
        key: process.env.GOOGLE_PLACES_API_KEY,
      },
    });

    if (response.data.status !== 'OK' || !response.data.candidates?.length) {
      console.log(`[Integration] No Google Places results for: "${query}"`);
      return null;
    }

    const place = response.data.candidates[0];

    if (!place.place_id || !place.geometry?.location) {
      console.log(`[Integration] Incomplete place data for: "${query}"`);
      return null;
    }

    // Fetch place details to get address_components (needed for venue admission validation)
    const detailsResponse = await placesClient.placeDetails({
      params: {
        place_id: place.place_id,
        fields: ['address_component', 'type'],
        key: process.env.GOOGLE_PLACES_API_KEY,
      },
    });

    const addressComponents = detailsResponse.data.result?.address_components || [];
    // Merge types from both calls (findPlace returns types, details may add more)
    const types = place.types || detailsResponse.data.result?.types || [];

    const result = {
      placeId: place.place_id,
      name: place.name || name,
      address: place.formatted_address || '',
      latitude: place.geometry.location.lat,
      longitude: place.geometry.location.lng,
      types,
      addressComponents,
    };

    console.log(`[Integration] Found place: ${result.name} (${result.placeId}), types: [${types.join(', ')}]`);
    return result;
  } catch (error) {
    console.error(`[Integration] Google Places API error:`, error.message);
    throw error;
  }
}

/**
 * Fetch place details from Google Places API by place_id
 * Used for venue admission validation when place_id is provided directly
 * @param {string} placeId - Google place_id
 * @returns {Promise<{types: string[], name: string, address: string, addressComponents: Object[]}|null>}
 */
async function getPlaceDetails(placeId) {
  console.log(`[Places] Fetching details for place_id: ${placeId}`);

  try {
    const response = await placesClient.placeDetails({
      params: {
        place_id: placeId,
        fields: ['name', 'formatted_address', 'type', 'address_component'],
        key: process.env.GOOGLE_PLACES_API_KEY,
      },
    });

    if (response.data.status !== 'OK' || !response.data.result) {
      console.log(`[Places] No place details found for: ${placeId}`);
      return null;
    }

    const place = response.data.result;
    return {
      name: place.name || '',
      address: place.formatted_address || '',
      types: place.types || [],
      addressComponents: place.address_components || [],
    };
  } catch (error) {
    console.error(`[Places] Place details API error:`, error.message);
    throw error;
  }
}

module.exports = {
  validateApiKey,
  findPlaceFromGoogle,
  getPlaceDetails,
  placesClient // Export for any code that needs direct access
};
