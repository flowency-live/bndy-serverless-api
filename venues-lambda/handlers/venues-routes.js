/**
 * Venues Route Handlers
 *
 * HTTP handlers for venue CRUD operations.
 * Each handler receives deps object for dependency injection (dynamodb, lambda, getCorsHeaders).
 */

const { normalizeForSearch, calculateSimilarity } = require('../lib/fuzzy-matcher');
const { computeGeohashFields, cascadeLocationToEvents } = require('../lib/geohash');
const { findPlaceFromGoogle, getPlaceDetails } = require('../lib/google-places');
const { formatVenueResponse, triggerVenueEnrichment } = require('../lib/venue-deduplication');
const { validateVenueAdmission } = require('../lib/venue-admission');
const { jsonResponse } = require('../lib/http-response');
const { scanAll } = require('../lib/scan-all');
const { venuePlaceKey } = require('../lib/identity');
const { gatedPut, releaseUniqueKeys, duplicateResponseBody } = require('../lib/unique-gate');

/**
 * GET /api/venues - Get all venues with optional search
 */
async function handleGetAllVenues(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;

  console.log('[Venues] Venues Lambda: Scanning all venues from DynamoDB...');

  // Check for search query parameter
  const searchTerm = event.queryStringParameters?.search;

  const params = {
    TableName: 'bndy-venues'
  };

  try {
    const allItems = await scanAll(dynamodb, params);

    // Filter venues with valid coordinates (like the PostgreSQL query)
    // Feature 4: hidden venues never reach a public list.
    let validVenues = allItems.filter(venue =>
      venue.latitude && venue.longitude &&
      venue.latitude !== 0 && venue.longitude !== 0 &&
      venue.hidden !== true
    );

    // If search term provided, filter by name or address (with stop word normalization)
    if (searchTerm) {
      const normalizedSearch = normalizeForSearch(searchTerm);
      console.log(`[Venues] Venues Lambda: Search term "${searchTerm}" normalized to "${normalizedSearch}"`);

      validVenues = validVenues.filter(venue => {
        const normalizedName = normalizeForSearch(venue.name);
        const normalizedAddress = normalizeForSearch(venue.address);

        // Check name variants (alternative names) as well
        const nameVariants = venue.name_variants || [];
        const normalizedVariants = nameVariants.map(variant => normalizeForSearch(variant));
        const matchesVariant = normalizedVariants.some(variant => variant.includes(normalizedSearch));

        // Match if normalized search is found in name, address, or any name variant
        return normalizedName.includes(normalizedSearch) ||
               normalizedAddress.includes(normalizedSearch) ||
               matchesVariant;
      });

      console.log(`[Venues] Venues Lambda: Search for "${searchTerm}" returned ${validVenues.length} results`);
    }

    // NOTE: per-venue event COUNT queries removed (N+1 - one query per venue
    // per request; measured 10.8s at 1,417 venues). No consumer reads eventCount
    // from this endpoint. If a count is ever needed, maintain a counter
    // attribute on the venue at event create/delete.

    // Transform to match expected API format
    const formattedVenues = validVenues.map(venue => ({
      id: venue.id,
      name: venue.name,
      address: venue.address,
      city: venue.city || null,
      latitude: venue.latitude,
      longitude: venue.longitude,
      location: venue.location_object || { lat: venue.latitude, lng: venue.longitude },
      googlePlaceId: venue.google_place_id,
      website: venue.website || '',
      validated: venue.validated || false,
      nameVariants: venue.name_variants || [],
      phone: venue.phone || '',
      postcode: venue.postcode || '',
      facilities: venue.facilities || [],
      socialMediaUrls: venue.social_media_urls || [],
      profileImageUrl: venue.profile_image_url || null,
      externalIds: venue.external_ids || [],
      standardTicketed: venue.standard_ticketed || false,
      standardTicketInformation: venue.standard_ticket_information || '',
      standardTicketUrl: venue.standard_ticket_url || '',
      enrichment_status: venue.enrichment_status,
      enrichment_date: venue.enrichment_date,
      ai_created: venue.ai_created,
      needs_review: venue.needs_review,
      created_source: venue.created_source
    }));

    console.log(`[Venues] Venues Lambda: Served ${formattedVenues.length} venues (${allItems.length} total in DB)`);

    return jsonResponse(event, 200, formattedVenues, {
      corsHeaders: getCorsHeaders(event),
      cacheControl: 'public, max-age=60'
    });
  } catch (error) {
    console.error('[ERROR] DynamoDB scan failed:', error);
    throw error;
  }
}

/**
 * GET /api/venues/list - MCP list venues endpoint (paginated with filters)
 */
