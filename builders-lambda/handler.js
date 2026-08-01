// BNDY Builders Lambda Function - Builder Persona Management
// Handles: Builder CRUD, subdomain lookup, feature flag enforcement

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });

// Configuration
const BUILDERS_TABLE = process.env.BUILDERS_TABLE || 'bndy-builders';
const BUILDER_VENUES_TABLE = process.env.BUILDER_VENUES_TABLE || 'bndy-builder-venues';
const VENUES_TABLE = process.env.VENUES_TABLE || 'bndy-venues';
const USERS_TABLE = process.env.USERS_TABLE || 'bndy-users';

// Valid selection types for builder-venues
const VALID_SELECTION_TYPES = ['auto', 'manual', 'excluded'];

// Email validation helper
const isValidEmail = (email) => {
  if (!email) return true; // null/undefined is valid (optional field)
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// JWT Secret - cached after first retrieval
let JWT_SECRET = null;

/**
 * Get JWT secret from SSM Parameter Store with fallback to env var
 */
async function getJWTSecret() {
  if (JWT_SECRET) {
    return JWT_SECRET;
  }

  try {
    const result = await ssm.getParameter({
      Name: '/bndy/auth/jwt-secret',
      WithDecryption: true
    }).promise();
    JWT_SECRET = result.Parameter.Value;
    return JWT_SECRET;
  } catch (error) {
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      return JWT_SECRET;
    }
    throw new Error('JWT_SECRET not available from SSM or environment');
  }
}

// Allowed CORS origins
const ALLOWED_ORIGINS = [
  'https://www.bndy.co.uk',
  'https://backstage.bndy.co.uk',
  'https://bndy.co.uk',
  'https://live.bndy.co.uk',
  'https://gigmap.bndy.co.uk',
  'http://localhost:3000',
  'http://localhost:5173',
];

// Module-level variable for current request
let currentEvent = null;

// Get appropriate origin for CORS
const getAllowedOrigin = () => {
  const requestOrigin = currentEvent?.headers?.origin || currentEvent?.headers?.Origin;

  // Allow *.bndy.live subdomains
  if (requestOrigin && requestOrigin.match(/^https:\/\/[a-z0-9-]+\.bndy\.live$/)) {
    return requestOrigin;
  }

  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
};

// Generate CORS headers
const getCorsHeaders = () => ({
  'Access-Control-Allow-Origin': getAllowedOrigin(),
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Credentials': 'true'
});

// Parse cookies from event
const parseCookies = (cookieHeader) => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, value] = cookie.trim().split('=');
    cookies[name] = value;
    return cookies;
  }, {});
};

/**
 * Authentication middleware - returns user object or error response
 */
const requireAuth = async (event) => {
  let sessionToken = null;

  if (event.cookies && Array.isArray(event.cookies)) {
    const cookieString = event.cookies.find(c => c.startsWith('bndy_session='));
    if (cookieString) {
      sessionToken = cookieString.split('=')[1];
    }
  } else {
    const cookies = parseCookies(event.headers?.Cookie || event.headers?.cookie || '');
    sessionToken = cookies.bndy_session;
  }

  if (!sessionToken) {
    return {
      statusCode: 401,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Not authenticated' })
    };
  }

  try {
    const jwtSecret = await getJWTSecret();
    const session = jwt.verify(sessionToken, jwtSecret);

    // Fetch user to check platformAdmin flag
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: session.userId }
    }).promise();

    const platformAdmin = userResult.Item?.platformAdmin || false;

    return {
      user: {
        ...session,
        platformAdmin
      }
    };
  } catch (error) {
    return {
      statusCode: 401,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Invalid session' })
    };
  }
};

/**
 * Check if user is whitelisted for builder feature
 */
const isBuilderWhitelisted = (userId, platformAdmin) => {
  // Platform admins always have access
  if (platformAdmin) return true;

  // Check environment whitelist
  const whitelist = process.env.BUILDER_WHITELIST || '';
  const whitelistedIds = whitelist.split(',').map(id => id.trim()).filter(Boolean);

  return whitelistedIds.includes(userId);
};

