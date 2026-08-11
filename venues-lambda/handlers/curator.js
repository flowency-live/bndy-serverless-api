/**
 * Curator routes for venues (backlog feature 4).
 *
 *   PUT  /api/curator/venues/{id}          curator|staff: whitelisted edit
 *   POST /api/curator/venues/{id}/hide     curator|staff: soft delete
 *   POST /api/curator/venues/{id}/restore  staff only: bring it back
 *
 * Edits delegate to handleUpdateVenue so place validation, geohash and
 * postcode rules apply unchanged. The whitelist keeps curators away from
 * identity-bearing fields (name, googlePlaceId, location).
 */

const { requireRole, logActivity, pickFields, hideEntity, restoreEntity } = require('../lib/curator-core');
const { handleUpdateVenue } = require('./venues-routes');

const VENUES_TABLE = 'bndy-venues';

// Jason ruling 2026-08-11: a venue's address/postcode/city come from its
// VERIFIED Google Place ID and are NEVER hand-edited, by anyone, anywhere.
// Curators touch presentation only: socials, website, ticketing, description.
// No name, no googlePlaceId, no coordinates, no address fields.
const CURATOR_VENUE_FIELDS = [
  'website',
  'facebookUrl', 'instagramUrl', 'socialMediaUrls',
  'standardTicketed', 'standardTicketUrl', 'standardTicketInformation',
  'description'
];

const respond = (deps, event, statusCode, body) => ({
  statusCode,
  headers: deps.getCorsHeaders(event),
  body: JSON.stringify(body)
});

async function getVenueName(deps, id) {
  try {
    const r = await deps.dynamodb.get({ TableName: VENUES_TABLE, Key: { id } }).promise();
    return r.Item?.name || null;
  } catch {
    return null;
  }
}

async function handleCuratorUpdateVenue(deps, event) {
  const gate = await requireRole(deps, event, ['curator', 'staff']);
  if (gate.error) return respond(deps, event, gate.statusCode, { error: gate.error });

  const id = event.pathParameters?.id;
  if (!id) return respond(deps, event, 400, { error: 'Venue ID is required' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(deps, event, 400, { error: 'Invalid JSON body' });
  }

  const fields = pickFields(body, CURATOR_VENUE_FIELDS);
  if (Object.keys(fields).length === 0) {
    return respond(deps, event, 400, { error: `No editable field in body. Allowed: ${CURATOR_VENUE_FIELDS.join(', ')}` });
  }
  const result = await handleUpdateVenue(deps, id, fields, event);

  if (result.statusCode === 200) {
    await logActivity(deps.dynamodb, {
      actorCognitoId: gate.user.userId,
      actorName: gate.dbUser.display_name,
      action: 'edit',
      entityType: 'venue',
      entityId: id,
      entityName: await getVenueName(deps, id),
      detail: Object.keys(fields).join(',')
    });
  }
  return result;
}

async function handleCuratorHideVenue(deps, event) {
  const gate = await requireRole(deps, event, ['curator', 'staff']);
  if (gate.error) return respond(deps, event, gate.statusCode, { error: gate.error });

  const id = event.pathParameters?.id;
  if (!id) return respond(deps, event, 400, { error: 'Venue ID is required' });

  let reason = null;
  try {
    reason = JSON.parse(event.body || '{}').reason || null;
  } catch { /* body optional */ }

  const name = await getVenueName(deps, id);
  try {
    await hideEntity(deps.dynamodb, { tableName: VENUES_TABLE, id, actor: gate.user.userId, reason });
  } catch (e) {
    if (e.code === 'ConditionalCheckFailedException') {
      return respond(deps, event, 404, { error: 'Venue not found' });
    }
    throw e;
  }

  await logActivity(deps.dynamodb, {
    actorCognitoId: gate.user.userId,
    actorName: gate.dbUser.display_name,
    action: 'hide',
    entityType: 'venue',
    entityId: id,
    entityName: name,
    detail: reason
  });

  return respond(deps, event, 200, { success: true, id, hidden: true });
}

async function handleCuratorRestoreVenue(deps, event) {
  const gate = await requireRole(deps, event, ['staff']);
  if (gate.error) return respond(deps, event, gate.statusCode, { error: gate.error });

  const id = event.pathParameters?.id;
  if (!id) return respond(deps, event, 400, { error: 'Venue ID is required' });

  const name = await getVenueName(deps, id);
  try {
    await restoreEntity(deps.dynamodb, { tableName: VENUES_TABLE, id });
  } catch (e) {
    if (e.code === 'ConditionalCheckFailedException') {
      return respond(deps, event, 404, { error: 'Venue not found' });
    }
    throw e;
  }

  await logActivity(deps.dynamodb, {
    actorCognitoId: gate.user.userId,
    actorName: gate.dbUser.display_name,
    action: 'restore',
    entityType: 'venue',
    entityId: id,
    entityName: name
  });

  return respond(deps, event, 200, { success: true, id, hidden: false });
}

module.exports = { handleCuratorUpdateVenue, handleCuratorHideVenue, handleCuratorRestoreVenue };