async function handleListVenuesMcp(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const queryParams = event.queryStringParameters || {};

  // Known parameter names - reject any unknown ones to prevent silent filter failures
  const KNOWN_PARAMS = new Set([
    'limit', 'offset',
    'missingSocials', 'missingAddress', 'missingCity', 'missingCoordinates',
    'region', 'city', 'createdSince', 'aiCreated'
  ]);
  const unknownParams = Object.keys(queryParams).filter(p => !KNOWN_PARAMS.has(p));
  if (unknownParams.length > 0) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        error: `Unknown parameter(s): ${unknownParams.join(', ')}`,
        knownParameters: Array.from(KNOWN_PARAMS),
        message: 'Unknown parameters are rejected to prevent silent filter failures. Check parameter names.'
      })
    };
  }

  // Parse pagination params
  const limit = Math.min(parseInt(queryParams.limit) || 100, 500);
  const offset = parseInt(queryParams.offset) || 0;

  // Parse filter params
  const missingSocials = queryParams.missingSocials === 'true';
  const missingAddress = queryParams.missingAddress === 'true';
  const missingCity = queryParams.missingCity === 'true';
  const missingCoordinates = queryParams.missingCoordinates === 'true';
  const region = queryParams.region || null;
  const city = queryParams.city || null;
  const createdSince = queryParams.createdSince || null;
  const aiCreated = queryParams.aiCreated === 'true' ? true : (queryParams.aiCreated === 'false' ? false : null);

  console.log(`[MCP_LIST_VENUES] Listing venues - limit: ${limit}, offset: ${offset}, filters: missingSocials=${missingSocials}, missingAddress=${missingAddress}, missingCity=${missingCity}, missingCoordinates=${missingCoordinates}, region=${region}, city=${city}, aiCreated=${aiCreated}`);

  try {
    // Build filter expressions for DynamoDB scan
    const filterExpressions = [];
    const expressionAttributeNames = {
      '#name': 'name'
    };
    const expressionAttributeValues = {};

    // Filter: missingSocials - no website or social media
    if (missingSocials) {
      filterExpressions.push('(attribute_not_exists(website) OR website = :emptyStr) AND (attribute_not_exists(social_media_urls) OR size(social_media_urls) = :zero)');
      expressionAttributeValues[':emptyStr'] = '';
      expressionAttributeValues[':zero'] = 0;
    }

    // Filter: missingAddress
    if (missingAddress) {
      filterExpressions.push('(attribute_not_exists(address) OR address = :emptyStr2)');
      expressionAttributeValues[':emptyStr2'] = '';
    }

    // Filter: missingCity
    if (missingCity) {
      filterExpressions.push('(attribute_not_exists(city) OR city = :emptyStr3)');
      expressionAttributeValues[':emptyStr3'] = '';
    }

    // Filter: missingCoordinates
    if (missingCoordinates) {
      filterExpressions.push('(attribute_not_exists(latitude) OR attribute_not_exists(longitude) OR latitude = :zeroNum OR longitude = :zeroNum)');
      expressionAttributeValues[':zeroNum'] = 0;
    }

    // Filter: region - address or city contains region string
    if (region) {
      filterExpressions.push('(contains(address, :region) OR contains(city, :region))');
      expressionAttributeValues[':region'] = region;
    }

    // Filter: city - exact city match
    if (city) {
      filterExpressions.push('city = :city');
      expressionAttributeValues[':city'] = city;
    }

    // Filter: createdSince
    if (createdSince) {
      filterExpressions.push('createdAt >= :createdSince');
      expressionAttributeValues[':createdSince'] = createdSince;
    }

    // Filter: aiCreated
    if (aiCreated !== null) {
      filterExpressions.push('ai_created = :aiCreated');
      expressionAttributeValues[':aiCreated'] = aiCreated;
    }

    // Build scan params
    const scanParams = {
      TableName: 'bndy-venues',
      ProjectionExpression: 'id, #name, address, city, postcode, latitude, longitude, website, phone, social_media_urls, facilities, profile_image_url, standard_ticketed, standard_ticket_information, standard_ticket_url, ai_created, needs_review, created_source, external_ids, claimedByUserId, createdAt, updatedAt',
      ExpressionAttributeNames: expressionAttributeNames
    };

    if (filterExpressions.length > 0) {
      scanParams.FilterExpression = filterExpressions.join(' AND ');
      scanParams.ExpressionAttributeValues = expressionAttributeValues;
    }

    // Scan all items (for filtering - DynamoDB requires full scan for complex filters)
    const allItems = [];
    let lastEvaluatedKey = null;

    do {
      if (lastEvaluatedKey) {
        scanParams.ExclusiveStartKey = lastEvaluatedKey;
      }
      const result = await dynamodb.scan(scanParams).promise();
      if (result && result.Items) {
        allItems.push(...result.Items);
      }
      lastEvaluatedKey = result?.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    // Apply pagination in memory
    const totalCount = allItems.length;
    const paginatedItems = allItems.slice(offset, offset + limit);

    // Transform to API format
    const formattedVenues = paginatedItems.map(venue => ({
      id: venue.id,
      name: venue.name,
      address: venue.address || '',
      city: venue.city || '',
      postcode: venue.postcode || '',
      latitude: venue.latitude || null,
      longitude: venue.longitude || null,
      website: venue.website || '',
      phone: venue.phone || '',
      socialMediaUrls: venue.social_media_urls || [],
      facilities: venue.facilities || [],
      profileImageUrl: venue.profile_image_url || '',
      standardTicketed: venue.standard_ticketed || false,
      standardTicketInformation: venue.standard_ticket_information || '',
      standardTicketUrl: venue.standard_ticket_url || '',
      externalIds: venue.external_ids || [],
      isClaimed: !!venue.claimedByUserId,
      aiCreated: venue.ai_created || false,
      needsReview: venue.needs_review || false,
      createdSource: venue.created_source || null,
      createdAt: venue.createdAt || null,
      updatedAt: venue.updatedAt || null
    }));

    console.log(`[MCP_LIST_VENUES] Returning ${formattedVenues.length} of ${totalCount} total venues`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        venues: formattedVenues,
        pagination: {
          count: totalCount,
          returned: formattedVenues.length,
          offset: offset,
          limit: limit,
          hasMore: offset + limit < totalCount
        }
      })
    };
  } catch (error) {
    console.error('[MCP_LIST_VENUES] Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

/**
 * GET /api/venues/:id - Get venue by ID
 */
async function handleGetVenueById(deps, venueId, event) {
  const { dynamodb, getCorsHeaders } = deps;

  console.log(`[Venues] Venues Lambda: Getting venue by ID: ${venueId}`);

  const params = {
    TableName: 'bndy-venues',
    Key: { id: venueId }
  };

  try {
    const result = await dynamodb.get(params).promise();

    if (!result.Item) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'Venue not found' })
      };
    }

    // Feature 4: a hidden venue is off every public surface.
    // The router sets __allowHidden after a platform-admin check.
    if (result.Item.hidden === true && !event.__allowHidden) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'Venue not found', code: 'HIDDEN' })
      };
    }

    // Transform to match expected API format
    const venue = {
      id: result.Item.id,
      name: result.Item.name,
      address: result.Item.address,
      city: result.Item.city || null,
      latitude: result.Item.latitude,
      longitude: result.Item.longitude,
      location: result.Item.location_object || { lat: result.Item.latitude, lng: result.Item.longitude },
      googlePlaceId: result.Item.google_place_id,
      website: result.Item.website || '',
      validated: result.Item.validated || false,
      nameVariants: result.Item.name_variants || [],
      phone: result.Item.phone || '',
      postcode: result.Item.postcode || '',
      profileImageUrl: result.Item.profile_image_url,
      facilities: result.Item.facilities || [],
      socialMediaUrls: result.Item.social_media_urls || [],
      externalIds: result.Item.external_ids || [],
      standardTicketed: result.Item.standard_ticketed || false,
      standardTicketInformation: result.Item.standard_ticket_information || '',
      standardTicketUrl: result.Item.standard_ticket_url || '',
      enrichment_status: result.Item.enrichment_status,
      enrichment_data: result.Item.enrichment_data,
      enrichment_date: result.Item.enrichment_date,
      ai_created: result.Item.ai_created,
      needs_review: result.Item.needs_review,
      created_source: result.Item.created_source,
      hidden: result.Item.hidden || false,
      hiddenBy: result.Item.hidden_by || null,
      hiddenAt: result.Item.hidden_at || null,
      hiddenReason: result.Item.hidden_reason || null,
      createdAt: result.Item.createdAt,
      updatedAt: result.Item.updated_at
    };

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify(venue)
    };
  } catch (error) {
    console.error('[ERROR] DynamoDB get failed:', error);
    throw error;
  }
}

