/**
 * Venues Route Handlers
 *
 * HTTP handlers for venue CRUD operations.
 * Each handler receives deps object for dependency injection (dynamodb, lambda, getCorsHeaders).
 */

const { normalizeForSearch, calculateSimilarity } = require('../lib/fuzzy-matcher');
const { computeGeohashFields, cascadeLocationToEvents } = require('../lib/geohash');
const { findPlaceFromGoogle } = require('../lib/google-places');
const { formatVenueResponse, triggerVenueEnrichment } = require('../lib/venue-deduplication');
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
    let validVenues = allItems.filter(venue =>
      venue.latitude && venue.longitude &&
      venue.latitude !== 0 && venue.longitude !== 0
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
      createdAt: result.Item.created_at,
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
      createdAt: matchingVenue.created_at,
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
    created_at: now,
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
    standardTicketInformation: 'standard_ticket_information',
    standardTicketUrl: 'standard_ticket_url',
    externalIds: 'external_ids',
    enrichment_status: 'enrichment_status',
    enrichment_data: 'enrichment_data'
  };

  // Process each provided field
  Object.keys(venueData).forEach(frontendKey => {
    const dbKey = fieldMappings[frontendKey];
    if (!dbKey) return; // Skip unknown fields

    const value = venueData[frontendKey];

    // Special handling for null values (REMOVE operation)
    if (value === null) {
      removeExpressions.push(dbKey);
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
      createdAt: result.Attributes.created_at,
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

module.exports = {
  handleGetAllVenues,
  handleListVenuesMcp,
  handleGetVenueById,
  handleGetVenueByExternalId,
  handleCreateVenue,
  handleUpdateVenue,
  handleDeleteVenue,
  handleMCPDeleteVenue,
  handleEnrichVenue
};
