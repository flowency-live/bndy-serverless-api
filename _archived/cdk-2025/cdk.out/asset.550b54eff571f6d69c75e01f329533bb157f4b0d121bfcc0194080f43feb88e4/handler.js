// BNDY Venues Lambda Function - DynamoDB Version
// Handles: /api/venues, /api/venues/:id, /api/venues/find-or-create, /api/integration/venues

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const lambda = new AWS.Lambda({ region: 'eu-west-2' });
const https = require('https');
const { Client, PlaceInputType } = require('@googlemaps/google-maps-services-js');

// Google Places API client for integration endpoints
const placesClient = new Client({});

// ===== FUZZY MATCHING HELPERS =====

// Common stop words to ignore in venue search
const STOP_WORDS = ['the', 'a', 'an'];

// Normalize string for search by removing stop words
function normalizeForSearch(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(/\s+/)
    .filter(word => !STOP_WORDS.includes(word))
    .join(' ')
    .trim();
}

// Check if two lat/lng coordinates are within specified distance in meters
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

// Calculate string similarity percentage using Levenshtein distance
function calculateSimilarity(str1, str2) {
  const distance = levenshteinDistance(str1.toLowerCase(), str2.toLowerCase());
  const maxLength = Math.max(str1.length, str2.length);
  return ((maxLength - distance) / maxLength) * 100;
}

// Calculate address overlap percentage using token-based Jaccard similarity
function calculateAddressOverlap(addr1, addr2) {
  const tokens1 = new Set(addr1.toLowerCase().split(/[\s,]+/));
  const tokens2 = new Set(addr2.toLowerCase().split(/[\s,]+/));
  const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);
  return (intersection.size / union.size) * 100;
}

// Levenshtein distance algorithm for string comparison
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

// ===== END FUZZY MATCHING HELPERS =====

// Safe JSON parse helper - handles both string and object body
function parseBody(body) {
  if (!body) return {};
  if (typeof body === 'object') return body;

  console.log('[Venues Lambda] Parsing body, type:', typeof body, 'length:', body.length);
  console.log('[Venues Lambda] Body preview:', body.substring(0, 200));

  try {
    const parsed = JSON.parse(body);
    console.log('[Venues Lambda] Parsed successfully, keys:', Object.keys(parsed));
    return parsed;
  } catch (error) {
    console.error('[ERROR] JSON parse failed:', error.message);
    console.error('[ERROR] Body that failed to parse:', body);
    throw new Error('Invalid JSON in request body');
  }
}