/**
 * GET /api/venues/by-external-id - Get venue by external ID
 */
async function handleGetVenueByExternalId(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;

  const source = event.queryStringParameters?.source;
  const externalId = event.queryStringParameters?.id;

  console.log(`[Venues] Looking up venue by external ID: ${source}:${externalId}`);

  if (!source || !externalId) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'source and id query parameters are required' })
    };
  }

  try {
    // Scan (fully paginated) and filter for matching externalId
    const allVenueItems = await scanAll(dynamodb, {
      TableName: 'bndy-venues'
    });

    // Find venue with matching externalId
    const matchingVenue = allVenueItems.find(venue => {
      const externalIds = venue.external_ids || [];
      return externalIds.some(ext => ext.source === source && ext.id === externalId);
    });

    if (!matchingVenue) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          found: false,
          source,
          externalId,
          message: `No venue found with external ID ${source}:${externalId}`
        })
      };
    }

    // Transform to match expected API format
    const venue = {
      id: matchingVenue.id,
      name: matchingVenue.name,
      address: matchingVenue.address,
      city: matchingVenue.city || null,
      latitude: matchingVenue.latitude,
      longitude: matchingVenue.longitude,
      location: matchingVenue.location_object || { lat: matchingVenue.latitude, lng: matchingVenue.longitude },
      googlePlaceId: matchingVenue.google_place_id,
      website: matchingVenue.website || '',
      validated: matchingVenue.validated || false,
      nameVariants: matchingVenue.name_variants || [],
      phone: matchingVenue.phone || '',
      postcode: matchingVenue.postcode || '',
      profileImageUrl: matchingVenue.profile_image_url,
      facilities: matchingVenue.facilities || [],
      socialMediaUrls: matchingVenue.social_media_urls || [],
      externalIds: matchingVenue.external_ids || [],
      standardTicketed: matchingVenue.standard_ticketed || false,
      standardTicketInformation: matchingVenue.standard_ticket_information || '',
      standardTicketUrl: matchingVenue.standard_ticket_url || '',
      ai_created: matchingVenue.ai_created,
      needs_review: matchingVenue.needs_review,
      created_source: matchingVenue.created_source,
      createdAt: matchingVenue.createdAt,
      updatedAt: matchingVenue.updated_at
    };

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        found: true,
        source,
        externalId,
        venue
      })
    };
  } catch (error) {
    console.error('[ERROR] External ID lookup failed:', error);
    throw error;
  }
}

