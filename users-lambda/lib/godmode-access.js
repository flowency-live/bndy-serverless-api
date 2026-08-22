'use strict';

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const REGION = 'eu-west-2';
const USERS_TABLE = 'bndy-users';
const ACTIVITY_TABLE = 'bndy-activity-log';
const CLOUDFLARE_SECRET_ID = 'bndy/cloudflare-analytics';
const ANALYTICS_HOST = 'bndy.live';
const ENTITY_TABLES = Object.freeze({ artist: 'bndy-artists', venue: 'bndy-venues', event: 'bndy-events' });

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: REGION });
const ssm = new AWS.SSM({ region: REGION });
let jwtSecret = null;
let cloudflareCredentials = null;

function pathOf(event) { return event.requestContext?.http?.path || event.rawPath || event.path || ''; }
function response(statusCode, body) { return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }

function readSessionToken(event) {
  const eventCookie = Array.isArray(event.cookies) ? event.cookies.find((x) => x.startsWith('bndy_session=')) : null;
  if (eventCookie) return eventCookie.split('=')[1];
  const header = event.headers?.Cookie || event.headers?.cookie || '';
  const found = header.split(';').map((x) => x.trim()).find((x) => x.startsWith('bndy_session='));
  return found ? found.split('=')[1] : null;
}

async function getJwtSecret() {
  if (jwtSecret) return jwtSecret;
  try {
    const result = await ssm.getParameter({ Name: '/bndy/auth/jwt-secret', WithDecryption: true }).promise();
    jwtSecret = result.Parameter.Value;
  } catch (error) {
    if (!process.env.JWT_SECRET) throw error;
    jwtSecret = process.env.JWT_SECRET;
  }
  return jwtSecret;
}

async function requireAuth(event) {
  const token = readSessionToken(event);
  if (!token) return { error: 'Not authenticated', statusCode: 401 };
  try { return { session: jwt.verify(token, await getJwtSecret()) }; }
  catch { return { error: 'Invalid session', statusCode: 401 }; }
}

async function requirePlatformAdmin(event) {
  const auth = await requireAuth(event);
  if (auth.error) return auth;
  const result = await dynamodb.get({ TableName: USERS_TABLE, Key: { cognito_id: auth.session.userId } }).promise();
  if (!result.Item) return { error: 'User not found', statusCode: 404 };
  if (!result.Item.platformAdmin) return { error: 'Platform admin access required', statusCode: 403 };
  return { session: auth.session, dbUser: result.Item };
}

function normalisePostcodeToken(value) {
  return typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, '') : '';
}

function toApiCuratorAccess(raw) {
  if (!raw || typeof raw !== 'object') return { scope: 'global', postcodePrefixes: [], ownRecordsOnly: false };
  return {
    scope: raw.scope === 'postcode' ? 'postcode' : 'global',
    postcodePrefixes: Array.isArray(raw.postcode_prefixes)
      ? [...new Set(raw.postcode_prefixes.map(normalisePostcodeToken).filter(Boolean))]
      : [],
    ownRecordsOnly: raw.own_records_only === true,
  };
}

function validateCuratorAccess(input) {
  if (!input || typeof input !== 'object') return { error: 'curatorAccess is required' };
  if (input.scope !== 'global' && input.scope !== 'postcode') return { error: 'scope must be global or postcode' };
  const prefixes = [...new Set((Array.isArray(input.postcodePrefixes) ? input.postcodePrefixes : []).map(normalisePostcodeToken).filter(Boolean))];
  const invalid = prefixes.filter((x) => !/^[A-Z]{1,2}(?:\d[A-Z0-9]?)?$/.test(x));
  if (invalid.length) return { error: `Invalid postcode area/district: ${invalid.join(', ')}` };
  if (input.scope === 'postcode' && prefixes.length === 0) return { error: 'At least one postcode area/district is required' };
  return {
    value: {
      scope: input.scope,
      postcode_prefixes: input.scope === 'postcode' ? prefixes : [],
      own_records_only: input.ownRecordsOnly === true,
    },
  };
}

