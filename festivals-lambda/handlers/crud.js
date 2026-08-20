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

  // isPublic requires venue. On UPDATE this check runs against the MERGED
  // state in handleUpdateFestival (2026-08-20 fix: a lone isPublic patch on a
  // festival with stored venues was wrongly rejected here).
  if (isCreate && data.isPublic === true && !data.primaryVenueId && (!data.venueIds || data.venueIds.length === 0)) {
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
 * Strip internal Dynamo attributes before returning a festival (#97c)
 */
function sanitizeFestival(festival) {
  if (!festival) return festival;
  const { PK, SK, ...rest } = festival;
  return rest;
}

/**
 * Union of primaryVenueId + venueIds for summary payloads (#97d)
 */
function allVenueIds(festival) {
  return [...new Set([festival.primaryVenueId, ...(festival.venueIds || [])].filter(Boolean))];
}

/**
 * Lineup slot dedup key: (displayName lowercased, day, stageId) per spec 2.4
 */
function slotDedupKey(slot) {
  return `${(slot.displayName || '').toLowerCase().trim()}|${slot.day || ''}|${slot.stageId || ''}`;
}

/**
 * Validate one lineup slot input. Returns error string or null.
 */
function validateSlotInput(slot) {
  if (!slot.displayName || typeof slot.displayName !== 'string') {
    return 'displayName is required on every lineup slot';
  }
  if (slot.billing && !VALID_BILLING_TIERS.includes(slot.billing)) {
    return `Invalid billing tier: ${slot.billing}. Must be one of: ${VALID_BILLING_TIERS.join(', ')}`;
  }
  if (slot.billingOrder !== undefined && (typeof slot.billingOrder !== 'number' || slot.billingOrder < 0)) {
    return 'billingOrder must be a non-negative integer';
  }
  return null;
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
    // Curator builder audit fields; undefined for MCP/agent creates and stripped below.
    createdBy: body.createdBy,
    createdByName: body.createdByName,
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
 * PATCH /festivals/{id} - Update a festival.
 * #97a: the bndy-events table uses a SIMPLE key `id` (see every other lambda:
 * Key: { id }). The original PK/SK composite Key threw ValidationException on
 * every get/update -> 500. PK/SK remain as plain attributes on old items; they
 * are never used as keys.
 * Also implements the lineup operations the MCP tools send:
 *   { addLineupSlots: [...] }              <- add_lineup_slot (batch, server dedup)
 *   { resolveSlot: { slotId, artistId?, eventId? } } <- resolve_lineup_slot
 *   { removeSlotId: "..." }                <- resolve_lineup_slot(remove: true)
 * Any other body = plain partial field update.
 */
async function handleUpdateFestival(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const { id } = event.pathParameters || {};
  const respond = (statusCode, payload) => ({
    statusCode,
    headers: getCorsHeaders(event),
    body: JSON.stringify(payload)
  });

  if (!id) {
    return respond(400, { error: 'Festival ID is required' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return respond(400, { error: 'Invalid JSON body' });
  }

  // Validate plain-update fields (slug immutability, dates, lineup tiers)
  const validation = validateFestival(body, false);
  if (!validation.valid) {
    return respond(400, { error: validation.error });
  }

  // Fetch existing festival (table key is `id`)
  const existing = await dynamodb.get({
    TableName: FESTIVALS_TABLE,
    Key: { id }
  }).promise();

  if (!existing.Item) {
    return respond(404, { error: 'Festival not found' });
  }

  // Publish gate against the MERGED state: the payload's venues if sent,
  // otherwise the stored ones. (2026-08-20 fix - was payload-only.)
  if (body.isPublic === true) {
    const mergedPrimary = body.primaryVenueId !== undefined ? body.primaryVenueId : existing.Item.primaryVenueId;
    const mergedVenueIds = body.venueIds !== undefined ? body.venueIds : (existing.Item.venueIds || []);
    if (!mergedPrimary && mergedVenueIds.length === 0) {
      return respond(400, { error: 'At least one venue is required for public festivals' });
    }
  }

  const now = new Date().toISOString();
  const putLineup = async (lineup) => {
    await dynamodb.update({
      TableName: FESTIVALS_TABLE,
      Key: { id },
      UpdateExpression: 'SET lineup = :lineup, updatedAt = :now',
      ExpressionAttributeValues: { ':lineup': lineup, ':now': now }
    }).promise();
  };

  // --- Lineup op: add slots (batch, dedup on displayName+day+stageId) ---
  if (body.addLineupSlots !== undefined) {
    if (!Array.isArray(body.addLineupSlots) || body.addLineupSlots.length === 0) {
      return respond(400, { error: 'addLineupSlots must be a non-empty array' });
    }
    for (const slot of body.addLineupSlots) {
      const err = validateSlotInput(slot);
      if (err) return respond(400, { error: err });
    }

    const lineup = [...(existing.Item.lineup || [])];
    const byKey = new Map(lineup.map(sl => [slotDedupKey(sl), sl]));
    const resultSlots = [];
    let added = 0;

    for (const input of body.addLineupSlots) {
      const key = slotDedupKey(input);
      const match = byKey.get(key);
      if (match) {
        // Dedup hit: return the existing slot so re-runs still yield slot ids
        resultSlots.push(match);
        continue;
      }
      const slot = { id: crypto.randomUUID(), ...input };
      lineup.push(slot);
      byKey.set(key, slot);
      resultSlots.push(slot);
      added++;
    }

    await putLineup(lineup);
    return respond(200, {
      slots: resultSlots,
      added,
      deduped: resultSlots.length - added,
      message: `${added} slot(s) added, ${resultSlots.length - added} already existed`
    });
  }

  // --- Lineup op: resolve a slot to artist and/or event ---
  if (body.resolveSlot !== undefined) {
    const { slotId, artistId, eventId } = body.resolveSlot || {};
    if (!slotId) {
      return respond(400, { error: 'resolveSlot.slotId is required' });
    }
    const lineup = [...(existing.Item.lineup || [])];
    const idx = lineup.findIndex(sl => sl.id === slotId);
    if (idx === -1) {
      return respond(404, { error: `Lineup slot ${slotId} not found` });
    }
    const slot = { ...lineup[idx] };
    if (artistId !== undefined) slot.artistId = artistId;
    if (eventId !== undefined) slot.eventId = eventId;
    slot.resolved = Boolean(slot.artistId && slot.eventId);
    lineup[idx] = slot;

    await putLineup(lineup);
    return respond(200, { slot, message: 'Lineup slot updated' });
  }

  // --- Lineup op: remove a slot (act dropped from the bill) ---
  if (body.removeSlotId !== undefined) {
    const before = existing.Item.lineup || [];
    const lineup = before.filter(sl => sl.id !== body.removeSlotId);
    if (lineup.length === before.length) {
      return respond(404, { error: `Lineup slot ${body.removeSlotId} not found` });
    }
    await putLineup(lineup);
    return respond(200, { removed: true, slotId: body.removeSlotId, message: 'Lineup slot removed' });
  }

  // --- Plain partial field update ---
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
  const updateFields = { ...body, externalIds, updatedAt: now };
  // Immutable / internal fields must never be SET
  ['slug', 'id', 'PK', 'SK', 'entityType', 'createdAt', 'festivalId'].forEach(k => delete updateFields[k]);

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
    return respond(400, { error: 'No fields to update' });
  }

  const result = await dynamodb.update({
    TableName: FESTIVALS_TABLE,
    Key: { id },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW'
  }).promise();

  return respond(200, {
    festival: sanitizeFestival(result.Attributes),
    message: 'Festival updated successfully'
  });
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
        venueIds: allVenueIds(f),
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
    venueIds: allVenueIds(f),
    posterImageUrl: f.posterImageUrl,
    price: f.price,
    ticketed: f.ticketed,
    ticketUrl: f.ticketUrl,
    lineupUrl: f.lineupUrl,
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
      festival: sanitizeFestival(festival),
      childEvents
    })
  };
}