/**
 * POST /api/venues - Create new venue
 * ADR-018: Requires google_place_id
 */
async function handleCreateVenue(deps, venueData, event) {
  const { dynamodb, lambda, getCorsHeaders } = deps;

  console.log('[Venues] Venues Lambda: Creating new venue');

  // ADR-018 INVARIANT: Venues MUST have google_place_id
  // If caller doesn't have one, they should use /api/venues/find-or-create which will geocode
  if (!venueData.googlePlaceId || venueData.googlePlaceId.trim() === '') {
    console.log('[REJECT] handleCreateVenue: Missing google_place_id - ADR-018 violation');
    return {
      statusCode: 422,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        error: 'google_place_id is required. Use /api/venues/find-or-create for auto-geocoding.',
        code: 'MISSING_PLACE_ID'
      })
    };
  }

  // RUNBOOK §0.23: "No fixed building, no venue"
  // Fetch place details and validate before creating
  try {
    const placeDetails = await getPlaceDetails(venueData.googlePlaceId);

    if (!placeDetails) {
      console.log(`[REJECT] handleCreateVenue: Could not fetch place details for ${venueData.googlePlaceId}`);
      return {
        statusCode: 422,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          error: 'Could not verify place_id with Google Places API',
          code: 'PLACE_NOT_FOUND',
          googlePlaceId: venueData.googlePlaceId
        })
      };
    }

    const admissionResult = validateVenueAdmission({
      types: placeDetails.types,
      name: placeDetails.name,
      formatted_address: placeDetails.address,
      address_components: placeDetails.addressComponents,
    });

    if (!admissionResult.valid) {
      console.log(`[REJECT] handleCreateVenue: Venue admission failed: ${admissionResult.code} - ${admissionResult.reason}`);
      return {
        statusCode: 422,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          error: admissionResult.reason,
          code: admissionResult.code,
          googlePlaceId: venueData.googlePlaceId,
          resolvedTypes: placeDetails.types,
        })
      };
    }
  } catch (error) {
    // Fail closed: if we can't validate, we can't create
    console.error(`[REJECT] handleCreateVenue: Place validation failed:`, error.message);
    return {
      statusCode: 422,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        error: 'Could not validate venue - Google Places API unavailable',
        code: 'VALIDATION_ERROR',
        googlePlaceId: venueData.googlePlaceId
      })
    };
  }

  const now = new Date().toISOString();
  const venue = {
    id: require('crypto').randomUUID(),
    name: venueData.name,
    address: venueData.address,
    city: venueData.city || null,
    latitude: venueData.latitude || 0,
    longitude: venueData.longitude || 0,
    location_object: venueData.location || { lat: venueData.latitude, lng: venueData.longitude },
    google_place_id: venueData.googlePlaceId || '',
    website: venueData.website || '',
    validated: venueData.validated || false,
    name_variants: venueData.nameVariants || [],
    phone: venueData.phone || '',
    postcode: venueData.postcode || '',
    facilities: venueData.facilities || [],
    social_media_urls: venueData.socialMediaUrls || [],
    profile_image_url: venueData.profileImageUrl || null,
    standard_ticketed: venueData.standardTicketed || false,
    standard_ticket_information: venueData.standardTicketInformation || '',
    standard_ticket_url: venueData.standardTicketUrl || '',
    external_ids: venueData.externalIds || [],
    ai_created: venueData.ai_created || false,
    needs_review: venueData.needs_review || false,
    created_source: venueData.created_source || venueData.source,
    createdAt: now,
    updated_at: now
  };

  try {
    // AUDIT FIX F2 (2026-07-27): this route required a place_id but never
    // checked whether it already existed — the cleanest venue-duplication
    // path in the codebase. Advisory pre-check for a friendly response:
    const existing = (await scanAll(dynamodb, {
      TableName: 'bndy-venues',
      FilterExpression: 'google_place_id = :pid',
      ExpressionAttributeValues: { ':pid': venue.google_place_id }
    }))[0];
    if (existing) {
      console.log(`[Venues] handleCreateVenue: place_id already exists on venue ${existing.id} — returning existing (no create)`);
      return {
        statusCode: 200,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ ...formatVenueResponse(existing), matchConfidence: 100, matchMethod: 'google_place_id' })
      };
    }

    // HARD GATE: sentinel transaction on the place_id — the backstop the
    // advisory check above cannot provide (races, truncated scans).
    const gateResult = await gatedPut(dynamodb, {
      tableName: 'bndy-venues',
      item: venue,
      keys: [venuePlaceKey(venue.google_place_id)],
      entityType: 'venue',
      source: venue.created_source || 'raw-create'
    });
    if (!gateResult.written) {
      const existingId = gateResult.existing && gateResult.existing.refId;
      const existingRes = existingId
        ? await dynamodb.get({ TableName: 'bndy-venues', Key: { id: existingId } }).promise()
        : { Item: null };
      if (existingRes.Item) {
        return {
          statusCode: 200,
          headers: getCorsHeaders(event),
          body: JSON.stringify({ ...formatVenueResponse(existingRes.Item), matchConfidence: 100, matchMethod: 'google_place_id_gate' })
        };
      }
      return {
        statusCode: 409,
        headers: getCorsHeaders(event),
        body: JSON.stringify(duplicateResponseBody('venue', gateResult.existing))
      };
    }

    // Trigger enrichment in background (async, non-blocking)
    await triggerVenueEnrichment(lambda, venue.id);

    return {
      statusCode: 201,
      headers: getCorsHeaders(event),
      body: JSON.stringify(venue)
    };
  } catch (error) {
    console.error('[ERROR] DynamoDB put failed:', error);
    throw error;
  }
}

