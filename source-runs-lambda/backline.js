const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const rawDynamo = new AWS.DynamoDB({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });
const USERS_TABLE = 'bndy-users';
const SUBJECT_INDEX = 'SubjectClaimsIndex';
const OBSERVATION_INDEX = 'ObservationClaimsIndex';

// This is deliberately an allow-list rather than a table scan. Adding a Backline
// source family is therefore an explicit, reviewable change to the admin surface.
const SOURCE_FAMILIES = {
  lemonrock: {
    id: 'lemonrock',
    label: 'Lemonrock',
    description: 'National future-gig, Artist and Venue evidence',
    taskPartition: 'BOOTSTRAP#lemonrock',
    sourceIds: [
      'lemonrock-new-gigs',
      'lemonrock-cancellations',
      'lemonrock-artist-index',
      'lemonrock-venue-index',
      'lemonrock-artist-hydration',
      'lemonrock-venue-hydration',
      'lemonrock-gig-hydration',
      'lemonrock-future-reconcile',
      'lemonrock-full-reconcile',
    ],
  },
  onthecase: {
    id: 'onthecase',
    label: 'On The Case',
    description: 'Gig-led North East listings with Venue and band evidence',
    taskPartition: 'BOOTSTRAP#onthecase',
    sourceIds: [
      'onthecase-daily-import',
      'onthecase-gig-index',
      'onthecase-band-index',
      'onthecase-venue-index',
      'onthecase-band-hydration',
      'onthecase-venue-hydration',
      'onthecase-full-reconcile',
    ],
  },
  klma: {
    id: 'klma',
    label: 'KLMA',
    description: 'Daily Stoke and Staffordshire curated gig-list evidence',
    sourceIds: ['klma-stoke-gig-list'],
  },
  bndy: {
    id: 'bndy',
    label: 'Canonical BNDY baseline',
    description: 'One-shot Backline baseline of existing BNDY entities',
    historical: true,
    sourceIds: [
      'bndy-canonical-artists',
      'bndy-canonical-venues',
      'bndy-canonical-events',
      'bndy-canonical-festivals',
    ],
  },
  'gigs-news': {
    id: 'gigs-news',
    label: 'GigsNews',
    description: 'Weekly curated aggregation, awaiting production shadow scheduling',
    sourceIds: ['gigs-news-daily-import'],
  },
  sceniceye: {
    id: 'sceniceye',
    label: 'Scenic Eye',
    description: 'Weekly edition ingestion, currently manual shadow',
    sourceIds: ['sceniceye-weekly-listing', 'sceniceye-daily-import'],
  },
  insangel: {
    id: 'insangel',
    label: 'Insangel',
    description: 'North East source reconnaissance, not yet production-enabled',
    sourceIds: ['insangel-daily-import'],
  },
};

const KNOWN_SOURCE_IDS = new Set(Object.values(SOURCE_FAMILIES).flatMap((family) => family.sourceIds));

let jwtSecret;
let stateTableName;

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Backline-Explorer-Version': 'multi-source-v1',
  },
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

function resolveFamily(value) {
  return SOURCE_FAMILIES[value || 'lemonrock'] || null;
}

function familyFromEvent(event) {
  return resolveFamily(event.queryStringParameters?.family);
}