/**
 * GET /api/festivals/by-external-id?source=&id= (#97b)
 * Idempotent-import lookup; response shape matches the other by-external-id
 * endpoints ({ found, festival }).
 */
async function handleGetFestivalByExternalId(deps, event) {
  const { dynamodb, getCorsHeaders } = deps;
  const { source, id } = event.queryStringParameters || {};

  if (!source || !id) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'source and id query parameters are required' })
    };
  }

  // Paginated scan over festival items (small entity count; same MVP pattern as search)
  let festivals = [];
  let lastEvaluatedKey = undefined;
  do {
    const params = {
      TableName: FESTIVALS_TABLE,
      FilterExpression: 'entityType = :festival',
      ExpressionAttributeValues: { ':festival': 'festival' }
    };
    if (lastEvaluatedKey) params.ExclusiveStartKey = lastEvaluatedKey;
    const result = await dynamodb.scan(params).promise();
    if (result.Items && result.Items.length > 0) festivals = festivals.concat(result.Items);
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  const match = festivals.find(f =>
    (f.externalIds || []).some(e => e.source === source && String(e.id) === String(id))
  );

  if (!match) {
    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ found: false })
    };
  }

  return {
    statusCode: 200,
    headers: getCorsHeaders(event),
    body: JSON.stringify({
      found: true,
      festival: {
        id: match.id,
        name: match.name,
        slug: match.slug,
        startDate: match.startDate,
        endDate: match.endDate,
        town: match.town,
        venueIds: allVenueIds(match),
        isPublic: match.isPublic,
        externalIds: match.externalIds || []
      }
    })
  };
}

module.exports = {
  handleCreateFestival,
  handleUpdateFestival,
  handleGetFestivalByExternalId,
  handleSearchFestivals,
  handleGetPublicFestivals,
  handleGetFestivalBySlug,
  // Export for testing
  validateFestival,
  generateSlug,
  VALID_BILLING_TIERS
};