/**
 * Validate slug format (URL-safe)
 */
const isValidSlug = (slug) => {
  return /^[a-z0-9-]+$/.test(slug) && slug.length >= 2 && slug.length <= 50;
};

/**
 * Validate coverage schema based on type
 */
const validateCoverage = (coverage) => {
  if (!coverage || !coverage.type) {
    return { valid: false, error: 'Coverage type is required' };
  }

  switch (coverage.type) {
    case 'postcode_radius':
      if (!coverage.postcode || typeof coverage.radius !== 'number') {
        return { valid: false, error: 'postcode_radius requires postcode and radius' };
      }
      break;
    case 'postcode_areas':
      if (!Array.isArray(coverage.areas) || coverage.areas.length === 0) {
        return { valid: false, error: 'postcode_areas requires areas array' };
      }
      break;
    case 'bounding_box':
      if (!coverage.sw || !coverage.ne) {
        return { valid: false, error: 'bounding_box requires sw and ne coordinates' };
      }
      break;
    case 'manual':
      // No additional validation needed
      break;
    default:
      return { valid: false, error: `Unknown coverage type: ${coverage.type}` };
  }

  return { valid: true };
};

/**
 * Validate theme object
 */
const validateTheme = (theme) => {
  if (!theme) {
    return { valid: false, error: 'theme is required' };
  }

  const requiredFields = ['primaryColor', 'secondaryColor', 'backgroundColor', 'foregroundColor', 'defaultMode'];
  for (const field of requiredFields) {
    if (!theme[field]) {
      return { valid: false, error: `theme.${field} is required` };
    }
  }

  if (!['light', 'dark'].includes(theme.defaultMode)) {
    return { valid: false, error: 'theme.defaultMode must be "light" or "dark"' };
  }

  return { valid: true };
};

/**
 * Route handlers
 */

// GET /api/builders/by-subdomain/:slug (PUBLIC - no auth required)
const getBuilderBySubdomain = async (slug) => {
  const result = await dynamodb.query({
    TableName: BUILDERS_TABLE,
    IndexName: 'slug-index',
    KeyConditionExpression: 'slug = :slug',
    ExpressionAttributeValues: { ':slug': slug }
  }).promise();

  const builder = result.Items?.[0];

  if (!builder || builder.status !== 'published') {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Builder not found' })
    };
  }

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({ builder })
  };
};

// GET /api/builders (authenticated user's builders)
const getMyBuilders = async (userId) => {
  const result = await dynamodb.query({
    TableName: BUILDERS_TABLE,
    IndexName: 'user_id-index',
    KeyConditionExpression: 'user_id = :userId',
    ExpressionAttributeValues: { ':userId': userId }
  }).promise();

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({ builders: result.Items || [] })
  };
};

// POST /api/builders
const createBuilder = async (userId, body) => {
  const { name, slug, description, branding, theme, coverage } = body;

  // Validate required fields
  if (!name || !slug) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'name and slug are required' })
    };
  }

  // Validate slug format
  if (!isValidSlug(slug)) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'slug must be lowercase letters, numbers, and hyphens only (2-50 chars)' })
    };
  }

  // Validate theme
  const themeValidation = validateTheme(theme);
  if (!themeValidation.valid) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: themeValidation.error })
    };
  }

  // Validate coverage
  const coverageValidation = validateCoverage(coverage);
  if (!coverageValidation.valid) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: coverageValidation.error })
    };
  }

  // Check slug uniqueness
  const existing = await dynamodb.query({
    TableName: BUILDERS_TABLE,
    IndexName: 'slug-index',
    KeyConditionExpression: 'slug = :slug',
    ExpressionAttributeValues: { ':slug': slug }
  }).promise();

  if (existing.Items?.length > 0) {
    return {
      statusCode: 409,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Slug already taken' })
    };
  }

  // Create builder
  const now = new Date().toISOString();
  const builder = {
    id: uuidv4(),
    user_id: userId,
    name,
    slug,
    description: description || null,
    branding: branding || {},
    theme,
    coverage,
    status: 'draft',
    created_at: now,
    updated_at: now
  };

  await dynamodb.put({
    TableName: BUILDERS_TABLE,
    Item: builder
  }).promise();

  return {
    statusCode: 201,
    headers: getCorsHeaders(),
    body: JSON.stringify({ builder })
  };
};