/**
 * PUT /api/venues/:id - Update venue
 */
async function handleUpdateVenue(deps, venueId, venueData, event) {
  const { dynamodb, getCorsHeaders } = deps;

  console.log(`[Venues] Venues Lambda: Updating venue: ${venueId}`);
  console.log(`[Venues] Update data:`, JSON.stringify(venueData, null, 2));

  // Get existing venue to detect location changes
  let existingVenue = null;
  const isLocationChanging = venueData.latitude !== undefined || venueData.longitude !== undefined;

  if (isLocationChanging) {
    try {
      const existingResult = await dynamodb.get({
        TableName: 'bndy-venues',
        Key: { id: venueId }
      }).promise();
      existingVenue = existingResult.Item;
      console.log(`[Venues] Existing venue coords: ${existingVenue?.latitude}, ${existingVenue?.longitude}`);
    } catch (getError) {
      console.error('[Venues] Failed to get existing venue for location check:', getError.message);
    }
  }

  // RUNBOOK §0.23: "No fixed building, no venue"
  // If googlePlaceId is being updated, validate the new place
  if (venueData.googlePlaceId !== undefined && venueData.googlePlaceId !== null && venueData.googlePlaceId.trim() !== '') {
    try {
      const placeDetails = await getPlaceDetails(venueData.googlePlaceId);

      if (!placeDetails) {
        console.log(`[REJECT] handleUpdateVenue: Could not fetch place details for ${venueData.googlePlaceId}`);
        return {
          statusCode: 422,
          headers: getCorsHeaders(event),
          body: JSON.stringify({
            error: 'Could not verify new place_id with Google Places API',
            code: 'PLACE_NOT_FOUND',
            googlePlaceId: venueData.googlePlaceId
          })
        };
      }

      const admissionResult = validateVenueAdmission({
        types: placeDetails.types,
        name: placeDetails.name,
        formatted_address: placeDetails.address,
        address_components: placeDetails.addressComponents,
      });

      if (!admissionResult.valid) {
        console.log(`[REJECT] handleUpdateVenue: Venue admission failed: ${admissionResult.code} - ${admissionResult.reason}`);
        return {
          statusCode: 422,
          headers: getCorsHeaders(event),
          body: JSON.stringify({
            error: admissionResult.reason,
            code: admissionResult.code,
            googlePlaceId: venueData.googlePlaceId,
            resolvedTypes: placeDetails.types,
          })
        };
      }
    } catch (error) {
      // Fail closed: if we can't validate, we can't update place_id
      console.error(`[REJECT] handleUpdateVenue: Place validation failed:`, error.message);
      return {
        statusCode: 422,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          error: 'Could not validate venue - Google Places API unavailable',
          code: 'VALIDATION_ERROR',
          googlePlaceId: venueData.googlePlaceId
        })
      };
    }
  }

  const now = new Date().toISOString();

  // Build dynamic update expression - separate SET and REMOVE operations
  const setExpressions = ['updated_at = :updated_at'];
  const removeExpressions = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {
    ':updated_at': now
  };

  // Map frontend field names to DynamoDB field names
  const fieldMappings = {
    name: 'name',
    address: 'address',
    city: 'city',
    latitude: 'latitude',
    longitude: 'longitude',
    location: 'location_object',
    googlePlaceId: 'google_place_id',
    website: 'website',
    validated: 'validated',
    nameVariants: 'name_variants',
    phone: 'phone',
    postcode: 'postcode',
    facilities: 'facilities',
    socialMediaUrls: 'social_media_urls',
    profileImageUrl: 'profile_image_url',
    standardTicketed: 'standard_ticketed',
    isTicketed: 'standard_ticketed',  // alias for backstage UI
    standardTicketInformation: 'standard_ticket_information',
    ticketInformation: 'standard_ticket_information',  // alias for backstage UI
    standardTicketUrl: 'standard_ticket_url',
    ticketUrl: 'standard_ticket_url',  // alias for backstage UI
    externalIds: 'external_ids',
    enrichment_status: 'enrichment_status',
    enrichment_data: 'enrichment_data'
  };

  // Track which DB fields have been processed (avoid duplicates from aliases)
  const processedDbKeys = new Set();

  // Process each provided field
  Object.keys(venueData).forEach(frontendKey => {
    const dbKey = fieldMappings[frontendKey];
    if (!dbKey) return; // Skip unknown fields
    if (processedDbKeys.has(dbKey)) return; // Skip if already processed (alias)

    const value = venueData[frontendKey];

    // Special handling for null values (REMOVE operation)
    if (value === null) {
      removeExpressions.push(dbKey);
      processedDbKeys.add(dbKey);
      return;
    }

    // Handle reserved keywords (like 'name')
    if (dbKey === 'name') {
      expressionAttributeNames['#name'] = 'name';
      setExpressions.push(`#name = :${dbKey}`);
    } else {
      setExpressions.push(`${dbKey} = :${dbKey}`);
    }

    expressionAttributeValues[`:${dbKey}`] = value;
    processedDbKeys.add(dbKey);
  });

  // Build update expression with both SET and REMOVE clauses
  let updateExpression = `SET ${setExpressions.join(', ')}`;
  if (removeExpressions.length > 0) {
    updateExpression += ` REMOVE ${removeExpressions.join(', ')}`;
  }

  const params = {
    TableName: 'bndy-venues',
    Key: { id: venueId },
    UpdateExpression: updateExpression,
    ReturnValues: 'ALL_NEW'
  };

  // Only add ExpressionAttributeNames if we have any
  if (Object.keys(expressionAttributeNames).length > 0) {
    params.ExpressionAttributeNames = expressionAttributeNames;
  }

  params.ExpressionAttributeValues = expressionAttributeValues;

  console.log(`[Venues] Update expression:`, params.UpdateExpression);

  try {
    const result = await dynamodb.update(params).promise();

    // Format response to match API format
    const formattedVenue = {
      id: result.Attributes.id,
      name: result.Attributes.name,
      address: result.Attributes.address,
      city: result.Attributes.city || null,
      latitude: result.Attributes.latitude,
      longitude: result.Attributes.longitude,
      location: result.Attributes.location_object || { lat: result.Attributes.latitude, lng: result.Attributes.longitude },
      googlePlaceId: result.Attributes.google_place_id,
      website: result.Attributes.website || '',
      validated: result.Attributes.validated || false,
      nameVariants: result.Attributes.name_variants || [],
      phone: result.Attributes.phone || '',
      postcode: result.Attributes.postcode || '',
      facilities: result.Attributes.facilities || [],
      socialMediaUrls: result.Attributes.social_media_urls || [],
      profileImageUrl: result.Attributes.profile_image_url || null,
      externalIds: result.Attributes.external_ids || [],
      standardTicketed: result.Attributes.standard_ticketed || false,
      standardTicketInformation: result.Attributes.standard_ticket_information || '',
      standardTicketUrl: result.Attributes.standard_ticket_url || '',
      enrichment_status: result.Attributes.enrichment_status,
      enrichment_data: result.Attributes.enrichment_data,
      enrichment_date: result.Attributes.enrichment_date,
      ai_created: result.Attributes.ai_created,
      needs_review: result.Attributes.needs_review,
      created_source: result.Attributes.created_source,
      createdAt: result.Attributes.createdAt,
      updatedAt: result.Attributes.updated_at
    };

    // Cascade location changes to events (if coordinates changed)
    if (existingVenue && isLocationChanging) {
      const newLat = result.Attributes.latitude;
      const newLng = result.Attributes.longitude;
      const oldLat = existingVenue.latitude;
      const oldLng = existingVenue.longitude;

      if (newLat !== oldLat || newLng !== oldLng) {
        console.log(`[Venues] Location changed from (${oldLat}, ${oldLng}) to (${newLat}, ${newLng})`);
        // Await cascade to ensure it completes before Lambda terminates
        // But don't let cascade failure break the venue update
        try {
          await cascadeLocationToEvents(dynamodb, venueId, newLat, newLng);
        } catch (cascadeError) {
          console.error('[Venues] Cascade failed (venue update still succeeded):', cascadeError.message);
        }
      }
    }

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify(formattedVenue)
    };
  } catch (error) {
    console.error('[ERROR] DynamoDB update failed:', error);
    throw error;
  }
}

