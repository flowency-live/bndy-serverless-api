// BNDY Venues Lambda Function - DynamoDB Version
// Handles: /api/venues, /api/venues/:id, /api/venues/find-or-create

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

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

// Levenshtein distance for fuzzy string matching
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],    // deletion
          dp[i][j - 1],    // insertion
          dp[i - 1][j - 1] // substitution
        );
      }
    }
  }

  return dp[m][n];
}

// Calculate similarity percentage between two strings
function calculateSimilarity(str1, str2) {
  const normalized1 = str1.toLowerCase().trim();
  const normalized2 = str2.toLowerCase().trim();
  const distance = levenshteinDistance(normalized1, normalized2);
  const maxLength = Math.max(normalized1.length, normalized2.length);
  return maxLength === 0 ? 100 : ((maxLength - distance) / maxLength) * 100;
}

// Check if two locations are within threshold distance (meters)
function isWithinDistance(lat1, lon1, lat2, lon2, thresholdMeters = 50) {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  return distance <= thresholdMeters;
}

// Tokenize address for fuzzy comparison
function tokenizeAddress(address) {
  return address
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ') // Remove punctuation
    .split(/\s+/)
    .filter(token => token.length > 2) // Ignore short tokens
    .sort();
}

// Calculate address token overlap percentage
function calculateAddressOverlap(addr1, addr2) {
  const tokens1 = tokenizeAddress(addr1);
  const tokens2 = tokenizeAddress(addr2);
  const intersection = tokens1.filter(token => tokens2.includes(token));
  const union = [...new Set([...tokens1, ...tokens2])];
  return union.length === 0 ? 0 : (intersection.length / union.length) * 100;
}

// ===== END FUZZY MATCHING HELPERS =====

exports.handler = async (event, context) => {
  // HTTP API v2 payload format compatibility
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;

  console.log('🎯 Venues Lambda: Request received', {
    method,
    path,
    pathParameters: event.pathParameters
  });
  console.log('🚀 DynamoDB version - FAST AS FUCK');

  context.callbackWaitsForEmptyEventLoop = false;

  try {
    // Route requests
    if (method === 'GET' && path === '/api/venues') {
      return await handleGetAllVenues(event);
    }

    if (method === 'POST' && path === '/api/venues/find-or-create') {
      return await handleFindOrCreateVenue(JSON.parse(event.body), event);
    }

    if (method === 'GET' && event.pathParameters?.id) {
      return await handleGetVenueById(event.pathParameters.id, event);
    }

    if (method === 'POST' && path === '/api/venues') {
      return await handleCreateVenue(JSON.parse(event.body), event);
    }

    if (method === 'PUT' && event.pathParameters?.id) {
      return await handleUpdateVenue(event.pathParameters.id, JSON.parse(event.body), event);
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
    console.error('❌ Venues Lambda: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

async function handleGetAllVenues(event) {
  console.log('📍 Venues Lambda: Scanning all venues from DynamoDB...');

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
      console.log(`📍 Venues Lambda: Search term "${searchTerm}" normalized to "${normalizedSearch}"`);

      validVenues = validVenues.filter(venue => {
        const normalizedName = normalizeForSearch(venue.name);
        const normalizedAddress = normalizeForSearch(venue.address);

        // Match if normalized search is found in normalized name or address
        return normalizedName.includes(normalizedSearch) || normalizedAddress.includes(normalizedSearch);
      });

      console.log(`📍 Venues Lambda: Search for "${searchTerm}" returned ${validVenues.length} results`);
    }

    // Transform to match expected API format
    const formattedVenues = validVenues.map(venue => ({
      id: venue.id,
      name: venue.name,
      address: venue.address,
      latitude: venue.latitude,
      longitude: venue.longitude,
      location: venue.location_object || { lat: venue.latitude, lng: venue.longitude },
      googlePlaceId: venue.google_place_id,
      validated: venue.validated || false,
      nameVariants: venue.name_variants || [],
      phone: venue.phone || '',
      postcode: venue.postcode || '',
      facilities: venue.facilities || [],
      socialMediaURLs: venue.social_media_urls || [],
      profileImageUrl: venue.profile_image_url || null,
      standardTicketed: venue.standard_ticketed || false,
      standardTicketInformation: venue.standard_ticket_information || '',
      standardTicketUrl: venue.standard_ticket_url || ''
    }));

    console.log(`📍 Venues Lambda: Served ${formattedVenues.length} venues (${result.Items.length} total in DB)`);

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify(formattedVenues)
    };
  } catch (error) {
    console.error('❌ DynamoDB scan failed:', error);
    throw error;
  }
}

async function handleGetVenueById(venueId, event) {
  console.log(`📍 Venues Lambda: Getting venue by ID: ${venueId}`);

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
      latitude: result.Item.latitude,
      longitude: result.Item.longitude,
      location: result.Item.location_object || { lat: result.Item.latitude, lng: result.Item.longitude },
      googlePlaceId: result.Item.google_place_id,
      validated: result.Item.validated || false,
      nameVariants: result.Item.name_variants || [],
      phone: result.Item.phone || '',
      postcode: result.Item.postcode || '',
      profileImageUrl: result.Item.profile_image_url,
      facilities: result.Item.facilities || [],
      socialMediaURLs: result.Item.social_media_urls || [],
      standardTicketed: result.Item.standard_ticketed || false,
      standardTicketInformation: result.Item.standard_ticket_information || '',
      standardTicketUrl: result.Item.standard_ticket_url || '',
      createdAt: result.Item.created_at,
      updatedAt: result.Item.updated_at
    };

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify(venue)
    };
  } catch (error) {
    console.error('❌ DynamoDB get failed:', error);
    throw error;
  }
}

