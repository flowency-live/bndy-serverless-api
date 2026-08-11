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
const { handleUpdateEventMcp } = require('./mcp');

const EVENTS_TABLE = 'bndy-events';

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
  const gate = await requireRole(deps, event, ['curator', 'staff']);
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
  const gate = await requireRole(deps, event, ['staff']);
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
  const gate = await requireRole(deps, event, ['curator', 'staff']);
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
  const gate = await requireRole(deps, event, ['curator', 'staff']);
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

module.exports = { handleCuratorUpdateEvent, handleCuratorHideEvent, handleCuratorRestoreEvent, handleCuratorCancelEvent, handleCuratorUncancelEvent };
