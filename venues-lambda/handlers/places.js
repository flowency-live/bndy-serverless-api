/**
 * Google Places Proxy Handlers
 *
 * B1: Places proxy endpoints for the community gig wizard.
 * Proxies Google Places Autocomplete (suggest) and Place Details (details) APIs.
 *
 * Routes:
 * - GET /api/places/suggest?q=query → { suggestions: [{ placeId, name, address }] }
 * - GET /api/places/details?placeId=xxx → { place: { placeId, name, address, city, lat, lng } }
 *
 * Security: No auth required (public community feature), rate-limited via WAF (B7).
 */

'use strict';

const { Client, PlaceType1 } = require('@googlemaps/google-maps-services-js');

const placesClient = new Client({});

/**
 * Venue-type filtering (Addendum G). DENYLIST, deliberately NOT an allowlist:
 * bndy's real venues include social clubs, memorial halls, village halls and
 * yacht clubs that Google types as bare establishment/point_of_interest —
 * an allowlist of "bars and clubs" would reject them. We drop only the
 * unambiguous non-venues, and soft-warn on ambiguous ones (schools etc.)
 * so the wizard's confirm card can nudge without blocking.
 */
const HARD_DENY = new Set([
  'doctor', 'dentist', 'hospital', 'physiotherapist', 'pharmacy', 'drugstore', 'veterinary_care',
  'car_dealer', 'car_rental', 'car_repair', 'car_wash', 'gas_station',
  'bank', 'atm', 'accounting', 'insurance_agency', 'lawyer', 'real_estate_agency',
  'supermarket', 'grocery_or_supermarket', 'convenience_store', 'hardware_store',
  'home_goods_store', 'furniture_store', 'electronics_store', 'clothing_store',
  'shoe_store', 'jewelry_store', 'laundry', 'moving_company', 'storage',
  'plumber', 'electrician', 'locksmith', 'roofing_contractor',
  'funeral_home', 'cemetery', 'courthouse', 'police', 'fire_station', 'embassy', 'post_office',
  'airport', 'train_station', 'bus_station', 'transit_station', 'subway_station', 'taxi_stand',
  'parking', 'travel_agency',
]);

/** Ambiguous types → human label for the confirm-card caution. Do NOT add church/
 *  library/museum/gym/stadium here — all host gigs in the real bndy estate. */
const SOFT_WARN = new Map([
  ['school', 'a school'],
  ['primary_school', 'a school'],
  ['secondary_school', 'a school'],
  ['university', 'a university'],
  ['local_government_office', 'a council office'],
]);

function isHardDenied(types) {
  return Array.isArray(types) && types.some((t) => HARD_DENY.has(t));
}
function softWarnLabel(types) {
  if (!Array.isArray(types)) return undefined;
  for (const t of types) {
    if (SOFT_WARN.has(t)) return SOFT_WARN.get(t);
  }
  return undefined;
}

// Simple in-memory cache (60s TTL per spec)
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value) {
  // Prevent unbounded growth - clear oldest entries if > 500
  if (cache.size > 500) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  cache.set(key, { value, ts: Date.now() });
}

/**
 * GET /api/places/suggest?q=query
 *
 * Returns venue suggestions from Google Places Autocomplete, UK-biased.
 *
 * @param {Object} deps - { getCorsHeaders }
 * @param {Object} event - Lambda event
 * @returns {Promise<Object>} { statusCode, headers, body: { suggestions: [...] } }
 */