async function handleCreateVenue(venueData, event) {
  console.log('📍 Venues Lambda: Creating new venue');

  const now = new Date().toISOString();
  const venue = {
    id: require('crypto').randomUUID(),
    name: venueData.name,
    address: venueData.address,
    latitude: venueData.latitude || 0,
    longitude: venueData.longitude || 0,
    location_object: venueData.location || { lat: venueData.latitude, lng: venueData.longitude },
    google_place_id: venueData.googlePlaceId || '',
    validated: venueData.validated || false,
    name_variants: venueData.nameVariants || [],
    phone: venueData.phone || '',
    postcode: venueData.postcode || '',
    facilities: venueData.facilities || [],
    social_media_urls: venueData.socialMediaURLs || [],
    profile_image_url: venueData.profileImageUrl || null,
    standard_ticketed: venueData.standardTicketed || false,
    standard_ticket_information: venueData.standardTicketInformation || '',
    standard_ticket_url: venueData.standardTicketUrl || '',
    created_at: now,
    updated_at: now
  };

  const params = {
    TableName: 'bndy-venues',
    Item: venue
  };

  try {
    await dynamodb.put(params).promise();
    return {
      statusCode: 201,
      headers: getCorsHeaders(event),
      body: JSON.stringify(venue)
    };
  } catch (error) {
    console.error('❌ DynamoDB put failed:', error);
    throw error;
  }
}

async function handleUpdateVenue(venueId, venueData) {
  console.log(`📍 Venues Lambda: Updating venue: ${venueId}`);

  const now = new Date().toISOString();

  const params = {
    TableName: 'bndy-venues',
    Key: { id: venueId },
    UpdateExpression: 'SET #name = :name, address = :address, latitude = :latitude, longitude = :longitude, location_object = :location_object, google_place_id = :google_place_id, validated = :validated, updated_at = :updated_at',
    ExpressionAttributeNames: {
      '#name': 'name'
    },
    ExpressionAttributeValues: {
      ':name': venueData.name,
      ':address': venueData.address,
      ':latitude': venueData.latitude || 0,
      ':longitude': venueData.longitude || 0,
      ':location_object': venueData.location || { lat: venueData.latitude, lng: venueData.longitude },
      ':google_place_id': venueData.googlePlaceId || '',
      ':validated': venueData.validated || false,
      ':updated_at': now
    },
    ReturnValues: 'ALL_NEW'
  };

  try {
    const result = await dynamodb.update(params).promise();
    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify(result.Attributes)
    };
  } catch (error) {
    console.error('❌ DynamoDB update failed:', error);
    throw error;
  }
}

