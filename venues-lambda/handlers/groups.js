/**
 * Venue ownership groups — backlog feature 19.
 *
 *   GET  /api/venue-groups            list every group          public
 *   GET  /api/venue-groups/{slug}     one group + its venues    public
 *   POST /api/venue-groups            create                    staff
 *   PUT  /api/venue-groups/{id}       edit                      staff
 *   PUT  /api/venues/{id}/group       set or clear a venue's group + tenure   staff
 *
 * WHY A SEPARATE TABLE. Groups live in `bndy-venue-groups`, NOT in
 * `bndy-venues`. Several venue read paths scan or query that table, and a group
 * row carries no coordinates, so it would leak into venue lists and the map.
 * Same reasoning as the uniqueness sentinels, which live apart for exactly this
 * reason. (Festivals put their parent record inside `bndy-events`. Not repeated.)
 *
 * OWNERSHIP IS NOT SCOPE. Jason ruling 2026-08-13. A venue has exactly ONE
 * owner group: it is a fact about the venue. A venue belongs to MANY scopes: an
 * edition, a festival trail, a partner site. Scope is feature 16 (Editions),
 * which resolves a venue SET from postcode areas, a polygon, an owner group and
 * an explicit list. This file only does ownership. It never does scope.
 *
 * IDENTITY STAYS LOCKED. Jason ruling 2026-08-11. Nothing here writes name,
 * address, postcode, city, googlePlaceId or coordinates. A group owns brand and
 * estate data. It does not own the verified location.
 *
 * V1 IS GODMODE ONLY. Nothing renders publicly yet. The public GET routes exist
 * so the godmode screen and, later, Editions can read without a second lambda.
 */

'use strict';

const crypto = require('crypto');
const { requireRole, logActivity } = require('../lib/curator-core');

/**
 * Staff by cookie, OR the MCP service token by Bearer header.
 *
 * WHY. `requireRole` reads the bndy_session cookie. An importer has no cookie.
 * It has the same machine credential that already gates the /mcp write routes
 * on venues, artists and events (see handler.js requireAuth). Ownership is
 * staff-level data and the importer is staff-level software, so one gate covers
 * both. Without this a 235 pub estate must be assigned by hand.
 *
 * ⚠ The token is compared in constant time. A length check first is safe: it
 * leaks length, not content, and timingSafeEqual throws on a length mismatch.
 */
const MCP_GATE = Object.freeze({
  user: { userId: 'mcp-service', platformAdmin: true, isService: true },
  dbUser: { display_name: 'MCP' },
  role: 'staff'
});