async function handlePlacesSuggest(deps, event) {
  const { getCorsHeaders } = deps;

  const query = event.queryStringParameters?.q;
  if (!query || query.trim().length < 2) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Query parameter "q" required (min 2 chars)' })
    };
  }

  // kind=town → UK towns/cities (artist "based in" lookup); default → venues (establishments)
  const kind = event.queryStringParameters?.kind === 'town' ? 'town' : 'venue';
  const trimmedQuery = query.trim();
  const cacheKey = `suggest:${kind}:${trimmedQuery.toLowerCase()}`;

  // Check cache
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[Places] Cache hit for suggest: "${trimmedQuery}"`);
    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ suggestions: cached })
    };
  }

  console.log(`[Places] Autocomplete request: "${trimmedQuery}"`);

  try {
    const response = await placesClient.placeAutocomplete({
      params: {
        input: trimmedQuery,
        types: kind === 'town' ? '(cities)' : 'establishment',
        components: ['country:gb'], // UK-biased per spec
        key: process.env.GOOGLE_PLACES_API_KEY,
        // Session token for billing optimization (Google charges per session, not per keystroke)
        sessiontoken: event.queryStringParameters?.sessionToken || undefined
      }
    });

    if (response.data.status !== 'OK' && response.data.status !== 'ZERO_RESULTS') {
      console.error(`[Places] Autocomplete error: ${response.data.status} - ${response.data.error_message || 'unknown'}`);
      return {
        statusCode: 502,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'Google Places API error', status: response.data.status })
      };
    }

    const suggestions = (response.data.predictions || [])
      .filter(p => kind === 'town' || !isHardDenied(p.types)) // venue mode: drop unambiguous non-venues
      .map(p => ({
        placeId: p.place_id,
        name: p.structured_formatting?.main_text || p.description.split(',')[0],
        address: p.structured_formatting?.secondary_text || p.description
      }));

    // Cache result
    setCache(cacheKey, suggestions);

    console.log(`[Places] Returning ${suggestions.length} suggestions for: "${trimmedQuery}"`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ suggestions })
    };

  } catch (error) {
    console.error(`[Places] Autocomplete exception:`, error.message);
    return {
      statusCode: 502,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Places service unavailable' })
    };
  }
}

/**
 * GET /api/places/details?placeId=xxx
 *
 * Returns full place details for a given Google Place ID.
 *
 * @param {Object} deps - { getCorsHeaders }
 * @param {Object} event - Lambda event
 * @returns {Promise<Object>} { statusCode, headers, body: { place: {...} } }
 */
async function handlePlacesDetails(deps, event) {
  const { getCorsHeaders } = deps;

  const placeId = event.queryStringParameters?.placeId;
  if (!placeId || placeId.trim().length === 0) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Query parameter "placeId" required' })
    };
  }

  const trimmedPlaceId = placeId.trim();
  const cacheKey = `details:${trimmedPlaceId}`;

  // Check cache
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[Places] Cache hit for details: ${trimmedPlaceId}`);
    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ place: cached })
    };
  }

  console.log(`[Places] Details request: ${trimmedPlaceId}`);

  try {
    const response = await placesClient.placeDetails({
      params: {
        place_id: trimmedPlaceId,
        fields: ['place_id', 'name', 'formatted_address', 'address_components', 'geometry', 'types'],
        key: process.env.GOOGLE_PLACES_API_KEY,
        sessiontoken: event.queryStringParameters?.sessionToken || undefined
      }
    });

    if (response.data.status !== 'OK') {
      console.error(`[Places] Details error: ${response.data.status} - ${response.data.error_message || 'unknown'}`);

      if (response.data.status === 'NOT_FOUND' || response.data.status === 'INVALID_REQUEST') {
        return {
          statusCode: 404,
          headers: getCorsHeaders(event),
          body: JSON.stringify({ error: 'Place not found' })
        };
      }

      return {
        statusCode: 502,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'Google Places API error', status: response.data.status })
      };
    }

    const result = response.data.result;

    // Belt and braces: a denied suggestion never reaches details via the wizard,
    // but direct placeId calls exist — reject unambiguous non-venues here too.
    if (isHardDenied(result.types)) {
      console.log(`[Places] Denied non-venue place type for: ${result.name} (${(result.types || []).join(',')})`);
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'not a venue' })
      };
    }

    // Extract city from address_components
    const addressComponents = result.address_components || [];
    const cityComponent = addressComponents.find(c =>
      c.types.includes('postal_town') || c.types.includes('locality')
    );
    const city = cityComponent?.long_name || '';

    const typeWarning = softWarnLabel(result.types);
    const place = {
      placeId: result.place_id,
      name: result.name || '',
      address: result.formatted_address || '',
      city: city,
      lat: result.geometry?.location?.lat || 0,
      lng: result.geometry?.location?.lng || 0,
      ...(typeWarning ? { typeWarning } : {})
    };

    // Cache result
    setCache(cacheKey, place);

    console.log(`[Places] Returning details for: ${place.name} (${place.city})`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ place })
    };

  } catch (error) {
    console.error(`[Places] Details exception:`, error.message);
    return {
      statusCode: 502,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Places service unavailable' })
    };
  }
}

module.exports = {
  handlePlacesSuggest,
  handlePlacesDetails
};