// PUT /api/builders/:id
const updateBuilder = async (builderId, userId, platformAdmin, body) => {
  // Get existing builder
  const existing = await dynamodb.get({
    TableName: BUILDERS_TABLE,
    Key: { id: builderId }
  }).promise();

  if (!existing.Item) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Builder not found' })
    };
  }

  // Check ownership
  if (existing.Item.user_id !== userId && !platformAdmin) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Not authorized to update this builder' })
    };
  }

  // Build update expression
  const updates = [];
  const expressionValues = {};
  const expressionNames = {};

  if (body.name) {
    updates.push('#name = :name');
    expressionNames['#name'] = 'name';
    expressionValues[':name'] = body.name;
  }

  if (body.description !== undefined) {
    updates.push('description = :description');
    expressionValues[':description'] = body.description;
  }

  if (body.branding) {
    updates.push('branding = :branding');
    expressionValues[':branding'] = body.branding;
  }

  if (body.theme) {
    const themeValidation = validateTheme(body.theme);
    if (!themeValidation.valid) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: themeValidation.error })
      };
    }
    updates.push('theme = :theme');
    expressionValues[':theme'] = body.theme;
  }

  if (body.coverage) {
    const coverageValidation = validateCoverage(body.coverage);
    if (!coverageValidation.valid) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: coverageValidation.error })
      };
    }
    updates.push('coverage = :coverage');
    expressionValues[':coverage'] = body.coverage;
  }

  updates.push('updated_at = :updated_at');
  expressionValues[':updated_at'] = new Date().toISOString();

  const result = await dynamodb.update({
    TableName: BUILDERS_TABLE,
    Key: { id: builderId },
    UpdateExpression: 'SET ' + updates.join(', '),
    ExpressionAttributeValues: expressionValues,
    ExpressionAttributeNames: Object.keys(expressionNames).length > 0 ? expressionNames : undefined,
    ReturnValues: 'ALL_NEW'
  }).promise();

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({ builder: result.Attributes })
  };
};

// DELETE /api/builders/:id
const deleteBuilder = async (builderId, userId, platformAdmin) => {
  // Get existing builder
  const existing = await dynamodb.get({
    TableName: BUILDERS_TABLE,
    Key: { id: builderId }
  }).promise();

  if (!existing.Item) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Builder not found' })
    };
  }

  // Check ownership
  if (existing.Item.user_id !== userId && !platformAdmin) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Not authorized to delete this builder' })
    };
  }

  await dynamodb.delete({
    TableName: BUILDERS_TABLE,
    Key: { id: builderId }
  }).promise();

  return {
    statusCode: 204,
    headers: getCorsHeaders(),
    body: ''
  };
};

// PUT /api/builders/:id/publish
const publishBuilder = async (builderId, userId, platformAdmin) => {
  // Get existing builder
  const existing = await dynamodb.get({
    TableName: BUILDERS_TABLE,
    Key: { id: builderId }
  }).promise();

  if (!existing.Item) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Builder not found' })
    };
  }

  // Check ownership
  if (existing.Item.user_id !== userId && !platformAdmin) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Not authorized to publish this builder' })
    };
  }

  const result = await dynamodb.update({
    TableName: BUILDERS_TABLE,
    Key: { id: builderId },
    UpdateExpression: 'SET #status = :status, updated_at = :updated_at',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'published',
      ':updated_at': new Date().toISOString()
    },
    ReturnValues: 'ALL_NEW'
  }).promise();

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({ builder: result.Attributes })
  };
};