exports.handler = async (event, context) => {
  // HTTP API v2 payload format compatibility
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;

  console.log('[Venues Lambda] Request received', {
    method,
    path,
    pathParameters: event.pathParameters,
    bodyType: typeof event.body,
    bodyLength: event.body ? event.body.length : 0
  });
  console.log('[DynamoDB] version - FAST AS FUCK');

  context.callbackWaitsForEmptyEventLoop = false;

  try {
    // Route requests
    if (method === 'GET' && path === '/api/venues') {
      return await handleGetAllVenues(event);
    }

    // External ID lookup endpoint
    if (method === 'GET' && path === '/api/venues/by-external-id') {
      return await handleGetVenueByExternalId(event);
    }

    if (method === 'POST' && path === '/api/venues/find-or-create') {
      return await handleFindOrCreateVenue(parseBody(event.body), event);
    }

    // Integration API endpoint (requires API key)
    if (method === 'POST' && path === '/api/integration/venues') {
      return await handleIntegrationCreateVenue(parseBody(event.body), event);
    }

    if (method === 'GET' && event.pathParameters?.id) {
      return await handleGetVenueById(event.pathParameters.id, event);
    }

    if (method === 'POST' && path === '/api/venues') {
      return await handleCreateVenue(parseBody(event.body), event);
    }

    if (method === 'PUT' && event.pathParameters?.id) {
      return await handleUpdateVenue(event.pathParameters.id, parseBody(event.body), event);
    }

    if (method === 'DELETE' && event.pathParameters?.id) {
      return await handleDeleteVenue(event.pathParameters.id, event);
    }

    return {
      statusCode: 404,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Route not found', method, path })
    };

  } catch (error) {
    console.error('[ERROR] Venues Lambda: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

async function handleGetAllVenues(event) {
  console.log('[Venues] Venues Lambda: Scanning all venues from DynamoDB...');

  // Check for search query parameter
  const searchTerm = event.queryStringParameters?.search;

  const params = {
    TableName: 'bndy-venues'
  };

  try {
    const result = await dynamodb.scan(params).promise();

    // Filter venues with valid coordinates (like the PostgreSQL query)
    let validVenues = result.Items.filter(venue =>
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

    // Get event counts for all venues in parallel
    const eventCountPromises = validVenues.map(async (venue) => {
      try {
        // Query events table using venue_id-index to count events
        const eventCountResult = await dynamodb.query({
          TableName: 'bndy-events',
          IndexName: 'venue_id-index',
          KeyConditionExpression: 'venue_id = :venueId',
          ExpressionAttributeValues: {
            ':venueId': venue.id
          },
          Select: 'COUNT'
        }).promise();

        return { venueId: venue.id, count: eventCountResult.Count || 0 };
      } catch (error) {
        console.error(`Error counting events for venue ${venue.id}:`, error);
        return { venueId: venue.id, count: 0 };
      }
    });

    const eventCounts = await Promise.all(eventCountPromises);
    const eventCountMap = eventCounts.reduce((map, { venueId, count }) => {
      map[venueId] = count;
      return map;
    }, {});

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
      enrichment_data: venue.enrichment_data,
      enrichment_date: venue.enrichment_date,
      ai_created: venue.ai_created,
      needs_review: venue.needs_review,
      created_source: venue.created_source,
      eventCount: eventCountMap[venue.id] || 0
    }));

    console.log(`[Venues] Venues Lambda: Served ${formattedVenues.length} venues (${result.Items.length} total in DB)`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify(formattedVenues)
    };
  } catch (error) {
    console.error('[ERROR] DynamoDB scan failed:', error);
    throw error;
  }
}

async function handleGetVenueById(venueId, event) {
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

async function handleGetVenueByExternalId(event) {
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
    // Scan and filter for matching externalId
    const result = await dynamodb.scan({
      TableName: 'bndy-venues'
    }).promise();

    // Find venue with matching externalId
    const matchingVenue = result.Items.find(venue => {
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

async function handleCreateVenue(venueData, event) {
  console.log('[Venues] Venues Lambda: Creating new venue');

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

  const params = {
    TableName: 'bndy-venues',
    Item: venue
  };

  try {
    await dynamodb.put(params).promise();

    // Trigger enrichment in background (async, non-blocking)
    await triggerVenueEnrichment(venue.id);

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

async function handleUpdateVenue(venueId, venueData, event) {
  console.log(`[Venues] Venues Lambda: Updating venue: ${venueId}`);
  console.log(`[Venues] Update data:`, JSON.stringify(venueData, null, 2));

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

async function handleDeleteVenue(venueId, event) {
  console.log(`[Venues] Venues Lambda: Deleting venue: ${venueId}`);

  const params = {
    TableName: 'bndy-venues',
    Key: { id: venueId }
  };

  try {
    await dynamodb.delete(params).promise();
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

async function handleFindOrCreateVenue(venueData, event) {
  console.log('[Venues] Venues Lambda: Find-or-create venue with deduplication');
  console.log('[Venues] Input:', {
    name: venueData.name,
    googlePlaceId: venueData.googlePlaceId,
    address: venueData.address,
    latitude: venueData.latitude,
    longitude: venueData.longitude
  });

  // Scan all venues for matching
  const scanParams = {
    TableName: 'bndy-venues'
  };

  try {
    const result = await dynamodb.scan(scanParams).promise();
    const existingVenues = result.Items;

    console.log(`[Venues] Scanning ${existingVenues.length} existing venues for matches`);

    // === LEVEL 1: Exact googlePlaceId match (100% confidence) ===
    if (venueData.googlePlaceId) {
      const googlePlaceMatch = existingVenues.find(v =>
        v.google_place_id === venueData.googlePlaceId
      );

      if (googlePlaceMatch) {
        console.log('[SUCCESS] LEVEL 1 MATCH: Google Place ID exact match');
        const formattedVenue = {
          id: googlePlaceMatch.id,
          name: googlePlaceMatch.name,
          address: googlePlaceMatch.address,
          latitude: googlePlaceMatch.latitude,
          longitude: googlePlaceMatch.longitude,
          location: googlePlaceMatch.location_object || { lat: googlePlaceMatch.latitude, lng: googlePlaceMatch.longitude },
          googlePlaceId: googlePlaceMatch.google_place_id,
          validated: googlePlaceMatch.validated,
          externalIds: googlePlaceMatch.external_ids || [],
          matchConfidence: 100,
          matchMethod: 'google_place_id'
        };
        return {
          statusCode: 200,
          headers: getCorsHeaders(event),
          body: JSON.stringify(formattedVenue)
        };
      }
    }

    // === LEVEL 2: Location + Name fuzzy match (90% confidence) ===
    if (venueData.latitude && venueData.longitude) {
      for (const venue of existingVenues) {
        if (venue.latitude && venue.longitude) {
          const withinRadius = isWithinDistance(
            venueData.latitude,
            venueData.longitude,
            venue.latitude,
            venue.longitude,
            50 // 50 meters radius
          );

          if (withinRadius) {
            const nameSimilarity = calculateSimilarity(venueData.name, venue.name);

            if (nameSimilarity >= 80) {
              console.log(`[SUCCESS] LEVEL 2 MATCH: Location + Name (${nameSimilarity.toFixed(1)}% similarity)`);
              const formattedVenue = {
                id: venue.id,
                name: venue.name,
                address: venue.address,
                latitude: venue.latitude,
                longitude: venue.longitude,
                location: venue.location_object || { lat: venue.latitude, lng: venue.longitude },
                googlePlaceId: venue.google_place_id,
                validated: venue.validated,
                externalIds: venue.external_ids || [],
                matchConfidence: 90,
                matchMethod: 'location_and_name',
                matchDetails: { nameSimilarity: nameSimilarity.toFixed(1) }
              };
              return {
                statusCode: 200,
                headers: getCorsHeaders(event),
                body: JSON.stringify(formattedVenue)
              };
            }
          }
        }
      }
    }

    // === LEVEL 3: Name + Address token overlap (70% confidence) ===
    for (const venue of existingVenues) {
      if (venue.name && venue.address && venueData.address) {
        const nameSimilarity = calculateSimilarity(venueData.name, venue.name);
        const addressOverlap = calculateAddressOverlap(venueData.address, venue.address);

        // Match if name is very similar AND address has decent overlap
        if (nameSimilarity >= 85 && addressOverlap >= 50) {
          console.log(`[WARNING] LEVEL 3 MATCH: Name + Address tokens (name: ${nameSimilarity.toFixed(1)}%, addr: ${addressOverlap.toFixed(1)}%)`);
          const formattedVenue = {
            id: venue.id,
            name: venue.name,
            address: venue.address,
            latitude: venue.latitude,
            longitude: venue.longitude,
            location: venue.location_object || { lat: venue.latitude, lng: venue.longitude },
            googlePlaceId: venue.google_place_id,
            validated: venue.validated,
            externalIds: venue.external_ids || [],
            matchConfidence: 70,
            matchMethod: 'name_and_address_tokens',
            matchDetails: {
              nameSimilarity: nameSimilarity.toFixed(1),
              addressOverlap: addressOverlap.toFixed(1)
            }
          };
          return {
            statusCode: 200,
            headers: getCorsHeaders(event),
            body: JSON.stringify(formattedVenue)
          };
        }
      }
    }

    // === LEVEL 4: Create new venue (no match found) ===
    console.log('[NEW] LEVEL 4: No match found - creating new venue');

    const now = new Date().toISOString();
    const newVenue = {
      id: require('crypto').randomUUID(),
      name: venueData.name,
      address: venueData.address,
      city: venueData.city || null,
      latitude: venueData.latitude || 0,
      longitude: venueData.longitude || 0,
      location_object: venueData.location || { lat: venueData.latitude, lng: venueData.longitude },
      google_place_id: venueData.googlePlaceId || '',
      website: venueData.website || '',
      validated: false,
      name_variants: venueData.nameVariants || [],
      phone: venueData.phone || '',
      postcode: venueData.postcode || '',
      facilities: venueData.facilities || [],
      social_media_urls: venueData.socialMediaUrls || [],
      profile_image_url: venueData.profileImageUrl || null,
      external_ids: venueData.externalIds || [],
      standard_ticketed: false,
      standard_ticket_information: '',
      standard_ticket_url: '',
      created_at: now,
      updated_at: now,
      // AI creation flags
      ai_created: venueData.ai_created || false,
      needs_review: venueData.needs_review || false,
      created_source: venueData.created_source || venueData.source || 'backstage_wizard'
    };

    await dynamodb.put({
      TableName: 'bndy-venues',
      Item: newVenue
    }).promise();

    // Trigger enrichment in background (async, non-blocking)
    await triggerVenueEnrichment(newVenue.id);

    const formattedNewVenue = {
      id: newVenue.id,
      name: newVenue.name,
      address: newVenue.address,
      latitude: newVenue.latitude,
      longitude: newVenue.longitude,
      location: newVenue.location_object,
      googlePlaceId: newVenue.google_place_id,
      validated: newVenue.validated,
      externalIds: newVenue.external_ids,
      matchConfidence: 0,
      matchMethod: 'new_venue_created'
    };

    return {
      statusCode: 201,
      headers: getCorsHeaders(event),
      body: JSON.stringify(formattedNewVenue)
    };

  } catch (error) {
    console.error('[ERROR] Find-or-create failed:', error);
    throw error;
  }
}

// ===== INTEGRATION API HELPERS =====

/**
 * Validate API key from request headers
 * Keys are stored in INTEGRATION_API_KEYS env var (comma-separated)
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
 */
async function findPlaceFromGoogle(name, city) {
  const query = `${name}, ${city}`;
  console.log(`[Integration] Searching Google Places for: "${query}"`);

  try {
    const response = await placesClient.findPlaceFromText({
      params: {
        input: query,
        inputtype: PlaceInputType.textQuery,
        fields: ['place_id', 'name', 'formatted_address', 'geometry'],
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

    const result = {
      placeId: place.place_id,
      name: place.name || name,
      address: place.formatted_address || '',
      latitude: place.geometry.location.lat,
      longitude: place.geometry.location.lng,
    };

    console.log(`[Integration] Found place: ${result.name} (${result.placeId})`);
    return result;
  } catch (error) {
    console.error(`[Integration] Google Places API error:`, error.message);
    throw error;
  }
}

/**
 * Handle POST /api/integration/venues
 * Searches BNDY first (cost optimization), then falls back to Google Places
 * Requires x-api-key header for authentication
 */
async function handleIntegrationCreateVenue(body, event) {
  console.log('[Integration] Processing venue creation request');

  // 1. Validate API key
  if (!validateApiKey(event)) {
    console.log('[Integration] API key validation failed');
    return {
      statusCode: 401,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Invalid or missing API key' })
    };
  }

  // 2. Validate input
  const { name, city, facebookUrl, instagramUrl, websiteUrl, socialMediaUrls } = body;
  if (!name || !city) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'name and city are required' })
    };
  }

  try {
    // 3. BNDY-FIRST: Search existing venues before calling Google (cost optimization)
    console.log(`[Integration] Searching BNDY database for: "${name}" in "${city}"`);
    const scanResult = await dynamodb.scan({ TableName: 'bndy-venues' }).promise();
    const existingVenues = scanResult.Items || [];

    // Filter by city (case-insensitive) and find best name match
    const normalizedCity = city.toLowerCase().trim();
    const normalizedSearchName = normalizeForSearch(name);

    let bestMatch = null;
    let bestScore = 0;

    for (const venue of existingVenues) {
      // Skip venues without name
      if (!venue.name) continue;

      // Check city match (case-insensitive, handles null/undefined)
      const venueCity = (venue.city || '').toLowerCase().trim();
      if (!venueCity.includes(normalizedCity) && !normalizedCity.includes(venueCity)) {
        continue; // Skip venues in different cities
      }

      // Calculate name similarity
      const similarity = calculateSimilarity(name, venue.name);
      if (similarity >= 80 && similarity > bestScore) {
        bestMatch = venue;
        bestScore = similarity;
      }
    }

    // If we found a good BNDY match, return it WITHOUT calling Google
    if (bestMatch) {
      console.log(`[Integration] BNDY match found: "${bestMatch.name}" (${bestScore.toFixed(1)}% similarity)`);
      const formattedVenue = {
        id: bestMatch.id,
        name: bestMatch.name,
        address: bestMatch.address,
        city: bestMatch.city,
        latitude: bestMatch.latitude,
        longitude: bestMatch.longitude,
        location: bestMatch.location_object || { lat: bestMatch.latitude, lng: bestMatch.longitude },
        googlePlaceId: bestMatch.google_place_id,
        validated: bestMatch.validated,
        matchConfidence: Math.round(bestScore),
        matchMethod: 'bndy_name_city_match'
      };

      return {
        statusCode: 200,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          success: true,
          venue: formattedVenue,
          isNew: false,
          matchMethod: 'bndy_name_city_match'
        })
      };
    }

    // 4. No BNDY match - NOW call Google Places
    console.log(`[Integration] No BNDY match, calling Google Places for: "${name}, ${city}"`);
    const placeData = await findPlaceFromGoogle(name, city);
    if (!placeData) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          error: `Venue "${name}" not found in BNDY or Google Places`,
          suggestion: 'Try a more specific name or check spelling'
        })
      };
    }

    // 5. Build social media URLs array from individual URLs or provided array
    const urls = Array.isArray(socialMediaUrls) ? [...socialMediaUrls] : [];
    if (facebookUrl) urls.push({ platform: 'facebook', url: facebookUrl });
    if (instagramUrl) urls.push({ platform: 'instagram', url: instagramUrl });
    if (websiteUrl) urls.push({ platform: 'website', url: websiteUrl });

    // 6. Call existing find-or-create logic (handles googlePlaceId dedup)
    const venueData = {
      name: placeData.name,
      address: placeData.address,
      googlePlaceId: placeData.placeId,
      latitude: placeData.latitude,
      longitude: placeData.longitude,
      city: city,
      socialMediaUrls: urls,
      ai_created: true,
      needs_review: true,
      created_source: 'integration_api'
    };

    const result = await handleFindOrCreateVenue(venueData, event);

    // 7. Wrap response with integration-friendly format
    const resultBody = JSON.parse(result.body);
    const isNew = resultBody.matchMethod === 'new_venue_created';

    console.log(`[Integration] Venue ${isNew ? 'created' : 'matched via Google'}: ${resultBody.id}`);

    return {
      statusCode: result.statusCode,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        success: true,
        venue: resultBody,
        isNew: isNew,
        matchMethod: resultBody.matchMethod
      })
    };
  } catch (error) {
    console.error('[Integration] Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
}

// ===== END INTEGRATION API HELPERS =====

// ===== ENRICHMENT HELPERS =====

async function triggerVenueEnrichment(venueId) {
  try {
    console.log(`[Enrichment] Triggering enrichment for venue: ${venueId}`);
    await lambda.invoke({
      FunctionName: 'venue-enrichment-lambda',
      InvocationType: 'Event', // Async - don't wait for response
      Payload: JSON.stringify({ body: JSON.stringify({ venueId }) })
    }).promise();
    console.log(`[Enrichment] Successfully triggered for: ${venueId}`);
  } catch (error) {
    console.error(`[Enrichment] Failed to trigger for ${venueId}:`, error);
    // Don't throw - enrichment failure shouldn't block venue creation
  }
}

// ===== END ENRICHMENT HELPERS =====

// ===== ADMIN ENDPOINTS =====

// Removed: getPlaceDetails() and handleBackfillWebsites() functions
// These programmatic enrichment functions were replaced by venue-enrichment-lambda (AI-based approach)
// See: C:/VSProjects/bndy-serverless-api/venue-enrichment-lambda/

// ===== END ADMIN ENDPOINTS =====

function getCorsHeaders(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin;
  const allowedOrigins = [
    'https://www.bndy.co.uk',       // Primary domain
    'https://backstage.bndy.co.uk', // Legacy domain
    'https://bndy.co.uk',            // Apex domain
    'https://live.bndy.co.uk',      // Frontstage
    'http://localhost:3000'          // Local development
  ];

  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie,x-api-key',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Credentials': 'true'
  };
}