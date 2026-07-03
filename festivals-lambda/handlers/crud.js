/**
 * Festival CRUD handlers
 * Per spec: festival-mcp-write-api-spec.md §1, §3
 */

const crypto = require('crypto');

// Table names
const FESTIVALS_TABLE = process.env.FESTIVALS_TABLE || 'bndy-events';
const ARTISTS_TABLE = process.env.ARTISTS_TABLE || 'bndy-artists';
const EVENTS_TABLE = process.env.EVENTS_TABLE || 'bndy-events';

// Validation constants
const MAX_DATE_RANGE_DAYS = 31;
const VALID_BILLING_TIERS = ['headline', 'special_guest', 'support', 'general', 'opener'];

/**
 * Generate URL-safe slug from name
 * @param {string} name - Festival name
 * @returns {string} Kebab-case slug
 */
function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Check if slug exists in database
 * @param {Object} dynamodb - DynamoDB client
 * @param {string} slug - Slug to check
 * @returns {Promise<boolean>}
 */
async function slugExists(dynamodb, slug) {
  const result = await dynamodb.query({
    TableName: FESTIVALS_TABLE,
    IndexName: 'bySlug',
    KeyConditionExpression: 'slug = :slug',
    ExpressionAttributeValues: { ':slug': slug }
  }).promise();
  return result.Items && result.Items.length > 0;
}

/**
 * Get unique slug, appending -2, -3, etc. if collision
 * @param {Object} dynamodb - DynamoDB client
 * @param {string} baseSlug - Base slug to check
 * @returns {Promise<string>} Unique slug
 */
async function getUniqueSlug(dynamodb, baseSlug) {
  let slug = baseSlug;
  let suffix = 1;

  while (await slugExists(dynamodb, slug)) {
    suffix++;
    slug = `${baseSlug}-${suffix}`;
  }

  return slug;
}

/**
 * Validate festival data
 * @param {Object} data - Festival data
 * @param {boolean} isCreate - Whether this is a create operation
 * @returns {{ valid: boolean, error?: string }}
 */
function validateFestival(data, isCreate = true) {
  // Required fields for create
  if (isCreate) {
    if (!data.name || typeof data.name !== 'string') {
      return { valid: false, error: 'name is required' };
    }
    if (!data.startDate) {
      return { valid: false, error: 'startDate is required' };
    }
  }

  // Date validation
  if (data.startDate && data.endDate) {
    const start = new Date(data.startDate);
    const end = new Date(data.endDate);

    if (start > end) {
      return { valid: false, error: 'startDate must be before or equal to endDate' };
    }

    const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
    if (daysDiff > MAX_DATE_RANGE_DAYS) {
      return { valid: false, error: `Festival date range cannot exceed 31 days (typo guard)` };
    }
  }

  // isPublic requires venue
  if (data.isPublic === true && !data.primaryVenueId && (!data.venueIds || data.venueIds.length === 0)) {
    return { valid: false, error: 'At least one venue is required for public festivals' };
  }

  // Slug is immutable after create
  if (!isCreate && data.slug !== undefined) {
    return { valid: false, error: 'slug is immutable and cannot be modified' };
  }

  // Validate lineup slots
  if (data.lineup && Array.isArray(data.lineup)) {
    for (const slot of data.lineup) {
      if (slot.billing && !VALID_BILLING_TIERS.includes(slot.billing)) {
        return { valid: false, error: `Invalid billing tier: ${slot.billing}. Must be one of: ${VALID_BILLING_TIERS.join(', ')}` };
      }
      if (slot.billingOrder !== undefined && (typeof slot.billingOrder !== 'number' || slot.billingOrder < 0)) {
        return { valid: false, error: 'billingOrder must be a non-negative integer' };
      }
    }
  }

  return { valid: true };
}

/**
 * Generate stage IDs for stages array
 * @param {Array} stages - Stages array
 * @returns {Array} Stages with IDs
 */
function processStages(stages) {
  if (!stages || !Array.isArray(stages)) return [];
  return stages.map(stage => ({
    id: crypto.randomUUID(),
    ...stage
  }));
}

/**
 * Generate slot IDs for lineup array
 * @param {Array} lineup - Lineup slots array
 * @returns {Array} Lineup with IDs
 */
function processLineup(lineup) {
  if (!lineup || !Array.isArray(lineup)) return [];
  return lineup.map(slot => ({
    id: crypto.randomUUID(),
    ...slot
  }));
}

/**
 * POST /festivals - Create a new festival
 */