/**
 * Helper: Verify builder ownership
 */
const verifyBuilderOwnership = async (builderId, userId, platformAdmin) => {
  const existing = await dynamodb.get({
    TableName: BUILDERS_TABLE,
    Key: { id: builderId }
  }).promise();

  if (!existing.Item) {
    return { error: { statusCode: 404, message: 'Builder not found' } };
  }

  if (existing.Item.user_id !== userId && !platformAdmin) {
    return { error: { statusCode: 403, message: 'Not authorized to access this builder' } };
  }

  return { builder: existing.Item };
};

// GET /api/builders/:id/venues
const getBuilderVenues = async (builderId, userId, platformAdmin) => {
  const ownershipCheck = await verifyBuilderOwnership(builderId, userId, platformAdmin);
  if (ownershipCheck.error) {
    return {
      statusCode: ownershipCheck.error.statusCode,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: ownershipCheck.error.message })
    };
  }

  // Get builder-venue records
  const builderVenuesResult = await dynamodb.query({
    TableName: BUILDER_VENUES_TABLE,
    IndexName: 'builder_id-index',
    KeyConditionExpression: 'builder_id = :builderId',
    ExpressionAttributeValues: { ':builderId': builderId }
  }).promise();

  const builderVenues = builderVenuesResult.Items || [];

  if (builderVenues.length === 0) {
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({ venues: [] })
    };
  }

  // Batch get venue details
  const venueIds = builderVenues.map(bv => ({ id: bv.venue_id }));
  const venueDetailsResult = await dynamodb.batchGet({
    RequestItems: {
      [VENUES_TABLE]: { Keys: venueIds }
    }
  }).promise();

  const venueMap = {};
  (venueDetailsResult.Responses?.[VENUES_TABLE] || []).forEach(venue => {
    venueMap[venue.id] = venue;
  });

  // Merge venue details with builder-venue records
  const venuesWithDetails = builderVenues.map(bv => ({
    ...bv,
    venue: venueMap[bv.venue_id] || null
  }));

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({ venues: venuesWithDetails })
  };
};

// POST /api/builders/:id/venues
const addBuilderVenue = async (builderId, userId, platformAdmin, body) => {
  const ownershipCheck = await verifyBuilderOwnership(builderId, userId, platformAdmin);
  if (ownershipCheck.error) {
    return {
      statusCode: ownershipCheck.error.statusCode,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: ownershipCheck.error.message })
    };
  }

  const { venue_id, selection = 'manual', featured = false, display_order } = body;

  if (!venue_id) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'venue_id is required' })
    };
  }

  // Validate selection type
  if (!VALID_SELECTION_TYPES.includes(selection)) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: `selection must be one of: ${VALID_SELECTION_TYPES.join(', ')}` })
    };
  }

  // Check venue exists
  const venueResult = await dynamodb.get({
    TableName: VENUES_TABLE,
    Key: { id: venue_id }
  }).promise();

  if (!venueResult.Item) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Venue not found' })
    };
  }

  // Check venue not already added
  const existingResult = await dynamodb.query({
    TableName: BUILDER_VENUES_TABLE,
    IndexName: 'builder_id-index',
    KeyConditionExpression: 'builder_id = :builderId',
    FilterExpression: 'venue_id = :venueId',
    ExpressionAttributeValues: {
      ':builderId': builderId,
      ':venueId': venue_id
    }
  }).promise();

  if (existingResult.Items?.length > 0) {
    return {
      statusCode: 409,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Venue already added to this builder' })
    };
  }

  // Create builder-venue record
  const builderVenue = {
    id: uuidv4(),
    builder_id: builderId,
    venue_id,
    selection,
    featured,
    display_order: display_order || null,
    created_at: new Date().toISOString()
  };

  await dynamodb.put({
    TableName: BUILDER_VENUES_TABLE,
    Item: builderVenue
  }).promise();

  return {
    statusCode: 201,
    headers: getCorsHeaders(),
    body: JSON.stringify({ builderVenue })
  };
};

