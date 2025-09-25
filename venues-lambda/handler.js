// BNDY Venues Lambda Function - DynamoDB Version
// Handles: /api/venues, /api/venues/:id

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

exports.handler = async (event, context) => {
  console.log('🎯 Venues Lambda: Request received', {
    httpMethod: event.httpMethod,
    path: event.path,
    pathParameters: event.pathParameters
  });
  console.log('🚀 DynamoDB version - FAST AS FUCK');

  context.callbackWaitsForEmptyEventLoop = false;

  try {
    // Route requests
    if (event.httpMethod === 'GET' && event.path === '/api/venues') {
      return await handleGetAllVenues();
    }

    if (event.httpMethod === 'GET' && event.pathParameters?.id) {
      return await handleGetVenueById(event.pathParameters.id);
    }

    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Route not found' })
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
    TableName: 'bndy-venues',
    ProjectionExpression: 'id, #name, address, latitude, longitude, location_object, google_place_id, validated, profile_image_url',
    ExpressionAttributeNames: {
      '#name': 'name'
    }
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
      location: venue.location_object || { lat: venue.latitude, lng: venue.longitude },
      googlePlaceId: venue.google_place_id,
      validated: venue.validated || false,
      profileImageUrl: venue.profile_image_url
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

function getCorsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Credentials': 'true'
  };
}