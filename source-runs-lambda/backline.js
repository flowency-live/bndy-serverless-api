const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const rawDynamo = new AWS.DynamoDB({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });
const USERS_TABLE = 'bndy-users';
const SUBJECT_INDEX = 'SubjectClaimsIndex';
const OBSERVATION_INDEX = 'ObservationClaimsIndex';
const SOURCE_IDS = [
  'lemonrock-new-gigs',
  'lemonrock-cancellations',
  'lemonrock-artist-index',
  'lemonrock-venue-index',
  'lemonrock-artist-hydration',
  'lemonrock-venue-hydration',
  'lemonrock-gig-hydration',
  'lemonrock-future-reconcile',
  'lemonrock-full-reconcile',
];

let jwtSecret;
let stateTableName;

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

const parseCookies = (header = '') => header.split(';').reduce((out, pair) => {
  const index = pair.indexOf('=');
  if (index < 0) return out;
  out[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  return out;
}, {});

async function getJwtSecret() {
  if (jwtSecret) return jwtSecret;
  const result = await ssm.getParameter({ Name: '/bndy/auth/jwt-secret', WithDecryption: true }).promise();
  jwtSecret = result.Parameter.Value;
  return jwtSecret;
}

async function requirePlatformAdmin(event) {
  const arrayCookie = Array.isArray(event.cookies)
    ? event.cookies.find((value) => value.startsWith('bndy_session='))?.slice('bndy_session='.length)
    : undefined;
  const headerCookies = parseCookies(event.headers?.Cookie || event.headers?.cookie || '');
  const token = arrayCookie || headerCookies.bndy_session;
  if (!token) return { error: 'Not authenticated', status: 401 };
  try {
    const session = jwt.verify(token, await getJwtSecret());
    const user = await dynamodb.get({ TableName: USERS_TABLE, Key: { cognito_id: session.userId } }).promise();
    if (!user.Item?.platformAdmin) return { error: 'Admin access required', status: 403 };
    return { userId: session.userId };
  } catch (error) {
    console.error('[BACKLINE] auth error', error.message);
    return { error: 'Invalid session', status: 401 };
  }
}

async function getStateTableName() {
  if (process.env.BACKLINE_STATE_TABLE) return process.env.BACKLINE_STATE_TABLE;
  if (stateTableName) return stateTableName;
  let start;
  do {
    const result = await rawDynamo.listTables({ ExclusiveStartTableName: start, Limit: 100 }).promise();
    const match = (result.TableNames || []).find((name) => /^BndyEnrichmentStack-StateTable/i.test(name));
    if (match) {
      stateTableName = match;
      return match;
    }
    start = result.LastEvaluatedTableName;
  } while (start);
  throw new Error('BndyEnrichmentStack StateTable not found');
}

function encodeCursor(key) {
  return key ? Buffer.from(JSON.stringify(key), 'utf8').toString('base64url') : null;
}

function decodeCursor(value) {
  if (!value) return undefined;
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { return undefined; }
}

async function queryAllTasks(tableName) {
  const rows = [];
  let start;
  do {
    const result = await dynamodb.query({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': 'BOOTSTRAP#lemonrock', ':prefix': 'TASK#' },
      ExclusiveStartKey: start,
    }).promise();
    rows.push(...(result.Items || []));
    start = result.LastEvaluatedKey;
  } while (start);
  return rows;
}

function logicalIdentity(task) {
  const nativeId = task.task?.nativeId;
  return `${task.sourceId}|${typeof nativeId === 'string' ? nativeId : (task.sourceUrl || task.logicalTaskKey || task.taskKey)}`;
}

function currentTasks(rows) {
  const current = new Map();
  for (const row of rows) {
    const key = logicalIdentity(row);
    const previous = current.get(key);
    if (!previous || String(row.updatedAt || '').localeCompare(String(previous.updatedAt || '')) > 0) current.set(key, row);
  }
  return [...current.values()];
}

function taskStats(rows) {
  const current = currentTasks(rows);
  const stats = {
    artists: { discovered: 0, hydrated: 0, failed: 0 },
    venues: { discovered: 0, hydrated: 0, failed: 0 },
    gigs: { discovered: 0, hydrated: 0, failed: 0 },
    pages: { discovered: 0, completed: 0, failed: 0 },
    queue: { queued: 0, running: 0, completed: 0, failed: 0 },
  };
  for (const task of current) {
    if (stats.queue[task.status] !== undefined) stats.queue[task.status] += 1;
    const kind = String(task.taskKind || task.task?.kind || '');
    let bucket;
    if (kind === 'artist') bucket = stats.artists;
    else if (kind === 'venue') bucket = stats.venues;
    else if (kind === 'gig') bucket = stats.gigs;
    else bucket = stats.pages;
    bucket.discovered += 1;
    if (task.status === 'completed') {
      if ('hydrated' in bucket) bucket.hydrated += 1;
      else bucket.completed += 1;
    }
    if (task.status === 'failed') bucket.failed += 1;
  }
  return { stats, current };
}

async function getSources(tableName) {
  const keys = SOURCE_IDS.map((id) => ({ pk: `SOURCE#${id}`, sk: 'CONFIG' }));
  const result = await dynamodb.batchGet({ RequestItems: { [tableName]: { Keys: keys } } }).promise();
  return (result.Responses?.[tableName] || []).map((item) => ({
    id: item.id,
    name: item.name,
    url: item.url,
    health: item.health,
    shadow: item.shadow,
    writerAuthority: item.writerAuthority,
    authorityClass: item.authorityClass,
    enabled: item.enabled,
    cadence: item.cadence,
    lastSuccessfulScanAt: item.lastSuccessfulScanAt,
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function summary(tableName) {
  const tasks = await queryAllTasks(tableName);
  const { stats, current } = taskStats(tasks);
  const failures = current
    .filter((task) => task.status === 'failed')
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 20)
    .map(publicTask);
  return {
    sourceFamily: 'lemonrock',
    stats,
    taskHistoryRows: tasks.length,
    uniqueCurrentTasks: current.length,
    failures,
    sources: await getSources(tableName),
    readOnly: true,
    canonicalWritesEnabled: false,
    computedAt: new Date().toISOString(),
  };
}

function publicTask(task) {
  return {
    sourceId: task.sourceId,
    taskKey: task.taskKey,
    logicalTaskKey: task.logicalTaskKey,
    kind: task.taskKind || task.task?.kind,
    nativeId: task.task?.nativeId,
    name: task.task?.name,
    sourceUrl: task.sourceUrl,
    status: task.status,
    queuedAt: task.queuedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    failedAt: task.failedAt,
    updatedAt: task.updatedAt,
    lastError: task.lastError,
  };
}

async function tasks(tableName, event) {
  const limit = Math.min(Math.max(Number(event.queryStringParameters?.limit || 100), 1), 250);
  const status = event.queryStringParameters?.status;
  const kind = event.queryStringParameters?.kind;
  const values = { ':pk': 'BOOTSTRAP#lemonrock', ':prefix': 'TASK#' };
  const names = {};
  const filters = [];
  if (status) { values[':status'] = status; names['#status'] = 'status'; filters.push('#status = :status'); }
  if (kind) { values[':kind'] = kind; filters.push('taskKind = :kind'); }
  const result = await dynamodb.query({
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: values,
    ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
    ...(filters.length ? { FilterExpression: filters.join(' AND ') } : {}),
    ExclusiveStartKey: decodeCursor(event.queryStringParameters?.cursor),
    Limit: limit,
    ScanIndexForward: false,
  }).promise();
  return { tasks: (result.Items || []).map(publicTask), cursor: encodeCursor(result.LastEvaluatedKey) };
}

async function subject(tableName, event) {
  const type = event.queryStringParameters?.type;
  const key = event.queryStringParameters?.key;
  if (!type || !key) return { status: 400, body: { error: 'type and key are required' } };
  const result = await dynamodb.query({
    TableName: tableName,
    IndexName: SUBJECT_INDEX,
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': `SUBJECT#${type}#${key}` },
    ScanIndexForward: false,
    Limit: 500,
  }).promise();
  const claims = (result.Items || []).map((item) => ({
    id: item.id,
    observationId: item.observationId,
    sourceId: item.sourceId,
    subject: item.subject,
    predicate: item.predicate,
    value: item.value,
    confidence: item.confidence,
    evidence: item.evidence,
    observedAt: item.observedAt,
    status: item.status,
  }));
  const latestByPredicate = {};
  for (const claim of claims) if (!latestByPredicate[claim.predicate]) latestByPredicate[claim.predicate] = claim;
  const resolutions = claims.filter((claim) => claim.predicate === 'resolvesTo');
  const conflicts = claims.filter((claim) => claim.predicate === 'contradicts');
  return { status: 200, body: { type, key, claims, latestByPredicate, resolutions, conflicts } };
}

async function sourceDetail(tableName, event) {
  const sourceId = event.queryStringParameters?.sourceId;
  if (!sourceId || !sourceId.startsWith('lemonrock-')) return { status: 400, body: { error: 'valid lemonrock sourceId is required' } };
  const [config, observations] = await Promise.all([
    dynamodb.get({ TableName: tableName, Key: { pk: `SOURCE#${sourceId}`, sk: 'CONFIG' } }).promise(),
    dynamodb.query({
      TableName: tableName,
      IndexName: OBSERVATION_INDEX,
      KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `SOURCE#${sourceId}`, ':prefix': 'OBS#' },
      ScanIndexForward: false,
      Limit: 50,
    }).promise(),
  ]);
  return {
    status: 200,
    body: {
      source: config.Item || null,
      observations: (observations.Items || []).map((item) => ({
        id: item.id,
        sourceId: item.sourceId,
        observedAt: item.observedAt,
        sourceUrl: item.sourceUrl,
        captureHash: item.captureHash,
        evidenceKey: item.evidenceKey,
        enumerationMethod: item.enumerationMethod,
        complete: item.complete,
        itemCount: item.itemCount,
        futureItemCount: item.futureItemCount,
        httpStatus: item.httpStatus,
        contentType: item.contentType,
        structuralFingerprint: item.structuralFingerprint,
      })),
    },
  };
}

exports.handle = async (event, action) => {
  const auth = await requirePlatformAdmin(event);
  if (auth.error) return response(auth.status, { error: auth.error });
  try {
    const tableName = await getStateTableName();
    if (action === 'summary') return response(200, await summary(tableName));
    if (action === 'tasks') return response(200, await tasks(tableName, event));
    if (action === 'subject') {
      const result = await subject(tableName, event);
      return response(result.status, result.body);
    }
    if (action === 'source') {
      const result = await sourceDetail(tableName, event);
      return response(result.status, result.body);
    }
    return response(404, { error: 'Unknown Backline Explorer action' });
  } catch (error) {
    console.error('[BACKLINE] request failed', error);
    return response(500, { error: 'Backline Explorer query failed', detail: error.message });
  }
};