// PUT /api/builders/:id/venues/:venueId
const updateBuilderVenue = async (builderId, venueId, userId, platformAdmin, body) => {
  const ownershipCheck = await verifyBuilderOwnership(builderId, userId, platformAdmin);
  if (ownershipCheck.error) {
    return {
      statusCode: ownershipCheck.error.statusCode,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: ownershipCheck.error.message })
    };
  }

  // Find existing builder-venue record
  const existingResult = await dynamodb.query({
    TableName: BUILDER_VENUES_TABLE,
    IndexName: 'builder_id-index',
    KeyConditionExpression: 'builder_id = :builderId',
    FilterExpression: 'venue_id = :venueId',
    ExpressionAttributeValues: {
      ':builderId': builderId,
      ':venueId': venueId
    }
  }).promise();

  if (!existingResult.Items?.length) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Venue not configured for this builder' })
    };
  }

  const existing = existingResult.Items[0];

  // Build update expression
  const updates = [];
  const expressionValues = {};

  if (body.selection !== undefined) {
    if (!VALID_SELECTION_TYPES.includes(body.selection)) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: `selection must be one of: ${VALID_SELECTION_TYPES.join(', ')}` })
      };
    }
    updates.push('selection = :selection');
    expressionValues[':selection'] = body.selection;
  }

  if (body.featured !== undefined) {
    updates.push('featured = :featured');
    expressionValues[':featured'] = body.featured;
  }

  if (body.display_order !== undefined) {
    updates.push('display_order = :display_order');
    expressionValues[':display_order'] = body.display_order;
  }

  // Extended venue management fields
  if (body.standard_fee !== undefined) {
    updates.push('standard_fee = :standard_fee');
    expressionValues[':standard_fee'] = body.standard_fee;
  }

  if (body.payment_terms !== undefined) {
    updates.push('payment_terms = :payment_terms');
    expressionValues[':payment_terms'] = body.payment_terms;
  }

  if (body.notes !== undefined) {
    updates.push('notes = :notes');
    expressionValues[':notes'] = body.notes;
  }

  if (body.contact_name !== undefined) {
    updates.push('contact_name = :contact_name');
    expressionValues[':contact_name'] = body.contact_name;
  }

  if (body.contact_email !== undefined) {
    // Validate email format if provided (non-null)
    if (body.contact_email !== null && !isValidEmail(body.contact_email)) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Invalid email format for contact_email' })
      };
    }
    updates.push('contact_email = :contact_email');
    expressionValues[':contact_email'] = body.contact_email;
  }

  if (body.contact_phone !== undefined) {
    updates.push('contact_phone = :contact_phone');
    expressionValues[':contact_phone'] = body.contact_phone;
  }

  if (updates.length === 0) {
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({ builderVenue: existing })
    };
  }

  const result = await dynamodb.update({
    TableName: BUILDER_VENUES_TABLE,
    Key: { id: existing.id },
    UpdateExpression: 'SET ' + updates.join(', '),
    ExpressionAttributeValues: expressionValues,
    ReturnValues: 'ALL_NEW'
  }).promise();

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({ builderVenue: result.Attributes })
  };
};