async function handleCreateFestival(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  // Validate
  const validation = validateFestival(body, true);
  if (!validation.valid) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: validation.error })
    };
  }

  // Generate ID and slug
  const festivalId = crypto.randomUUID();
  const baseSlug = generateSlug(body.name);
  const slug = await getUniqueSlug(dynamodb, baseSlug);

  const now = new Date().toISOString();

  const item = {
    PK: `FESTIVAL#${festivalId}`,
    SK: 'META',
    id: festivalId,
    entityType: 'festival',
    slug,
    name: body.name,
    description: body.description,
    startDate: body.startDate,
    endDate: body.endDate || body.startDate, // Default to single day
    primaryVenueId: body.primaryVenueId,
    venueIds: body.venueIds || [],
    location: body.location,
    stages: processStages(body.stages),
    lineup: processLineup(body.lineup),
    ticketed: body.ticketed,
    price: body.price,
    ticketUrl: body.ticketUrl,
    lineupUrl: body.lineupUrl,
    websiteUrl: body.websiteUrl,
    socialMediaUrls: body.socialMediaUrls,
    heroImageUrl: body.heroImageUrl,
    posterImageUrl: body.posterImageUrl,
    theme: body.theme,
    isPublic: body.isPublic || false,
    source: body.source || 'bndy.core',
    externalIds: body.externalIds || [],
    createdAt: now,
    updatedAt: now
  };

  // Remove undefined values
  Object.keys(item).forEach(key => {
    if (item[key] === undefined) delete item[key];
  });

  await dynamodb.put({
    TableName: FESTIVALS_TABLE,
    Item: item
  }).promise();

  return {
    statusCode: 201,
    headers: getCorsHeaders(event),
    body: JSON.stringify({
      festivalId,
      slug,
      message: 'Festival created successfully'
    })
  };
}

/**
 * PATCH /festivals/{id} - Update a festival
 */
async function handleUpdateFestival(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const { id } = event.pathParameters || {};

  if (!id) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Festival ID is required' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  // Validate
  const validation = validateFestival(body, false);
  if (!validation.valid) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: validation.error })
    };
  }

  // Fetch existing festival
  const existing = await dynamodb.get({
    TableName: FESTIVALS_TABLE,
    Key: { PK: `FESTIVAL#${id}`, SK: 'META' }
  }).promise();

  if (!existing.Item) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Festival not found' })
    };
  }

  // Handle externalIds merge
  let externalIds = existing.Item.externalIds || [];
  if (body.externalIds) {
    if (body.replaceExternalIds) {
      externalIds = body.externalIds;
    } else {
      // Additive merge - dedupe by source+id
      const existingSet = new Set(externalIds.map(e => `${e.source}:${e.id}`));
      for (const ext of body.externalIds) {
        const key = `${ext.source}:${ext.id}`;
        if (!existingSet.has(key)) {
          externalIds.push(ext);
          existingSet.add(key);
        }
      }
    }
    delete body.replaceExternalIds;
  }

  // Build update expression
  const updateFields = { ...body, externalIds, updatedAt: new Date().toISOString() };
  delete updateFields.slug; // Immutable

  const updateExpressions = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {};

  Object.entries(updateFields).forEach(([key, value]) => {
    if (value !== undefined) {
      const attrName = `#${key}`;
      const attrValue = `:${key}`;
      updateExpressions.push(`${attrName} = ${attrValue}`);
      expressionAttributeNames[attrName] = key;
      expressionAttributeValues[attrValue] = value;
    }
  });

  if (updateExpressions.length === 0) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'No fields to update' })
    };
  }

  const result = await dynamodb.update({
    TableName: FESTIVALS_TABLE,
    Key: { PK: `FESTIVAL#${id}`, SK: 'META' },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW'
  }).promise();

  return {
    statusCode: 200,
    headers: getCorsHeaders(event),
    body: JSON.stringify({
      festival: result.Attributes,
      message: 'Festival updated successfully'
    })
  };
}

/**
 * GET /festivals - Search festivals
 */