async function findUserByPublicId(userId) {
  let ExclusiveStartKey;
  do {
    const result = await dynamodb.scan({
      TableName: USERS_TABLE,
      FilterExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ExclusiveStartKey,
    }).promise();
    if (result.Items?.[0]) return result.Items[0];
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return null;
}

async function logAccessChange(admin, target, access) {
  try {
    const at = new Date().toISOString();
    await dynamodb.put({
      TableName: ACTIVITY_TABLE,
      Item: {
        user_id: admin.cognito_id,
        sk: `${at}#${crypto.randomBytes(4).toString('hex')}`,
        at,
        actor_name: admin.display_name || null,
        action: 'set-curator-access',
        entity_type: 'user',
        entity_id: target.user_id,
        entity_name: target.display_name || target.username || target.email || null,
        detail: `${access.scope}; ${access.ownRecordsOnly ? 'own records only' : 'any records'}${access.postcodePrefixes.length ? `; ${access.postcodePrefixes.join(', ')}` : ''}`,
        gsi_pk: 'ALL',
      },
    }).promise();
  } catch (error) {
    console.error('[CURATOR ACCESS] activity log failed:', error.message);
  }
}

async function handleSetCuratorAccess(event) {
  const admin = await requirePlatformAdmin(event);
  if (admin.error) return response(admin.statusCode, { error: admin.error });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return response(400, { error: 'Invalid JSON body' }); }

  const checked = validateCuratorAccess(body.curatorAccess);
  if (checked.error) return response(400, { error: checked.error });

  const userId = event.pathParameters?.userId || pathOf(event).split('/').pop();
  const target = await findUserByPublicId(userId);
  if (!target) return response(404, { error: 'User not found' });
  if ((target.role || 'user') !== 'curator') return response(409, { error: 'Curator access can only be configured for a curator' });

  await dynamodb.update({
    TableName: USERS_TABLE,
    Key: { cognito_id: target.cognito_id },
    UpdateExpression: 'SET curator_access = :access, updated_at = :now',
    ExpressionAttributeValues: { ':access': checked.value, ':now': new Date().toISOString() },
  }).promise();

  const access = toApiCuratorAccess(checked.value);
  await logAccessChange(admin.dbUser, target, access);
  return response(200, { userId: target.user_id, curatorAccess: access });
}

async function patchUserList(result) {
  if (result?.statusCode !== 200) return result;
  try {
    const body = JSON.parse(result.body || '{}');
    if (!Array.isArray(body.users)) return result;
    const users = await Promise.all(body.users.map(async (user) => {
      try {
        const raw = await dynamodb.get({ TableName: USERS_TABLE, Key: { cognito_id: user.cognitoId }, ProjectionExpression: 'curator_access' }).promise();
        return { ...user, curatorAccess: toApiCuratorAccess(raw.Item?.curator_access) };
      } catch {
        return { ...user, curatorAccess: toApiCuratorAccess(null) };
      }
    }));
    return { ...result, body: JSON.stringify({ ...body, users }) };
  } catch {
    return result;
  }
}

async function patchProfile(event, result) {
  if (result?.statusCode !== 200) return result;
  const auth = await requireAuth(event);
  if (auth.error) return result;
  try {
    const raw = await dynamodb.get({ TableName: USERS_TABLE, Key: { cognito_id: auth.session.userId }, ProjectionExpression: 'curator_access' }).promise();
    const body = JSON.parse(result.body || '{}');
    if (body.user) body.user.curatorAccess = toApiCuratorAccess(raw.Item?.curator_access);
    return { ...result, body: JSON.stringify(body) };
  } catch {
    return result;
  }
}

function postcodeParts(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  let outward;
  if (trimmed.includes(' ')) outward = trimmed.split(/\s+/)[0];
  else {
    const compact = normalisePostcodeToken(trimmed);
    const full = compact.match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/);
    outward = full ? full[1] : compact;
  }
  const area = (outward.match(/^[A-Z]{1,2}/) || [])[0];
  return outward && area ? { outward, area } : null;
}

function postcodeAllowed(access, postcode) {
  if (access.scope !== 'postcode') return true;
  const parts = postcodeParts(postcode);
  if (!parts) return false;
  return access.postcodePrefixes.some((token) => (/^[A-Z]{1,2}$/.test(token) ? token === parts.area : token === parts.outward));
}

async function handleRecordCuratorCreation(event) {
  const auth = await requireAuth(event);
  if (auth.error) return response(auth.statusCode, { error: auth.error });
  const userResult = await dynamodb.get({ TableName: USERS_TABLE, Key: { cognito_id: auth.session.userId } }).promise();
  const user = userResult.Item;
  if (!user) return response(404, { error: 'User not found' });
  if ((user.role || 'user') !== 'curator' && !user.platformAdmin) return response(403, { error: 'Curator access required' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return response(400, { error: 'Invalid JSON body' }); }

  const created = body.curatorCreated;
  if (!created || !ENTITY_TABLES[created.entityType] || typeof created.entityId !== 'string') {
    return response(400, { error: 'Invalid curatorCreated payload' });
  }

  const table = ENTITY_TABLES[created.entityType];
  const itemResult = await dynamodb.get({ TableName: table, Key: { id: created.entityId } }).promise();
  const item = itemResult.Item;
  if (!item) return response(404, { error: 'Created record not found' });

  const access = toApiCuratorAccess(user.curator_access);
  if (!user.platformAdmin && access.scope === 'postcode' && created.entityType !== 'artist') {
    let postcode = item.postcode || item.postalCode || item.postal_code || null;
    if (created.entityType === 'event') {
      const venueId = item.venueId || item.venue_id;
      const venue = venueId ? await dynamodb.get({ TableName: 'bndy-venues', Key: { id: venueId } }).promise() : {};
      postcode = venue.Item?.postcode || venue.Item?.postalCode || venue.Item?.postal_code || null;
    }
    if (!postcodeAllowed(access, postcode)) return response(403, { error: 'Created record is outside this curator’s postcode access' });
  }

  try {
    await dynamodb.update({
      TableName: table,
      Key: { id: created.entityId },
      ConditionExpression: 'attribute_not_exists(createdBy) OR createdBy = :by',
      UpdateExpression: 'SET createdBy = if_not_exists(createdBy, :by), createdByName = if_not_exists(createdByName, :name)',
      ExpressionAttributeValues: { ':by': auth.session.userId, ':name': user.display_name || null },
    }).promise();
  } catch (error) {
    if (error.code === 'ConditionalCheckFailedException') return response(409, { error: 'Record already belongs to another creator' });
    throw error;
  }

  return response(200, { recorded: true, entityType: created.entityType, entityId: created.entityId });
}

async function getCloudflareCredentials() {
  if (cloudflareCredentials) return cloudflareCredentials;
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
    cloudflareCredentials = { account_id: process.env.CLOUDFLARE_ACCOUNT_ID, api_token: process.env.CLOUDFLARE_API_TOKEN };
    return cloudflareCredentials;
  }
  if (!AWS.SecretsManager) throw new Error('AWS Secrets Manager client unavailable');
  const manager = new AWS.SecretsManager({ region: REGION });
  const secret = await manager.getSecretValue({ SecretId: CLOUDFLARE_SECRET_ID }).promise();
  const parsed = JSON.parse(secret.SecretString || '{}');
  if (!parsed.account_id || !parsed.api_token) throw new Error('Cloudflare analytics secret is incomplete');
  cloudflareCredentials = parsed;
  return cloudflareCredentials;
}