// DELETE /api/builders/:id/venues/:venueId
const deleteBuilderVenue = async (builderId, venueId, userId, platformAdmin) => {
  const ownershipCheck = await verifyBuilderOwnership(builderId, userId, platformAdmin);
  if (ownershipCheck.error) {
    return {
      statusCode: ownershipCheck.error.statusCode,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: ownershipCheck.error.message })
    };
  }

  // Find existing builder-venue record
  const existingResult = await dynamodb.query({
    TableName: BUILDER_VENUES_TABLE,
    IndexName: 'builder_id-index',
    KeyConditionExpression: 'builder_id = :builderId',
    FilterExpression: 'venue_id = :venueId',
    ExpressionAttributeValues: {
      ':builderId': builderId,
      ':venueId': venueId
    }
  }).promise();

  if (!existingResult.Items?.length) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Venue not configured for this builder' })
    };
  }

  const existing = existingResult.Items[0];

  await dynamodb.delete({
    TableName: BUILDER_VENUES_TABLE,
    Key: { id: existing.id }
  }).promise();

  return {
    statusCode: 204,
    headers: getCorsHeaders(),
    body: ''
  };
};

// POST /api/builders/:id/venues/bulk
const bulkAddBuilderVenues = async (builderId, userId, platformAdmin, body) => {
  const ownershipCheck = await verifyBuilderOwnership(builderId, userId, platformAdmin);
  if (ownershipCheck.error) {
    return {
      statusCode: ownershipCheck.error.statusCode,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: ownershipCheck.error.message })
    };
  }

  // Validate venues array
  if (!body.venues || !Array.isArray(body.venues)) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'venues array is required' })
    };
  }

  // Validate each venue has venue_id
  for (const v of body.venues) {
    if (!v.venue_id) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Each venue must have a venue_id' })
      };
    }
    if (v.selection && !VALID_SELECTION_TYPES.includes(v.selection)) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: `selection must be one of: ${VALID_SELECTION_TYPES.join(', ')}` })
      };
    }
  }

  // Get existing builder-venues to check for duplicates
  const existingResult = await dynamodb.query({
    TableName: BUILDER_VENUES_TABLE,
    IndexName: 'builder_id-index',
    KeyConditionExpression: 'builder_id = :builderId',
    ExpressionAttributeValues: {
      ':builderId': builderId
    }
  }).promise();

  const existingVenueIds = new Set((existingResult.Items || []).map(bv => bv.venue_id));

  // Verify venues exist in bndy-venues table
  const venueIds = body.venues.map(v => v.venue_id);
  const uniqueVenueIds = [...new Set(venueIds)];

  if (uniqueVenueIds.length > 0) {
    const batchGetResult = await dynamodb.batchGet({
      RequestItems: {
        [VENUES_TABLE]: {
          Keys: uniqueVenueIds.map(id => ({ id }))
        }
      }
    }).promise();

    const foundVenueIds = new Set(
      (batchGetResult.Responses?.[VENUES_TABLE] || []).map(v => v.id)
    );

    // Filter to only valid venue IDs
    const validVenueIds = new Set(uniqueVenueIds.filter(id => foundVenueIds.has(id)));

    let created = 0;
    let skipped = 0;

    for (const venueInput of body.venues) {
      const { venue_id, selection = 'manual' } = venueInput;

      // Skip if venue doesn't exist in bndy-venues
      if (!validVenueIds.has(venue_id)) {
        skipped++;
        continue;
      }

      // Skip if already associated with this builder
      if (existingVenueIds.has(venue_id)) {
        skipped++;
        continue;
      }

      // Create new builder-venue record
      const builderVenue = {
        id: uuidv4(),
        builder_id: builderId,
        venue_id: venue_id,
        selection: selection,
        featured: false,
        display_order: null,
        created_at: new Date().toISOString()
      };

      await dynamodb.put({
        TableName: BUILDER_VENUES_TABLE,
        Item: builderVenue
      }).promise();

      created++;
      existingVenueIds.add(venue_id); // Track to avoid duplicates within batch
    }

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({ created, skipped })
    };
  }

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({ created: 0, skipped: body.venues.length })
  };
};

/**
 * Main handler - routes requests to appropriate functions
 */
