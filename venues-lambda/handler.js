// BNDY Venues Lambda Function - DynamoDB Version
// Handles: /api/venues, /api/venues/:id

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

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
      return await handleGetAllVenues();
    }

    if (method === 'GET' && event.pathParameters?.id) {
      return await handleGetVenueById(event.pathParameters.id);
    }

    if (method === 'POST' && path === '/api/venues') {
      return await handleCreateVenue(JSON.parse(event.body));
    }

    if (method === 'PUT' && event.pathParameters?.id) {
      return await handleUpdateVenue(event.pathParameters.id, JSON.parse(event.body));
    }

    if (method === 'DELETE' && event.pathParameters?.id) {
      return await handleDeleteVenue(event.pathParameters.id);
    }

    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Route not found', method, path })
    };

  } catch (error) {
    console.error('❌ Venues Lambda: Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

async function handleGetAllVenues() {
  console.log('📍 Venues Lambda: Scanning all venues from DynamoDB...');

  const params = {
    TableName: 'bndy-venues'
  };

  try {
    const result = await dynamodb.scan(params).promise();

    // Filter venues with valid coordinates (like the PostgreSQL query)
    const validVenues = result.Items.filter(venue =>
      venue.latitude && venue.longitude &&
      venue.latitude !== 0 && venue.longitude !== 0
    );

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
      headers: getCorsHeaders(),
      body: JSON.stringify(formattedVenues)
    };
  } catch (error) {
    console.error('❌ DynamoDB scan failed:', error);
    throw error;
  }
}

async function handleGetVenueById(venueId) {
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
        headers: getCorsHeaders(),
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
      headers: getCorsHeaders(),
      body: JSON.stringify(venue)
    };
  } catch (error) {
    console.error('❌ DynamoDB get failed:', error);
    throw error;
  }
}

async function handleCreateVenue(venueData) {
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
      headers: getCorsHeaders(),
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
      headers: getCorsHeaders(),
      body: JSON.stringify(result.Attributes)
    };
  } catch (error) {
    console.error('❌ DynamoDB update failed:', error);
    throw error;
  }
}

async function handleDeleteVenue(venueId) {
  console.log(`📍 Venues Lambda: Deleting venue: ${venueId}`);

  const params = {
    TableName: 'bndy-venues',
    Key: { id: venueId }
  };

  try {
    await dynamodb.delete(params).promise();
    return {
      statusCode: 204,
      headers: getCorsHeaders(),
      body: ''
    };
  } catch (error) {
    console.error('❌ DynamoDB delete failed:', error);
    throw error;
  }
}

function getCorsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Credentials': 'true'
  };
}