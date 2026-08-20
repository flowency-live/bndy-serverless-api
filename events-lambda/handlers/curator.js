/**
 * Curator routes for events (backlog feature 4).
 *
 *   PUT  /api/curator/events/{id}          curator|staff: whitelisted edit
 *   POST /api/curator/events/{id}/hide     curator|staff: soft delete
 *   POST /api/curator/events/{id}/restore  staff only: bring it back
 *
 * Edits delegate to handleUpdateEventMcp with a FILTERED body, so field
 * mapping and clearable-field semantics stay in one place. The whitelist
 * excludes identity and linkage fields: artistId, venueId, isPublic,
 * externalIds, festival fields.
 *
 * Hide flips isPublic=false + hidden metadata. Every public read already
 * filters on isPublic, so hidden events leave all public surfaces at once.
 */

const { requireRole, logActivity, pickFields, hideEntity, restoreEntity } = require('../lib/curator-core');
const { requireMcpAuth } = require('../lib/auth');
const { handleUpdateEventMcp } = require('./mcp');

const EVENTS_TABLE = 'bndy-events';

/**
 * WP-05A (2026-08-20): the event lifecycle routes (cancel, uncancel, hide,
 * restore) accept the MCP service token as staff, so bndy-enrichment can
 * project cancellations and withdrawals without a cookie session.
 *
 * Rule: a presented Bearer token MUST be the valid MCP_SERVICE_TOKEN. A bad
 * bearer is 401. It never falls through to the cookie path. No bearer means
 * the cookie role gate runs unchanged. Same pattern as venues groups.js.
 */
const MCP_GATE = Object.freeze({
  user: Object.freeze({ userId: 'mcp-service', platformAdmin: true, isService: true }),
  dbUser: Object.freeze({ display_name: 'MCP' }),
  role: 'staff'
});

async function requireRoleOrMcp(deps, event, roles) {
  const bearer = event.headers?.Authorization || event.headers?.authorization || '';
  if (bearer.startsWith('Bearer ')) {
    const mcp = requireMcpAuth(deps, event);
    if (mcp.statusCode) return { error: JSON.parse(mcp.body).error, statusCode: mcp.statusCode };
    return MCP_GATE;
  }
  return requireRole(deps, event, roles);
}

const CURATOR_EVENT_FIELDS = [
  'title', 'date', 'startTime', 'endTime', 'description',
  'ticketed', 'ticketUrl', 'ticketinformation', 'price',
  'imageUrl', 'eventUrl', 'isOpenMic'
];

const respond = (deps, event, statusCode, body) => ({
  statusCode,
  headers: deps.getCorsHeaders(event),
  body: JSON.stringify(body)
});

async function getEventTitle(deps, id) {
  try {
    const r = await deps.dynamodb.get({ TableName: EVENTS_TABLE, Key: { id } }).promise();
    if (!r.Item) return null;
    return r.Item.title || r.Item.name || null;
  } catch {
    return null;
  }
}