async function handleDeleteVenue(venueId, event) {
  console.log(`📍 Venues Lambda: Deleting venue: ${venueId}`);

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
    console.error('❌ DynamoDB delete failed:', error);
    throw error;
  }
}

async function handleFindOrCreateVenue(venueData, event) {
  console.log('📍 Venues Lambda: Find-or-create venue with deduplication');
  console.log('📍 Input:', {
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

    console.log(`📍 Scanning ${existingVenues.length} existing venues for matches`);

    // === LEVEL 1: Exact googlePlaceId match (100% confidence) ===
    if (venueData.googlePlaceId) {
      const googlePlaceMatch = existingVenues.find(v =>
        v.google_place_id === venueData.googlePlaceId
      );

      if (googlePlaceMatch) {
        console.log('✅ LEVEL 1 MATCH: Google Place ID exact match');
        const formattedVenue = {
          id: googlePlaceMatch.id,
          name: googlePlaceMatch.name,
          address: googlePlaceMatch.address,
          latitude: googlePlaceMatch.latitude,
          longitude: googlePlaceMatch.longitude,
          location: googlePlaceMatch.location_object || { lat: googlePlaceMatch.latitude, lng: googlePlaceMatch.longitude },
          googlePlaceId: googlePlaceMatch.google_place_id,
          validated: googlePlaceMatch.validated,
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
              console.log(`✅ LEVEL 2 MATCH: Location + Name (${nameSimilarity.toFixed(1)}% similarity)`);
              const formattedVenue = {
                id: venue.id,
                name: venue.name,
                address: venue.address,
                latitude: venue.latitude,
                longitude: venue.longitude,
                location: venue.location_object || { lat: venue.latitude, lng: venue.longitude },
                googlePlaceId: venue.google_place_id,
                validated: venue.validated,
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
          console.log(`⚠️ LEVEL 3 MATCH: Name + Address tokens (name: ${nameSimilarity.toFixed(1)}%, addr: ${addressOverlap.toFixed(1)}%)`);
          const formattedVenue = {
            id: venue.id,
            name: venue.name,
            address: venue.address,
            latitude: venue.latitude,
            longitude: venue.longitude,
            location: venue.location_object || { lat: venue.latitude, lng: venue.longitude },
            googlePlaceId: venue.google_place_id,
            validated: venue.validated,
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
    console.log('🆕 LEVEL 4: No match found - creating new venue');

    const now = new Date().toISOString();
    const newVenue = {
      id: require('crypto').randomUUID(),
      name: venueData.name,
      address: venueData.address,
      latitude: venueData.latitude || 0,
      longitude: venueData.longitude || 0,
      location_object: venueData.location || { lat: venueData.latitude, lng: venueData.longitude },
      google_place_id: venueData.googlePlaceId || '',
      validated: false,
      name_variants: venueData.nameVariants || [],
      phone: venueData.phone || '',
      postcode: venueData.postcode || '',
      facilities: venueData.facilities || [],
      social_media_urls: venueData.socialMediaURLs || [],
      profile_image_url: venueData.profileImageUrl || null,
      standard_ticketed: false,
      standard_ticket_information: '',
      standard_ticket_url: '',
      created_at: now,
      updated_at: now,
      // Track source for analytics
      source: venueData.source || 'backstage_wizard'
    };

    await dynamodb.put({
      TableName: 'bndy-venues',
      Item: newVenue
    }).promise();

    const formattedNewVenue = {
      id: newVenue.id,
      name: newVenue.name,
      address: newVenue.address,
      latitude: newVenue.latitude,
      longitude: newVenue.longitude,
      location: newVenue.location_object,
      googlePlaceId: newVenue.google_place_id,
      validated: newVenue.validated,
      matchConfidence: 0,
      matchMethod: 'new_venue_created'
    };

    return {
      statusCode: 201,
      headers: getCorsHeaders(event),
      body: JSON.stringify(formattedNewVenue)
    };

  } catch (error) {
    console.error('❌ Find-or-create failed:', error);
    throw error;
  }
}

function getCorsHeaders(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin;
  const allowedOrigins = [
    'https://backstage.bndy.co.uk',
    'https://bndy.co.uk',
    'http://localhost:3000'
  ];

  const allowOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Credentials': 'true'
  };
}