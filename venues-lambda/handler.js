// BNDY Venues Lambda Function
// Handles: /api/venues, /api/venues/:id

const { Pool } = require('pg');
const AWS = require('aws-sdk');

const secretsManager = new AWS.SecretsManager({ region: 'eu-west-2' });
let pool;

async function getDbConnection() {
  if (pool) return pool;

  console.log('🔄 Venues Lambda: Initializing database connection...');

  try {
    const secretResponse = await secretsManager.getSecretValue({
      SecretId: 'bndy-production-aurora-password-v2'
    }).promise();

    const secret = JSON.parse(secretResponse.SecretString);
    const { username, password } = secret;

    const connectionString = `postgresql://${username}:${encodeURIComponent(password)}@bndy-production-cluster.cluster-ch2q4a408jrc.eu-west-2.rds.amazonaws.com:3306/bndy`;

    pool = new Pool({
      connectionString,
      max: 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: false
    });

    console.log('✅ Venues Lambda: Database connection established');
    return pool;
  } catch (error) {
    console.error('❌ Venues Lambda: Database connection failed:', error);
    throw error;
  }
}

exports.handler = async (event, context) => {
  console.log('🎯 Venues Lambda: Request received', {
    httpMethod: event.httpMethod,
    path: event.path,
    pathParameters: event.pathParameters
  });
  console.log('🚀 CI/CD test deployment');

  context.callbackWaitsForEmptyEventLoop = false;

  try {
    const pool = await getDbConnection();

    // Route requests
    if (event.httpMethod === 'GET' && event.path === '/api/venues') {
      return await handleGetAllVenues(pool);
    }

    if (event.httpMethod === 'GET' && event.pathParameters?.id) {
      return await handleGetVenueById(pool, event.pathParameters.id);
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

async function handleGetAllVenues(pool) {
  const result = await pool.query(`
    SELECT
      id, name, address,
      location_object as location,
      google_place_id as "googlePlaceId",
      validated, profile_image_url as "profileImageUrl"
    FROM venues
    WHERE latitude != 0 AND longitude != 0
    ORDER BY validated DESC, name ASC
  `);

  console.log(`📍 Venues Lambda: Served ${result.rows.length} venues`);

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify(result.rows)
  };
}

async function handleGetVenueById(pool, venueId) {
  const result = await pool.query(`
    SELECT
      id, name, address,
      latitude, longitude,
      location_object as location,
      google_place_id as "googlePlaceId",
      validated, name_variants as "nameVariants",
      phone, postcode, profile_image_url as "profileImageUrl",
      facilities, social_media_urls as "socialMediaURLs",
      standard_ticketed as "standardTicketed",
      standard_ticket_information as "standardTicketInformation",
      standard_ticket_url as "standardTicketUrl",
      created_at as "createdAt",
      updated_at as "updatedAt"
    FROM venues
    WHERE id = $1
  `, [venueId]);

  if (result.rows.length === 0) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Venue not found' })
    };
  }

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify(result.rows[0])
  };
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