async function handleSearchFestivals(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const { name, town, dateFrom, dateTo } = event.queryStringParameters || {};

  // Scan with filter (for MVP; can optimize with GSI later)
  const filterExpressions = ['entityType = :festival'];
  const expressionAttributeValues = { ':festival': 'festival' };

  if (dateFrom) {
    filterExpressions.push('startDate >= :dateFrom');
    expressionAttributeValues[':dateFrom'] = dateFrom;
  }
  if (dateTo) {
    filterExpressions.push('endDate <= :dateTo');
    expressionAttributeValues[':dateTo'] = dateTo;
  }

  console.log('[FESTIVALS_SEARCH] DEBUG v2 - Scanning with:', {
    table: FESTIVALS_TABLE,
    filter: filterExpressions.join(' AND '),
    values: expressionAttributeValues,
    timestamp: new Date().toISOString()
  });

  // Paginated scan to get all festivals
  let festivals = [];
  let lastEvaluatedKey = undefined;
  let totalScanned = 0;

  do {
    const params = {
      TableName: FESTIVALS_TABLE,
      FilterExpression: filterExpressions.join(' AND '),
      ExpressionAttributeValues: expressionAttributeValues
    };
    if (lastEvaluatedKey) {
      params.ExclusiveStartKey = lastEvaluatedKey;
    }

    const result = await dynamodb.scan(params).promise();
    totalScanned += result.ScannedCount || 0;

    if (result.Items && result.Items.length > 0) {
      festivals = festivals.concat(result.Items);
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log('[FESTIVALS_SEARCH] Scan complete:', {
    festivalCount: festivals.length,
    totalScanned
  });

  // Filter by name (case-insensitive contains)
  if (name) {
    const nameLower = name.toLowerCase();
    festivals = festivals.filter(f => f.name && f.name.toLowerCase().includes(nameLower));
  }

  // Filter by town (case-insensitive contains)
  if (town) {
    const townLower = town.toLowerCase();
    festivals = festivals.filter(f => f.town && f.town.toLowerCase().includes(townLower));
  }

  return {
    statusCode: 200,
    headers: getCorsHeaders(event),
    body: JSON.stringify({
      festivals: festivals.map(f => ({
        id: f.id,
        slug: f.slug,
        name: f.name,
        startDate: f.startDate,
        endDate: f.endDate,
        town: f.town,
        venueIds: f.venueIds,
        actCount: (f.lineup || []).length
      }))
    })
  };
}

/**
 * GET /api/festivals/public - Get public festivals
 */
async function handleGetPublicFestivals(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const { startDate, endDate } = event.queryStringParameters || {};

  const filterExpressions = ['entityType = :festival', 'isPublic = :true'];
  const expressionAttributeValues = { ':festival': 'festival', ':true': true };

  if (startDate) {
    filterExpressions.push('endDate >= :startDate');
    expressionAttributeValues[':startDate'] = startDate;
  }
  if (endDate) {
    filterExpressions.push('startDate <= :endDate');
    expressionAttributeValues[':endDate'] = endDate;
  }

  // Paginated scan to get all public festivals
  let allItems = [];
  let lastEvaluatedKey = undefined;

  do {
    const params = {
      TableName: FESTIVALS_TABLE,
      FilterExpression: filterExpressions.join(' AND '),
      ExpressionAttributeValues: expressionAttributeValues
    };
    if (lastEvaluatedKey) {
      params.ExclusiveStartKey = lastEvaluatedKey;
    }

    const result = await dynamodb.scan(params).promise();
    if (result.Items && result.Items.length > 0) {
      allItems = allItems.concat(result.Items);
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  const festivals = allItems.map(f => ({
    id: f.id,
    slug: f.slug,
    name: f.name,
    startDate: f.startDate,
    endDate: f.endDate,
    town: f.town,
    venueIds: f.venueIds,
    posterImageUrl: f.posterImageUrl,
    price: f.price,
    actCount: (f.lineup || []).length
  }));

  return {
    statusCode: 200,
    headers: {
      ...getCorsHeaders(event),
      'Cache-Control': 'public, max-age=60'
    },
    body: JSON.stringify({ festivals })
  };
}

/**
 * GET /api/festivals/slug/{slug} - Get festival by slug with lineup and child events
 */
async function handleGetFestivalBySlug(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const { slug } = event.pathParameters || {};

  if (!slug) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Slug is required' })
    };
  }

  // Query by slug GSI
  const festivalResult = await dynamodb.query({
    TableName: FESTIVALS_TABLE,
    IndexName: 'bySlug',
    KeyConditionExpression: 'slug = :slug',
    ExpressionAttributeValues: { ':slug': slug }
  }).promise();

  if (!festivalResult.Items || festivalResult.Items.length === 0) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Festival not found' })
    };
  }

  const festival = festivalResult.Items[0];

  // Query child events via byFestival GSI
  const eventsResult = await dynamodb.query({
    TableName: EVENTS_TABLE,
    IndexName: 'byFestival',
    KeyConditionExpression: 'festivalId = :festivalId',
    ExpressionAttributeValues: { ':festivalId': festival.id }
  }).promise();

  const childEvents = eventsResult.Items || [];

  // Enrich lineup slots with artist names
  const artistIds = new Set();
  if (festival.lineup) {
    festival.lineup.forEach(slot => {
      if (slot.artistId) artistIds.add(slot.artistId);
    });
  }
  childEvents.forEach(e => {
    if (e.artistId) artistIds.add(e.artistId);
  });

  // Batch get artists
  let artistMap = {};
  if (artistIds.size > 0) {
    const artistResult = await dynamodb.batchGet({
      RequestItems: {
        [ARTISTS_TABLE]: {
          Keys: [...artistIds].map(id => ({ id }))
        }
      }
    }).promise();

    const artists = artistResult.Responses?.[ARTISTS_TABLE] || [];
    artistMap = Object.fromEntries(artists.map(a => [a.id, a]));
  }

  // Add artist names to lineup
  if (festival.lineup) {
    festival.lineup = festival.lineup.map(slot => ({
      ...slot,
      artistName: slot.artistId ? artistMap[slot.artistId]?.name : undefined
    }));
  }

  return {
    statusCode: 200,
    headers: {
      ...getCorsHeaders(event),
      'Cache-Control': 'public, max-age=60'
    },
    body: JSON.stringify({
      festival,
      childEvents
    })
  };
}

module.exports = {
  handleCreateFestival,
  handleUpdateFestival,
  handleSearchFestivals,
  handleGetPublicFestivals,
  handleGetFestivalBySlug,
  // Export for testing
  validateFestival,
  generateSlug,
  VALID_BILLING_TIERS
};