exports.handler = async (event) => {
  currentEvent = event;

  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.path;

  // Handle OPTIONS preflight
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: ''
    };
  }

  // Public endpoint: GET /api/builders/by-subdomain/:slug
  if (method === 'GET' && path.match(/\/api\/builders\/by-subdomain\/[^/]+$/)) {
    const slug = event.pathParameters?.slug || path.split('/').pop();
    return getBuilderBySubdomain(slug);
  }

  // All other endpoints require authentication
  const authResult = await requireAuth(event);
  if (authResult.statusCode) {
    return authResult;
  }

  const { user } = authResult;
  const userId = user.userId;
  const platformAdmin = user.platformAdmin;

  // Check feature flag for write operations
  const writeOperations = ['POST', 'PUT', 'DELETE'];
  if (writeOperations.includes(method) && !isBuilderWhitelisted(userId, platformAdmin)) {
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Builder feature not enabled for this user' })
    };
  }

  // Parse body for POST/PUT
  let body = {};
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Invalid JSON body' })
      };
    }
  }

  // Route: GET /api/builders
  if (method === 'GET' && path === '/api/builders') {
    return getMyBuilders(userId);
  }

  // Route: POST /api/builders
  if (method === 'POST' && path === '/api/builders') {
    return createBuilder(userId, body);
  }

  // Route: PUT /api/builders/:id/publish
  if (method === 'PUT' && path.match(/\/api\/builders\/[^/]+\/publish$/)) {
    const builderId = event.pathParameters?.id || path.split('/')[3];
    return publishBuilder(builderId, userId, platformAdmin);
  }

  // Route: PUT /api/builders/:id
  if (method === 'PUT' && path.match(/\/api\/builders\/[^/]+$/)) {
    const builderId = event.pathParameters?.id || path.split('/')[3];
    return updateBuilder(builderId, userId, platformAdmin, body);
  }

  // Route: DELETE /api/builders/:id
  if (method === 'DELETE' && path.match(/\/api\/builders\/[^/]+$/) && !path.includes('/venues/')) {
    const builderId = event.pathParameters?.id || path.split('/')[3];
    return deleteBuilder(builderId, userId, platformAdmin);
  }

  // Route: GET /api/builders/:id/venues
  if (method === 'GET' && path.match(/\/api\/builders\/[^/]+\/venues$/)) {
    const builderId = event.pathParameters?.id || path.split('/')[3];
    return getBuilderVenues(builderId, userId, platformAdmin);
  }

  // Route: POST /api/builders/:id/venues/bulk (must come before regular POST venues)
  if (method === 'POST' && path.match(/\/api\/builders\/[^/]+\/venues\/bulk$/)) {
    const builderId = event.pathParameters?.id || path.split('/')[3];
    return bulkAddBuilderVenues(builderId, userId, platformAdmin, body);
  }

  // Route: POST /api/builders/:id/venues
  if (method === 'POST' && path.match(/\/api\/builders\/[^/]+\/venues$/)) {
    const builderId = event.pathParameters?.id || path.split('/')[3];
    return addBuilderVenue(builderId, userId, platformAdmin, body);
  }

  // Route: PUT /api/builders/:id/venues/:venueId
  if (method === 'PUT' && path.match(/\/api\/builders\/[^/]+\/venues\/[^/]+$/)) {
    const builderId = event.pathParameters?.id || path.split('/')[3];
    const venueId = event.pathParameters?.venueId || path.split('/')[5];
    return updateBuilderVenue(builderId, venueId, userId, platformAdmin, body);
  }

  // Route: DELETE /api/builders/:id/venues/:venueId
  if (method === 'DELETE' && path.match(/\/api\/builders\/[^/]+\/venues\/[^/]+$/)) {
    const builderId = event.pathParameters?.id || path.split('/')[3];
    const venueId = event.pathParameters?.venueId || path.split('/')[5];
    return deleteBuilderVenue(builderId, venueId, userId, platformAdmin);
  }

  // Unknown route
  return {
    statusCode: 404,
    headers: getCorsHeaders(),
    body: JSON.stringify({ error: 'Not found' })
  };
};
