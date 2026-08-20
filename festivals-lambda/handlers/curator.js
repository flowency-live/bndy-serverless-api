/**
 * Curator routes for festivals (festival curator builder, 2026-08-20).
 * Plan: bndy-app/FESTIVAL-CURATOR-PLAN.md
 *
 *   POST  /api/curator/festivals             curator|staff: create DRAFT festival
 *   GET   /api/curator/festivals/{id}        curator|staff: full record by id OR slug,
 *                                            drafts included (public reads filter them)
 *   PATCH /api/curator/festivals/{id}        curator|staff: whitelisted edit incl. publish
 *
 * Creates FORCE isPublic=false - a curator festival is born a draft and goes
 * live only through an explicit publish PATCH, which keeps the existing
 * "at least one venue" server rule. Edits delegate to the CRUD handlers with a
 * FILTERED body (same delegation pattern as events-lambda curator.js -> mcp.js),
 * so validation, slug immutability and lineup ops stay in one place. The
 * whitelist deliberately excludes lineup ops, stages, externalIds and source -
 * those stay import/agent tools in v1.
 */

const { requireRole, logActivity, pickFields } = require('../lib/curator-core');
const { handleCreateFestival, handleUpdateFestival } = require('./crud');

const FESTIVALS_TABLE = process.env.FESTIVALS_TABLE || 'bndy-events';

const CURATOR_FESTIVAL_FIELDS = [
  'name', 'description', 'startDate', 'endDate', 'town', 'location',
  'primaryVenueId', 'venueIds',
  'ticketed', 'price', 'ticketUrl', 'websiteUrl', 'lineupUrl', 'posterImageUrl',
  'isPublic'
];

const respond = (deps, event, statusCode, body) => ({
  statusCode,
  headers: deps.getCorsHeaders(event),
  body: JSON.stringify(body)
});

function stripKeys(item) {
  if (!item) return item;
  const { PK, SK, ...rest } = item;
  return rest;
}

async function findByIdOrSlug(dynamodb, idOrSlug) {
  const byId = await dynamodb.get({ TableName: FESTIVALS_TABLE, Key: { id: idOrSlug } }).promise();
  if (byId.Item && byId.Item.entityType === 'festival') return byId.Item;
  const bySlug = await dynamodb.query({
    TableName: FESTIVALS_TABLE,
    IndexName: 'bySlug',
    KeyConditionExpression: 'slug = :slug',
    ExpressionAttributeValues: { ':slug': idOrSlug }
  }).promise();
  return (bySlug.Items || []).find((i) => i.entityType === 'festival') || null;
}

async function handleCuratorCreateFestival(deps, event) {
  const gate = await requireRole(deps, event, ['curator', 'staff']);
  if (gate.error) return respond(deps, event, gate.statusCode, { error: gate.error });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(deps, event, 400, { error: 'Invalid JSON body' });
  }

  const fields = pickFields(body, CURATOR_FESTIVAL_FIELDS);
  // A curator festival is ALWAYS born a draft, whatever the client sent.
  fields.isPublic = false;
  fields.source = 'curator_app';
  fields.createdBy = gate.user.userId;
  fields.createdByName = gate.dbUser.display_name || null;

  const delegateEvent = { ...event, body: JSON.stringify(fields) };
  const result = await handleCreateFestival(deps, delegateEvent);

  if (result.statusCode === 201) {
    let created = {};
    try { created = JSON.parse(result.body); } catch { /* log only */ }
    await logActivity(deps.dynamodb, {
      actorCognitoId: gate.user.userId,
      actorName: gate.dbUser.display_name,
      action: 'create',
      entityType: 'festival',
      entityId: created.festivalId || null,
      entityName: fields.name || null,
      detail: 'draft'
    });
  }
  return result;
}

async function handleCuratorGetFestival(deps, event) {
  const gate = await requireRole(deps, event, ['curator', 'staff']);
  if (gate.error) return respond(deps, event, gate.statusCode, { error: gate.error });

  const idOrSlug = event.pathParameters?.id;
  if (!idOrSlug) return respond(deps, event, 400, { error: 'Festival id or slug is required' });

  const item = await findByIdOrSlug(deps.dynamodb, idOrSlug);
  if (!item) return respond(deps, event, 404, { error: 'Festival not found' });

  return respond(deps, event, 200, { festival: stripKeys(item) });
}

async function handleCuratorUpdateFestival(deps, event) {
  const gate = await requireRole(deps, event, ['curator', 'staff']);
  if (gate.error) return respond(deps, event, gate.statusCode, { error: gate.error });

  const id = event.pathParameters?.id;
  if (!id) return respond(deps, event, 400, { error: 'Festival ID is required' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(deps, event, 400, { error: 'Invalid JSON body' });
  }

  const fields = pickFields(body, CURATOR_FESTIVAL_FIELDS);
  if (Object.keys(fields).length === 0) {
    return respond(deps, event, 400, { error: `No editable field in body. Allowed: ${CURATOR_FESTIVAL_FIELDS.join(', ')}` });
  }

  const delegateEvent = { ...event, body: JSON.stringify(fields) };
  const result = await handleUpdateFestival(deps, delegateEvent);

  if (result.statusCode === 200) {
    let name = null;
    try { name = JSON.parse(result.body).festival?.name || null; } catch { /* log only */ }
    await logActivity(deps.dynamodb, {
      actorCognitoId: gate.user.userId,
      actorName: gate.dbUser.display_name,
      action: fields.isPublic === true ? 'publish' : fields.isPublic === false ? 'unpublish' : 'edit',
      entityType: 'festival',
      entityId: id,
      entityName: name,
      detail: Object.keys(fields).join(',')
    });
  }
  return result;
}

module.exports = { handleCuratorCreateFestival, handleCuratorGetFestival, handleCuratorUpdateFestival, CURATOR_FESTIVAL_FIELDS };