async function handleCuratorUpdateEvent(deps, event) {
  const gate = await requireRole(deps, event, ['curator', 'staff']);
  if (gate.error) return respond(deps, event, gate.statusCode, { error: gate.error });

  const id = event.pathParameters?.id;
  if (!id) return respond(deps, event, 400, { error: 'Event ID is required' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(deps, event, 400, { error: 'Invalid JSON body' });
  }

  const fields = pickFields(body, CURATOR_EVENT_FIELDS);
  if (Object.keys(fields).length === 0) {
    return respond(deps, event, 400, { error: `No editable field in body. Allowed: ${CURATOR_EVENT_FIELDS.join(', ')}` });
  }

  // Delegate with the filtered body only — never the raw one.
  const delegateEvent = { ...event, body: JSON.stringify(fields) };
  const result = await handleUpdateEventMcp(deps, delegateEvent);

  if (result.statusCode === 200) {
    await logActivity(deps.dynamodb, {
      actorCognitoId: gate.user.userId,
      actorName: gate.dbUser.display_name,
      action: 'edit',
      entityType: 'event',
      entityId: id,
      entityName: await getEventTitle(deps, id),
      detail: Object.keys(fields).join(',')
    });
  }
  return result;
}

async function handleCuratorHideEvent(deps, event) {
  const gate = await requireRoleOrMcp(deps, event, ['curator', 'staff']);
  if (gate.error) return respond(deps, event, gate.statusCode, { error: gate.error });

  const id = event.pathParameters?.id;
  if (!id) return respond(deps, event, 400, { error: 'Event ID is required' });

  let reason = null;
  try {
    reason = JSON.parse(event.body || '{}').reason || null;
  } catch { /* body optional */ }

  const title = await getEventTitle(deps, id);
  try {
    await hideEntity(deps.dynamodb, {
      tableName: EVENTS_TABLE, id, actor: gate.user.userId, reason,
      extraSet: { isPublic: false }
    });
  } catch (e) {
    if (e.code === 'ConditionalCheckFailedException') {
      return respond(deps, event, 404, { error: 'Event not found' });
    }
    throw e;
  }

  await logActivity(deps.dynamodb, {
    actorCognitoId: gate.user.userId,
    actorName: gate.dbUser.display_name,
    action: 'hide',
    entityType: 'event',
    entityId: id,
    entityName: title,
    detail: reason
  });

  return respond(deps, event, 200, { success: true, id, hidden: true });
}

async function handleCuratorRestoreEvent(deps, event) {
  const gate = await requireRoleOrMcp(deps, event, ['staff']);
  if (gate.error) return respond(deps, event, gate.statusCode, { error: gate.error });

  const id = event.pathParameters?.id;
  if (!id) return respond(deps, event, 400, { error: 'Event ID is required' });

  const title = await getEventTitle(deps, id);
  try {
    await restoreEntity(deps.dynamodb, {
      tableName: EVENTS_TABLE, id,
      extraSet: { isPublic: true }
    });
  } catch (e) {
    if (e.code === 'ConditionalCheckFailedException') {
      return respond(deps, event, 404, { error: 'Event not found' });
    }
    throw e;
  }

  await logActivity(deps.dynamodb, {
    actorCognitoId: gate.user.userId,
    actorName: gate.dbUser.display_name,
    action: 'restore',
    entityType: 'event',
    entityId: id,
    entityName: title
  });

  return respond(deps, event, 200, { success: true, id, hidden: false });
}

/* ---------- cancelled gigs (backlog feature 7) ----------
 * Cancel is PUBLIC information — the event stays on lists and profiles as a
 * ghosted row with a stamp. It is not a hide. Curators cancel and uncancel.
 */

async function handleCuratorCancelEvent(deps, event) {
  const gate = await requireRoleOrMcp(deps, event, ['curator', 'staff']);
  if (gate.error) return respond(deps, event, gate.statusCode, { error: gate.error });

  const id = event.pathParameters?.id;
  if (!id) return respond(deps, event, 400, { error: 'Event ID is required' });

  let reason = null;
  try {
    reason = JSON.parse(event.body || '{}').reason || null;
  } catch { /* body optional */ }

  const title = await getEventTitle(deps, id);
  try {
    await deps.dynamodb.update({
      TableName: EVENTS_TABLE,
      Key: { id },
      ConditionExpression: 'attribute_exists(id)',
      UpdateExpression: 'SET cancelled = :true, cancelled_by = :by, cancelled_at = :at, cancelled_reason = :reason',
      ExpressionAttributeValues: {
        ':true': true,
        ':by': gate.user.userId,
        ':at': new Date().toISOString(),
        ':reason': reason
      }
    }).promise();
  } catch (e) {
    if (e.code === 'ConditionalCheckFailedException') {
      return respond(deps, event, 404, { error: 'Event not found' });
    }
    throw e;
  }

  await logActivity(deps.dynamodb, {
    actorCognitoId: gate.user.userId,
    actorName: gate.dbUser.display_name,
    action: 'cancel',
    entityType: 'event',
    entityId: id,
    entityName: title,
    detail: reason
  });

  return respond(deps, event, 200, { success: true, id, cancelled: true });
}

async function handleCuratorUncancelEvent(deps, event) {
  const gate = await requireRoleOrMcp(deps, event, ['curator', 'staff']);
  if (gate.error) return respond(deps, event, gate.statusCode, { error: gate.error });

  const id = event.pathParameters?.id;
  if (!id) return respond(deps, event, 400, { error: 'Event ID is required' });

  const title = await getEventTitle(deps, id);
  try {
    await deps.dynamodb.update({
      TableName: EVENTS_TABLE,
      Key: { id },
      ConditionExpression: 'attribute_exists(id)',
      UpdateExpression: 'SET cancelled = :false REMOVE cancelled_by, cancelled_at, cancelled_reason',
      ExpressionAttributeValues: { ':false': false }
    }).promise();
  } catch (e) {
    if (e.code === 'ConditionalCheckFailedException') {
      return respond(deps, event, 404, { error: 'Event not found' });
    }
    throw e;
  }

  await logActivity(deps.dynamodb, {
    actorCognitoId: gate.user.userId,
    actorName: gate.dbUser.display_name,
    action: 'uncancel',
    entityType: 'event',
    entityId: id,
    entityName: title
  });

  return respond(deps, event, 200, { success: true, id, cancelled: false });
}

/* ---------- festival tagging (festival curator builder, 2026-08-20) ----------
 * POST /api/curator/events/festival-tag
 * { festivalId, festivalName, add: [eventIds], remove: [eventIds] }
 *
 * add:    SET festivalId + festivalName. An event already tagged to a DIFFERENT
 *         festival is SKIPPED and reported - one festival per event, and a
 *         curator never silently steals another festival's gig.
 * remove: REMOVE festivalId + festivalName only when the event is tagged to
 *         THIS festival.
 * Cap 100 ids per call. Response { tagged, untagged, skipped }.
 */

const MAX_TAG_IDS = 100;

async function handleCuratorFestivalTag(deps, event) {
  const gate = await requireRole(deps, event, ['curator', 'staff']);
  if (gate.error) return respond(deps, event, gate.statusCode, { error: gate.error });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(deps, event, 400, { error: 'Invalid JSON body' });
  }

  const { festivalId, festivalName } = body;
  const add = Array.isArray(body.add) ? body.add : [];
  const remove = Array.isArray(body.remove) ? body.remove : [];

  if (!festivalId || typeof festivalId !== 'string') {
    return respond(deps, event, 400, { error: 'festivalId is required' });
  }
  if (add.length === 0 && remove.length === 0) {
    return respond(deps, event, 400, { error: 'add or remove must contain at least one event id' });
  }
  if (add.length + remove.length > MAX_TAG_IDS) {
    return respond(deps, event, 400, { error: `Maximum ${MAX_TAG_IDS} event ids per call` });
  }

  const tagged = [];
  const untagged = [];
  const skipped = [];

  for (const id of add) {
    try {
      await deps.dynamodb.update({
        TableName: EVENTS_TABLE,
        Key: { id },
        // Free to tag only when untagged or already ours (idempotent re-tag).
        ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(festivalId) OR festivalId = :fid)',
        UpdateExpression: 'SET festivalId = :fid, festivalName = :fname, updatedAt = :now',
        ExpressionAttributeValues: {
          ':fid': festivalId,
          ':fname': festivalName || null,
          ':now': new Date().toISOString()
        }
      }).promise();
      tagged.push(id);
    } catch (e) {
      if (e.code === 'ConditionalCheckFailedException') {
        skipped.push({ id, reason: 'not found or already in another festival' });
      } else {
        skipped.push({ id, reason: e.message });
      }
    }
  }

  for (const id of remove) {
    try {
      await deps.dynamodb.update({
        TableName: EVENTS_TABLE,
        Key: { id },
        // Only detach OUR tag - never strip another festival's linkage.
        ConditionExpression: 'attribute_exists(id) AND festivalId = :fid',
        UpdateExpression: 'REMOVE festivalId, festivalName SET updatedAt = :now',
        ExpressionAttributeValues: { ':fid': festivalId, ':now': new Date().toISOString() }
      }).promise();
      untagged.push(id);
    } catch (e) {
      if (e.code === 'ConditionalCheckFailedException') {
        skipped.push({ id, reason: 'not found or not tagged to this festival' });
      } else {
        skipped.push({ id, reason: e.message });
      }
    }
  }

  await logActivity(deps.dynamodb, {
    actorCognitoId: gate.user.userId,
    actorName: gate.dbUser.display_name,
    action: 'festival-tag',
    entityType: 'festival',
    entityId: festivalId,
    entityName: festivalName || null,
    detail: `tagged ${tagged.length}, untagged ${untagged.length}, skipped ${skipped.length}`
  });

  return respond(deps, event, 200, { tagged, untagged, skipped });
}

module.exports = { handleCuratorUpdateEvent, handleCuratorHideEvent, handleCuratorRestoreEvent, handleCuratorCancelEvent, handleCuratorUncancelEvent, handleCuratorFestivalTag };