/**
 * DELETE /api/venues/:id - Delete venue (authenticated)
 */
async function handleDeleteVenue(deps, venueId, event) {
  const { dynamodb, getCorsHeaders } = deps;

  console.log(`[Venues] Venues Lambda: Deleting venue: ${venueId}`);

  const params = {
    TableName: 'bndy-venues',
    Key: { id: venueId }
  };

  try {
    // Release the place_id sentinel so the key is claimable again (gate plan)
    const existingRes = await dynamodb.get({ TableName: 'bndy-venues', Key: { id: venueId } }).promise();
    await dynamodb.delete(params).promise();
    if (existingRes.Item && existingRes.Item.google_place_id) {
      await releaseUniqueKeys(dynamodb, [venuePlaceKey(existingRes.Item.google_place_id)], venueId);
    }
    return {
      statusCode: 204,
      headers: getCorsHeaders(event),
      body: ''
    };
  } catch (error) {
    console.error('[ERROR] DynamoDB delete failed:', error);
    throw error;
  }
}

/**
 * DELETE /api/venues/:id/mcp - Delete venue via MCP (NO AUTH)
 */
async function handleMCPDeleteVenue(deps, venueId, event) {
  const { dynamodb, getCorsHeaders } = deps;

  console.log(`[Venues] MCP: Delete request for venue: ${venueId}`);

  try {
    // Step 1: Fetch venue to verify it exists
    const venueResult = await dynamodb.get({
      TableName: 'bndy-venues',
      Key: { id: venueId }
    }).promise();

    if (!venueResult.Item) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'Venue not found', id: venueId })
      };
    }

    // Step 2: Delete the venue record
    await dynamodb.delete({
      TableName: 'bndy-venues',
      Key: { id: venueId }
    }).promise();

    // Release the place_id sentinel so the key is claimable again (gate plan)
    if (venueResult.Item.google_place_id) {
      await releaseUniqueKeys(dynamodb, [venuePlaceKey(venueResult.Item.google_place_id)], venueId);
    }

    console.log(`[Venues] MCP: Venue ${venueId} deleted successfully`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        message: 'Venue deleted successfully',
        id: venueId
      })
    };
  } catch (error) {
    console.error('[ERROR] MCP venue deletion failed:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

/**
 * POST /api/venues/:id/enrich - Geocode/backfill an existing venue (NO AUTH, MCP-style)
 * ADR-018: Prevents duplicates when source-runner runs against venues without place_id
 */
async function handleEnrichVenue(deps, venueId, body, event) {
  const { dynamodb, lambda, getCorsHeaders } = deps;

  console.log(`[Venues] Enrich request for venue: ${venueId}`);

  const force = body?.force === true;

  try {
    // Step 1: Load the venue
    const venueResult = await dynamodb.get({
      TableName: 'bndy-venues',
      Key: { id: venueId }
    }).promise();

    if (!venueResult.Item) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'Venue not found', id: venueId })
      };
    }

    const venue = venueResult.Item;
    console.log(`[Venues] Found venue: "${venue.name}", place_id: ${venue.google_place_id || 'MISSING'}`);

    // Step 2: If already has google_place_id, return unchanged unless force=true
    if (venue.google_place_id && !force) {
      console.log(`[Venues] Venue already has place_id, returning unchanged (use force=true to re-geocode)`);
      return {
        statusCode: 200,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          action: 'skipped',
          reason: 'Venue already has google_place_id',
          venue: formatVenueResponse(venue),
          hint: 'Use force=true to re-geocode anyway'
        })
      };
    }

    // Step 3: Geocode using findPlaceFromGoogle
    // Prefer: name + city, fallback to name + address
    const searchCity = venue.city || '';
    const searchAddress = venue.address || '';
    const searchQuery = searchCity || searchAddress;

    if (!venue.name || !searchQuery) {
      console.log(`[Venues] Cannot geocode: missing name or city/address`);
      return {
        statusCode: 422,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          needsReview: true,
          error: 'Cannot geocode - venue is missing name or city/address',
          venue: formatVenueResponse(venue)
        })
      };
    }

    console.log(`[Venues] Geocoding: "${venue.name}" in "${searchQuery}"`);
    const placeData = await findPlaceFromGoogle(venue.name, searchQuery);

    if (!placeData) {
      console.log(`[Venues] Geocode returned no results for: "${venue.name}" in "${searchQuery}"`);
      return {
        statusCode: 422,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          needsReview: true,
          error: 'Geocode returned no results - venue needs manual review',
          searchedFor: { name: venue.name, location: searchQuery },
          venue: formatVenueResponse(venue)
        })
      };
    }

    console.log(`[Venues] Geocode hit: place_id=${placeData.placeId}, coords=(${placeData.latitude}, ${placeData.longitude})`);

    // Step 4: Update the venue with geocoded data
    const now = new Date().toISOString();
    const updateParams = {
      TableName: 'bndy-venues',
      Key: { id: venueId },
      UpdateExpression: 'SET google_place_id = :placeId, latitude = :lat, longitude = :lng, location_object = :loc, updated_at = :now',
      ExpressionAttributeValues: {
        ':placeId': placeData.placeId,
        ':lat': placeData.latitude,
        ':lng': placeData.longitude,
        ':loc': { lat: placeData.latitude, lng: placeData.longitude },
        ':now': now
      },
      ReturnValues: 'ALL_NEW'
    };

    // Also update address if it was missing
    if (!venue.address && placeData.address) {
      updateParams.UpdateExpression += ', address = :address';
      updateParams.ExpressionAttributeValues[':address'] = placeData.address;
    }

    const updateResult = await dynamodb.update(updateParams).promise();
    const updatedVenue = updateResult.Attributes;

    console.log(`[Venues] Successfully enriched venue: ${venueId}`);

    // Step 5: Optionally trigger venue-enrichment-lambda for socials (async, non-blocking)
    try {
      await triggerVenueEnrichment(lambda, venueId);
    } catch (enrichErr) {
      console.error(`[Venues] Enrichment lambda trigger failed (non-fatal):`, enrichErr.message);
    }

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        action: 'enriched',
        geocodedPlaceId: placeData.placeId,
        venue: formatVenueResponse(updatedVenue)
      })
    };

  } catch (error) {
    console.error('[ERROR] Venue enrichment failed:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
}

/**
 * GET /api/venues/audit/admission - Audit existing venues for admission rule compliance
 * RUNBOOK §0.23: Identifies venues that would fail the "no fixed building, no venue" rule
 *
 * Returns list of flagged venues with their rejection reasons.
 * This is a diagnostic endpoint for periodic auditing - does not modify data.
 */
async function handleAuditVenueAdmission(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;

  console.log('[AUDIT] Starting venue admission audit');

  try {
    // Scan all venues
    const allVenues = await scanAll(dynamodb, { TableName: 'bndy-venues' });
    console.log(`[AUDIT] Scanning ${allVenues.length} venues`);

    const flagged = [];
    const errors = [];
    let checked = 0;

    for (const venue of allVenues) {
      // Skip venues without google_place_id
      if (!venue.google_place_id || venue.google_place_id.trim() === '') {
        continue;
      }

      checked++;

      try {
        const placeDetails = await getPlaceDetails(venue.google_place_id);

        if (!placeDetails) {
          errors.push({
            venueId: venue.id,
            name: venue.name,
            googlePlaceId: venue.google_place_id,
            error: 'Could not fetch place details from Google'
          });
          continue;
        }

        const admissionResult = validateVenueAdmission({
          types: placeDetails.types,
          name: placeDetails.name,
          formatted_address: placeDetails.address,
          address_components: placeDetails.addressComponents,
        });

        if (!admissionResult.valid) {
          flagged.push({
            venueId: venue.id,
            name: venue.name,
            googlePlaceId: venue.google_place_id,
            city: venue.city,
            address: venue.address,
            code: admissionResult.code,
            reason: admissionResult.reason,
            types: placeDetails.types
          });
        }
      } catch (error) {
        errors.push({
          venueId: venue.id,
          name: venue.name,
          googlePlaceId: venue.google_place_id,
          error: error.message
        });
      }
    }

    console.log(`[AUDIT] Complete: ${checked} checked, ${flagged.length} flagged, ${errors.length} errors`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        summary: {
          totalVenues: allVenues.length,
          venuesWithPlaceId: checked,
          flagged: flagged.length,
          errors: errors.length
        },
        flaggedVenues: flagged,
        apiErrors: errors
      })
    };
  } catch (error) {
    console.error('[AUDIT] Audit failed:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Audit failed', details: error.message })
    };
  }
}