async function queryAllTasks(tableName, family) {
  if (!family.taskPartition) return [];
  const rows = [];
  let start;
  do {
    const result = await dynamodb.query({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': family.taskPartition, ':prefix': 'TASK#' },
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
    if (kind === 'artist' || kind === 'band') bucket = stats.artists;
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

function publicSource(config, state) {
  return {
    id: config.id,
    name: config.name,
    url: config.url,
    region: config.region,
    health: config.health,
    shadow: config.shadow,
    writerAuthority: config.writerAuthority,
    authorityClass: config.authorityClass,
    enabled: config.enabled,
    cadence: config.cadence,
    lastRunAt: state?.lastRunAt,
    lastSuccessfulRunAt: state?.lastSuccessfulRunAt,
    lastFailureAt: state?.lastFailureAt,
    consecutiveFailures: state?.consecutiveFailures || 0,
    lastObservationId: state?.lastObservationId,
  };
}

async function getSourceRecords(tableName, sourceIds) {
  if (!sourceIds.length) return { configs: new Map(), states: new Map() };
  const keys = sourceIds.flatMap((id) => [
    { pk: `SOURCE#${id}`, sk: 'CONFIG' },
    { pk: `SOURCE#${id}`, sk: 'STATE' },
  ]);
  const result = await dynamodb.batchGet({ RequestItems: { [tableName]: { Keys: keys } } }).promise();
  const configs = new Map();
  const states = new Map();
  for (const item of result.Responses?.[tableName] || []) {
    if (item.sk === 'CONFIG' && item.id) configs.set(item.id, item);
    if (item.sk === 'STATE' && item.sourceId) states.set(item.sourceId, item);
  }
  return { configs, states };
}

async function getSources(tableName, family) {
  const records = await getSourceRecords(tableName, family.sourceIds);
  return family.sourceIds
    .map((id) => records.configs.has(id) ? publicSource(records.configs.get(id), records.states.get(id)) : null)
    .filter(Boolean);
}

function latestIso(values) {
  return values.filter(Boolean).sort((a, b) => String(b).localeCompare(String(a)))[0] || null;
}

function familyStatus(family, configs, states) {
  const failures = family.sourceIds.reduce((total, id) => total + Number(states.get(id)?.consecutiveFailures || 0), 0);
  const enabled = family.sourceIds.filter((id) => configs.get(id)?.enabled === true).length;
  if (failures > 0) return 'degraded';
  if (enabled > 0) return 'healthy';
  if (family.historical) return 'historical';
  return 'inactive';
}

async function getFamilyCards(tableName) {
  const families = Object.values(SOURCE_FAMILIES);
  const sourceIds = [...new Set(families.flatMap((family) => family.sourceIds))];
  const { configs, states } = await getSourceRecords(tableName, sourceIds);
  return families.map((family) => {
    const sourceConfigs = family.sourceIds.map((id) => configs.get(id)).filter(Boolean);
    const sourceStates = family.sourceIds.map((id) => states.get(id)).filter(Boolean);
    return {
      id: family.id,
      label: family.label,
      description: family.description,
      status: familyStatus(family, configs, states),
      configuredSources: sourceConfigs.length,
      enabledSources: sourceConfigs.filter((source) => source.enabled === true).length,
      shadow: sourceConfigs.length > 0 && sourceConfigs.every((source) => source.shadow !== false),
      canonicalWritesEnabled: sourceConfigs.some((source) => source.shadow === false && source.writerAuthority === 'aws'),
      lastRunAt: latestIso(sourceStates.map((state) => state.lastRunAt)),
      lastSuccessfulRunAt: latestIso(sourceStates.map((state) => state.lastSuccessfulRunAt)),
      consecutiveFailures: sourceStates.reduce((total, state) => total + Number(state.consecutiveFailures || 0), 0),
    };
  });
}

function publicRunMetric(item) {
  return {
    runId: item.runId,
    sourceId: item.sourceId,
    reconciliationId: item.reconciliationId,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    status: item.status,
    reason: item.reason,
    complete: item.complete,
    shadow: item.shadow,
    writerAuthority: item.writerAuthority,
    rawItems: item.rawItems || 0,
    validEvents: item.validEvents || 0,
    entityProfiles: item.entityProfiles || 0,
    parked: item.parked || 0,
    claims: item.claims || 0,
    added: item.added || 0,
    updated: item.updated || 0,
    withdrawn: item.withdrawn || 0,
    unchanged: item.unchanged || 0,
    fanoutQueued: item.fanoutQueued || 0,
    warnings: item.warnings || 0,
    errors: item.errors || 0,
    durationMs: item.durationMs || 0,
    reportKey: item.reportKey,
  };
}

async function getRunMetrics(tableName, family, limit = 20) {
  const result = await dynamodb.query({
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: { ':pk': `SOURCE_METRICS#${family.id}`, ':prefix': 'RUN#' },
    ScanIndexForward: false,
    Limit: Math.min(Math.max(limit, 1), 50),
  }).promise();
  return (result.Items || []).map(publicRunMetric);
}

async function summary(tableName, event) {
  const family = familyFromEvent(event);
  if (!family) return { status: 400, body: { error: 'Unknown Backline source family' } };
  const [taskRows, sources, runMetrics, families] = await Promise.all([
    queryAllTasks(tableName, family),
    getSources(tableName, family),
    getRunMetrics(tableName, family),
    getFamilyCards(tableName),
  ]);
  const { stats, current } = taskStats(taskRows);
  const failures = current
    .filter((task) => task.status === 'failed')
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 20)
    .map(publicTask);
  return {
    status: 200,
    body: {
      sourceFamily: family.id,
      family: families.find((item) => item.id === family.id),
      families,
      stats,
      taskHistoryRows: taskRows.length,
      uniqueCurrentTasks: current.length,
      failures,
      sources,
      runMetrics,
      readOnly: true,
      canonicalWritesEnabled: false,
      computedAt: new Date().toISOString(),
    },
  };
}

function publicTask(task) {
  return {
    sourceId: task.sourceId,
    taskKey: task.taskKey,
    logicalTaskKey: task.logicalTaskKey,
    reconciliationId: task.reconciliationId || task.lastReconciliationId,
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
  const family = familyFromEvent(event);
  if (!family) return { status: 400, body: { error: 'Unknown Backline source family' } };
  if (!family.taskPartition) return { status: 200, body: { tasks: [], cursor: null } };
  const limit = Math.min(Math.max(Number(event.queryStringParameters?.limit || 100), 1), 250);
  const status = event.queryStringParameters?.status;
  const kind = event.queryStringParameters?.kind;
  const values = { ':pk': family.taskPartition, ':prefix': 'TASK#' };
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
  return { status: 200, body: { tasks: (result.Items || []).map(publicTask), cursor: encodeCursor(result.LastEvaluatedKey) } };
}

function publicClaim(item) {
  return {
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
  };
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
  const claims = (result.Items || []).map(publicClaim);
  const latestByPredicate = {};
  for (const claim of claims) if (!latestByPredicate[claim.predicate]) latestByPredicate[claim.predicate] = claim;
  const resolutions = claims.filter((claim) => claim.predicate === 'resolvesTo');
  const conflicts = claims.filter((claim) => claim.predicate === 'contradicts');
  return { status: 200, body: { type, key, claims, latestByPredicate, resolutions, conflicts } };
}

async function sourceDetail(tableName, event) {
  const sourceId = event.queryStringParameters?.sourceId;
  if (!sourceId || !KNOWN_SOURCE_IDS.has(sourceId)) return { status: 400, body: { error: 'valid Backline sourceId is required' } };
  const [config, state, observations] = await Promise.all([
    dynamodb.get({ TableName: tableName, Key: { pk: `SOURCE#${sourceId}`, sk: 'CONFIG' } }).promise(),
    dynamodb.get({ TableName: tableName, Key: { pk: `SOURCE#${sourceId}`, sk: 'STATE' } }).promise(),
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
      source: config.Item ? publicSource(config.Item, state.Item) : null,
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

async function observationDetail(tableName, event) {
  const observationId = event.queryStringParameters?.observationId;
  if (!observationId || !/^obs-[A-Za-z0-9-]+$/.test(observationId)) {
    return { status: 400, body: { error: 'valid observationId is required' } };
  }
  const [observation, claims] = await Promise.all([
    dynamodb.get({ TableName: tableName, Key: { pk: `OBS#${observationId}`, sk: 'META' } }).promise(),
    dynamodb.query({
      TableName: tableName,
      IndexName: OBSERVATION_INDEX,
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `OBS#${observationId}` },
      ScanIndexForward: true,
      Limit: 500,
    }).promise(),
  ]);
  return {
    status: 200,
    body: {
      observation: observation.Item || null,
      claims: (claims.Items || []).map(publicClaim),
      truncated: Boolean(claims.LastEvaluatedKey),
    },
  };
}

exports.handle = async (event, action) => {
  const auth = await requirePlatformAdmin(event);
  if (auth.error) return response(auth.status, { error: auth.error });
  try {
    const tableName = await getStateTableName();
    if (action === 'summary') {
      const result = await summary(tableName, event);
      return response(result.status, result.body);
    }
    if (action === 'tasks') {
      const result = await tasks(tableName, event);
      return response(result.status, result.body);
    }
    if (action === 'subject') {
      const result = await subject(tableName, event);
      return response(result.status, result.body);
    }
    if (action === 'source') {
      const result = await sourceDetail(tableName, event);
      return response(result.status, result.body);
    }
    if (action === 'observation') {
      const result = await observationDetail(tableName, event);
      return response(result.status, result.body);
    }
    return response(404, { error: 'Unknown Backline Explorer action' });
  } catch (error) {
    console.error('[BACKLINE] request failed', error);
    return response(500, { error: 'Backline Explorer query failed', detail: error.message });
  }
};

exports.__test = { SOURCE_FAMILIES, resolveFamily, taskStats, currentTasks, publicRunMetric };