const ANALYTICS_QUERY = `
query BndyWebAnalytics($accountTag: string!, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    total: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 1) { count sum { visits } }
    series: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 100, orderBy: [date_ASC]) { count sum { visits } dimensions { date } }
    topPaths: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 15, orderBy: [count_DESC]) { count sum { visits } dimensions { requestPath } }
    topReferers: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 15, orderBy: [count_DESC]) { count sum { visits } dimensions { refererHost } }
    countries: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 20, orderBy: [count_DESC]) { count dimensions { countryName } }
    devices: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 10, orderBy: [count_DESC]) { count dimensions { deviceType } }
    browsers: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 10, orderBy: [count_DESC]) { count dimensions { userAgentBrowser } }
    operatingSystems: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 10, orderBy: [count_DESC]) { count dimensions { userAgentOS } }
  } }
}`;

function metricRows(rows, key, fallback) {
  return (rows || []).map((row) => ({
    label: row.dimensions?.[key] || fallback,
    pageViews: Number(row.count || 0),
    visits: Number(row.sum?.visits || 0),
  }));
}

async function handleAnalytics(event) {
  const admin = await requirePlatformAdmin(event);
  if (admin.error) return response(admin.statusCode, { error: admin.error });

  const requested = Number(event.queryStringParameters?.days || 7);
  const days = [1, 7, 30].includes(requested) ? requested : 7;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);

  try {
    const credentials = await getCloudflareCredentials();
    const cfResponse = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.api_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query: ANALYTICS_QUERY,
        variables: {
          accountTag: credentials.account_id,
          filter: { datetime_geq: from.toISOString(), datetime_leq: to.toISOString(), requestHost: ANALYTICS_HOST },
        },
      }),
    });

    if (!cfResponse.ok) throw new Error(`Cloudflare returned HTTP ${cfResponse.status}`);
    const payload = await cfResponse.json();
    if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join('; '));
    const account = payload.data?.viewer?.accounts?.[0];
    if (!account) throw new Error('Cloudflare account analytics unavailable');
    const total = account.total?.[0] || {};

    return response(200, {
      host: ANALYTICS_HOST,
      range: { days, from: from.toISOString(), to: to.toISOString() },
      pageViews: Number(total.count || 0),
      visits: Number(total.sum?.visits || 0),
      series: (account.series || []).map((row) => ({ date: row.dimensions?.date, pageViews: Number(row.count || 0), visits: Number(row.sum?.visits || 0) })),
      topPages: metricRows(account.topPaths, 'requestPath', '/'),
      referrers: metricRows(account.topReferers, 'refererHost', 'Direct'),
      countries: metricRows(account.countries, 'countryName', 'Unknown'),
      devices: metricRows(account.devices, 'deviceType', 'Unknown'),
      browsers: metricRows(account.browsers, 'userAgentBrowser', 'Unknown'),
      operatingSystems: metricRows(account.operatingSystems, 'userAgentOS', 'Unknown'),
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[ANALYTICS] Cloudflare query failed:', error.message);
    return response(502, { error: 'Cloudflare analytics is temporarily unavailable', detail: error.message });
  }
}

module.exports = {
  handleAnalytics,
  handleSetCuratorAccess,
  handleRecordCuratorCreation,
  patchUserList,
  patchProfile,
  toApiCuratorAccess,
  validateCuratorAccess,
  postcodeParts,
  postcodeAllowed,
};