/**
 * Handle enrichment action (accept/reject)
 * PATCH /api/venues/:id/enrichment
 *
 * Body: { action: 'accept' | 'reject', fields?: string[] }
 * - accept: Copy selected fields from enrichment_data to main profile
 * - reject: Clear enrichment_data without applying changes
 */
async function handleEnrichmentAction(deps, venueId, body, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const { action, fields } = body || {};

  console.log(`[ENRICHMENT_ACTION] Venue ${venueId}: action=${action}, fields=${JSON.stringify(fields)}`);

  if (!action || !['accept', 'reject'].includes(action)) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'action must be "accept" or "reject"' })
    };
  }

  try {
    // Get current venue
    const result = await dynamodb.get({
      TableName: 'bndy-venues',
      Key: { id: venueId }
    }).promise();

    if (!result.Item) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'Venue not found' })
      };
    }

    const venue = result.Item;
    const enrichmentData = venue.enrichment_data;

    if (!enrichmentData) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: 'No enrichment data to process' })
      };
    }

    const updateParts = ['updated_at = :updated_at'];
    const expressionAttributeValues = {
      ':updated_at': new Date().toISOString()
    };

    if (action === 'accept') {
      // Determine which fields to accept
      const fieldsToAccept = fields || Object.keys(enrichmentData)
        .filter(k => k.startsWith('suggested_'))
        .map(k => k.replace('suggested_', ''));

      // Map field names to venue attribute names
      const fieldMapping = {
        website: 'website',
        phone: 'phone',
        socialMediaUrls: 'social_media_urls',
        facilities: 'facilities',
        postcode: 'postcode'
      };

      // Copy selected suggested fields to main profile
      for (const field of fieldsToAccept) {
        const suggestedKey = `suggested_${field}`;
        if (enrichmentData[suggestedKey] !== undefined) {
          const dbField = fieldMapping[field] || field;
          updateParts.push(`${dbField} = :${field}`);
          expressionAttributeValues[`:${field}`] = enrichmentData[suggestedKey];
        }
      }

      // Mark as reviewed
      updateParts.push('enrichment_status = :enrichment_status');
      expressionAttributeValues[':enrichment_status'] = 'reviewed';
    } else {
      // Mark as rejected
      updateParts.push('enrichment_status = :enrichment_status');
      expressionAttributeValues[':enrichment_status'] = 'rejected';
    }

    // Clear enrichment_data after processing
    updateParts.push('enrichment_data = :enrichment_data');
    expressionAttributeValues[':enrichment_data'] = null;

    const updateParams = {
      TableName: 'bndy-venues',
      Key: { id: venueId },
      UpdateExpression: `SET ${updateParts.join(', ')}`,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    };

    const updateResult = await dynamodb.update(updateParams).promise();

    console.log(`[ENRICHMENT_ACTION] Successfully processed enrichment for venue ${venueId}`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify(formatVenueResponse(updateResult.Attributes))
    };
  } catch (error) {
    console.error('[ENRICHMENT_ACTION] Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}

module.exports = {
  handleGetAllVenues,
  handleListVenuesMcp,
  handleGetVenueById,
  handleGetVenueByExternalId,
  handleCreateVenue,
  handleUpdateVenue,
  handleDeleteVenue,
  handleMCPDeleteVenue,
  handleEnrichVenue,
  handleAuditVenueAdmission,
  handleEnrichmentAction
};