function isMcpService(event) {
  const header = event.headers?.Authorization || event.headers?.authorization || '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice(7);
  const serviceToken = process.env.MCP_SERVICE_TOKEN;
  if (!token || !serviceToken) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(serviceToken);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function requireStaffOrMcp(deps, event) {
  if (isMcpService(event)) return MCP_GATE;
  return requireRole(deps, event, ['staff']);
}

const VENUES_TABLE = 'bndy-venues';
const GROUPS_TABLE = process.env.VENUE_GROUPS_TABLE || 'bndy-venue-groups';

/** Robinsons is a brewery. Amber Taverns is a pubco. The enum cannot say "brewery". */
const GROUP_TYPES = ['brewery', 'pubco', 'chain', 'operator'];

/**
 * Who owns the bricks is not who runs the pub.
 *   owned       the group owns it. Managed or tenanted is not yet recorded.
 *   independent no parent. A free house.
 *   unknown     we have not checked. THE DEFAULT. Blank beats wrong.
 *
 * The managed vs tenanted split arrives when claiming needs it, because that is
 * when it decides who controls the page. Adding a value is not a migration.
 */
const TENURES = ['unknown', 'independent', 'owned'];

/** Fields a staff user may write on a group. Everything else is derived. */
const GROUP_FIELDS = ['name', 'groupType', 'website', 'facebookUrl', 'logoUrl', 'bio'];

const respond = (deps, event, statusCode, body) => ({
  statusCode,
  headers: deps.getCorsHeaders(event),
  body: JSON.stringify(body)
});

/** URL-safe slug. "Robinsons Brewery" -> "robinsons-brewery". */
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function parseBody(event) {
  try {
    return { body: JSON.parse(event.body || '{}') };
  } catch {
    return { error: 'Invalid JSON body' };
  }
}

function pick(body, fields) {
  const out = {};
  for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

/* ------------------------------------------------------------------ reads */

/**
 * GET /api/venue-groups
 *
 * `venueCount` is DERIVED here, not read from the group record.
 *
 * The stored counter drifts. It only moves when a caller uses
 * `PUT /api/venues/:id/group`, and any other write path that touches
 * `ownerGroupId` leaves it behind with no way to repair it. That happened on
 * 2026-08-14: an MCP edit wrote the id through the generic venue PUT and the
 * group showed 0 venues while owning 1. A number that can be wrong and cannot
 * be corrected is worse than a number that costs one query.
 *
 * Cost: one COUNT query per group. This table holds tens of rows.
 */
async function handleListGroups(deps, event) {
  const { dynamodb } = deps;
  const result = await dynamodb.scan({ TableName: GROUPS_TABLE }).promise();
  const groups = (result.Items || []).sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const counted = await Promise.all(groups.map(async (g) => {
    try {
      const r = await dynamodb.query({
        TableName: VENUES_TABLE,
        IndexName: 'ownerGroupId-index',
        KeyConditionExpression: 'ownerGroupId = :g',
        ExpressionAttributeValues: { ':g': g.id },
        Select: 'COUNT'
      }).promise();
      return { ...g, venueCount: r.Count || 0 };
    } catch (e) {
      // The index is the only source of truth. If it is unavailable, say so
      // rather than reporting a stale stored number as if it were current.
      console.warn('VENUE_GROUP: count query failed', g.id, e.message);
      return { ...g, venueCount: null };
    }
  }));

  return respond(deps, event, 200, { groups: counted });
}

/**
 * GET /api/venue-groups/{slug}
 * Returns the group plus its estate. The estate comes from the
 * `ownerGroupId-index` GSI, so this is a query and not a scan: it has to stay
 * correct at 25,000 venues, not just at today's 2,585.
 */
async function handleGetGroup(deps, event) {
  const { dynamodb } = deps;
  const slug = event.pathParameters?.slug;
  if (!slug) return respond(deps, event, 400, { error: 'Group slug is required' });

  const found = await dynamodb.scan({
    TableName: GROUPS_TABLE,
    FilterExpression: 'slug = :s',
    ExpressionAttributeValues: { ':s': slug }
  }).promise();

  const group = (found.Items || [])[0];
  if (!group) return respond(deps, event, 404, { error: 'Group not found' });

  const estate = await dynamodb.query({
    TableName: VENUES_TABLE,
    IndexName: 'ownerGroupId-index',
    KeyConditionExpression: 'ownerGroupId = :g',
    ExpressionAttributeValues: { ':g': group.id },
    ProjectionExpression: 'id, #n, city, postcode, tenure, profileImageUrl',
    ExpressionAttributeNames: { '#n': 'name' }
  }).promise();

  const venues = (estate.Items || []).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  // Same rule as the list: the count is derived, never the stored field.
  return respond(deps, event, 200, { group: { ...group, venueCount: venues.length }, venues, venueCount: venues.length });
}

/* ----------------------------------------------------------------- writes */

/** POST /api/venue-groups — staff only. */
async function handleCreateGroup(deps, event) {
  const gate = await requireStaffOrMcp(deps, event);
  if (gate.error) return respond(deps, event, gate.statusCode, { error: gate.error });

  const parsed = parseBody(event);
  if (parsed.error) return respond(deps, event, 400, { error: parsed.error });
  const body = parsed.body;

  if (!body.name || !String(body.name).trim()) {
    return respond(deps, event, 400, { error: 'name is required' });
  }
  if (!GROUP_TYPES.includes(body.groupType)) {
    return respond(deps, event, 400, {
      error: `groupType must be one of: ${GROUP_TYPES.join(', ')}`,
      code: 'INVALID_GROUP_TYPE'
    });
  }

  const slug = slugify(body.name);
  if (!slug) return respond(deps, event, 400, { error: 'name must contain letters or digits' });

  // A duplicate group is worse than a missing one: two Robinsons records would
  // split the estate in half and neither would look wrong on screen.
  const clash = await dynamodb_scanSlug(deps, slug);
  if (clash) {
    return respond(deps, event, 409, {
      error: 'A group with that name already exists',
      code: 'DUPLICATE_GROUP',
      existingId: clash.id
    });
  }

  const now = new Date().toISOString();
  const item = {
    id: crypto.randomUUID(),
    slug,
    ...pick(body, GROUP_FIELDS),
    name: String(body.name).trim(),
    venueCount: 0,
    createdAt: now,
    updatedAt: now
  };

  await deps.dynamodb.put({ TableName: GROUPS_TABLE, Item: item }).promise();

  await logActivity(deps.dynamodb, {
    actorCognitoId: gate.user.userId,
    actorName: gate.dbUser?.display_name,
    action: 'create',
    entityType: 'venue-group',
    entityId: item.id,
    entityName: item.name
  });

  return respond(deps, event, 201, { group: item });
}

/** PUT /api/venue-groups/{id} — staff only. Slug follows the name. */
async function handleUpdateGroup(deps, event) {
  const gate = await requireStaffOrMcp(deps, event);
  if (gate.error) return respond(deps, event, gate.statusCode, { error: gate.error });

  const id = event.pathParameters?.id;
  if (!id) return respond(deps, event, 400, { error: 'Group ID is required' });

  const parsed = parseBody(event);
  if (parsed.error) return respond(deps, event, 400, { error: parsed.error });

  const fields = pick(parsed.body, GROUP_FIELDS);
  if (Object.keys(fields).length === 0) {
    return respond(deps, event, 400, { error: `No editable field in body. Allowed: ${GROUP_FIELDS.join(', ')}` });
  }
  if (fields.groupType !== undefined && !GROUP_TYPES.includes(fields.groupType)) {
    return respond(deps, event, 400, {
      error: `groupType must be one of: ${GROUP_TYPES.join(', ')}`,
      code: 'INVALID_GROUP_TYPE'
    });
  }

  const existing = await deps.dynamodb.get({ TableName: GROUPS_TABLE, Key: { id } }).promise();
  if (!existing.Item) return respond(deps, event, 404, { error: 'Group not found' });

  if (fields.name !== undefined) {
    fields.name = String(fields.name).trim();
    if (!fields.name) return respond(deps, event, 400, { error: 'name cannot be empty' });
    const newSlug = slugify(fields.name);
    const clash = await dynamodb_scanSlug(deps, newSlug);
    if (clash && clash.id !== id) {
      return respond(deps, event, 409, { error: 'A group with that name already exists', code: 'DUPLICATE_GROUP', existingId: clash.id });
    }
    fields.slug = newSlug;
  }

  const names = {}, values = {}, sets = [];
  for (const [k, v] of Object.entries({ ...fields, updatedAt: new Date().toISOString() })) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }

  const updated = await deps.dynamodb.update({
    TableName: GROUPS_TABLE,
    Key: { id },
    UpdateExpression: `SET ${sets.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW'
  }).promise();

  // The venue rows carry a denormalised ownerGroupName, the same pattern events
  // use for festivalName. A rename must sweep the estate or the two disagree.
  if (fields.name !== undefined) {
    await renameEstate(deps, id, fields.name);
  }

  await logActivity(deps.dynamodb, {
    actorCognitoId: gate.user.userId,
    actorName: gate.dbUser?.display_name,
    action: 'edit',
    entityType: 'venue-group',
    entityId: id,
    entityName: updated.Attributes?.name
  });

  return respond(deps, event, 200, { group: updated.Attributes });
}

/**
 * PUT /api/venues/{id}/group — staff only.
 *
 * Body: { ownerGroupId: string|null, tenure?: 'unknown'|'independent'|'owned' }
 *
 * Sets or clears a venue's owner group. This route writes FOUR fields and no
 * others. It can never reach name, address, postcode, city, googlePlaceId or
 * coordinates, so the 2026-08-11 identity ruling holds by construction rather
 * than by a whitelist someone can widen later.
 */
async function handleSetVenueGroup(deps, event) {
  const gate = await requireStaffOrMcp(deps, event);
  if (gate.error) return respond(deps, event, gate.statusCode, { error: gate.error });

  const id = event.pathParameters?.id;
  if (!id) return respond(deps, event, 400, { error: 'Venue ID is required' });

  const parsed = parseBody(event);
  if (parsed.error) return respond(deps, event, 400, { error: parsed.error });
  const { ownerGroupId, tenure } = parsed.body;

  if (tenure !== undefined && !TENURES.includes(tenure)) {
    return respond(deps, event, 400, { error: `tenure must be one of: ${TENURES.join(', ')}`, code: 'INVALID_TENURE' });
  }

  const venue = await deps.dynamodb.get({ TableName: VENUES_TABLE, Key: { id } }).promise();
  if (!venue.Item) return respond(deps, event, 404, { error: 'Venue not found' });

  const now = new Date().toISOString();

  // Clearing the group. A venue with no parent is not automatically independent:
  // it may simply be unchecked. Only an explicit tenure says which.
  if (ownerGroupId === null || ownerGroupId === '') {
    await deps.dynamodb.update({
      TableName: VENUES_TABLE,
      Key: { id },
      UpdateExpression: 'REMOVE ownerGroupId, ownerGroupName SET tenure = :t, tenureCheckedAt = :n, updatedAt = :n',
      ExpressionAttributeValues: { ':t': tenure || 'unknown', ':n': now }
    }).promise();

    await adjustCount(deps, venue.Item.ownerGroupId, -1);
    await logActivity(deps.dynamodb, {
      actorCognitoId: gate.user.userId,
      actorName: gate.dbUser?.display_name,
      action: 'edit',
      entityType: 'venue',
      entityId: id,
      entityName: venue.Item.name,
      detail: 'owner group cleared'
    });
    return respond(deps, event, 200, { venueId: id, ownerGroupId: null, tenure: tenure || 'unknown' });
  }

  if (!ownerGroupId) return respond(deps, event, 400, { error: 'ownerGroupId is required, or null to clear' });

  const group = await deps.dynamodb.get({ TableName: GROUPS_TABLE, Key: { id: ownerGroupId } }).promise();
  if (!group.Item) return respond(deps, event, 404, { error: 'Group not found', code: 'GROUP_NOT_FOUND' });

  await deps.dynamodb.update({
    TableName: VENUES_TABLE,
    Key: { id },
    UpdateExpression: 'SET ownerGroupId = :g, ownerGroupName = :gn, tenure = :t, tenureCheckedAt = :n, updatedAt = :n',
    ExpressionAttributeValues: {
      ':g': ownerGroupId,
      ':gn': group.Item.name,
      // A venue being assigned to a group IS owned by it. `unknown` here would
      // be false modesty: the fact we are recording is the ownership itself.
      ':t': tenure || 'owned',
      ':n': now
    }
  }).promise();

  if (venue.Item.ownerGroupId !== ownerGroupId) {
    await adjustCount(deps, venue.Item.ownerGroupId, -1);
    await adjustCount(deps, ownerGroupId, 1);
  }

  await logActivity(deps.dynamodb, {
    actorCognitoId: gate.user.userId,
    actorName: gate.dbUser?.display_name,
    action: 'edit',
    entityType: 'venue',
    entityId: id,
    entityName: venue.Item.name,
    detail: `owner group set to ${group.Item.name}`
  });

  return respond(deps, event, 200, {
    venueId: id,
    ownerGroupId,
    ownerGroupName: group.Item.name,
    tenure: tenure || 'owned'
  });
}

/* ---------------------------------------------------------------- helpers */

async function dynamodb_scanSlug(deps, slug) {
  const r = await deps.dynamodb.scan({
    TableName: GROUPS_TABLE,
    FilterExpression: 'slug = :s',
    ExpressionAttributeValues: { ':s': slug }
  }).promise();
  return (r.Items || [])[0] || null;
}

/**
 * Keep the stored counter roughly current for anything that still reads the raw
 * record. Both API reads DERIVE the count from the index, so this is a
 * convenience only and a failure here is never a fault.
 */
async function adjustCount(deps, groupId, delta) {
  if (!groupId) return;
  try {
    await deps.dynamodb.update({
      TableName: GROUPS_TABLE,
      Key: { id: groupId },
      UpdateExpression: 'SET venueCount = if_not_exists(venueCount, :z) + :d',
      ExpressionAttributeValues: { ':z': 0, ':d': delta }
    }).promise();
  } catch (e) {
    console.warn('VENUE_GROUP: venueCount adjust failed (non-blocking)', groupId, e.message);
  }
}

/** Sweep the denormalised name across the estate after a rename. */
async function renameEstate(deps, groupId, name) {
  try {
    const estate = await deps.dynamodb.query({
      TableName: VENUES_TABLE,
      IndexName: 'ownerGroupId-index',
      KeyConditionExpression: 'ownerGroupId = :g',
      ExpressionAttributeValues: { ':g': groupId },
      ProjectionExpression: 'id'
    }).promise();
    for (const v of estate.Items || []) {
      await deps.dynamodb.update({
        TableName: VENUES_TABLE,
        Key: { id: v.id },
        UpdateExpression: 'SET ownerGroupName = :n',
        ExpressionAttributeValues: { ':n': name }
      }).promise();
    }
    console.log('VENUE_GROUP: renamed estate', { groupId, venues: (estate.Items || []).length });
  } catch (e) {
    console.error('VENUE_GROUP: estate rename FAILED, names now disagree', groupId, e.message);
  }
}

module.exports = {
  handleListGroups,
  handleGetGroup,
  handleCreateGroup,
  handleUpdateGroup,
  handleSetVenueGroup,
  slugify,
  GROUP_TYPES,
  TENURES,
  GROUPS_TABLE
};
