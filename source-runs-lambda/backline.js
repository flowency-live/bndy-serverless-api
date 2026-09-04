const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const rawDynamo = new AWS.DynamoDB({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });
const USERS_TABLE = 'bndy-users';
const SUBJECT_INDEX = 'SubjectClaimsIndex';
const OBSERVATION_INDEX = 'ObservationClaimsIndex';
const DEFAULT_CANONICAL_BASELINE = 'bndy-baseline-2026-08-24-v1';

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
  livebandphotos: {
    id: 'livebandphotos',
    label: 'Live Band Photos',
    description: 'South East gig, Venue and Artist intelligence, canonical-first and fixture-gated',
    sourceIds: [
      'livebandphotos-gig-listing',
      'livebandphotos-county-index',
      'livebandphotos-band-index',
      'livebandphotos-band-hydration',
      'livebandphotos-venue-hydration',
      'livebandphotos-full-reconcile',
    ],
  },
  fizgig: {
    id: 'fizgig',
    label: 'Fizgig',
    description: 'Lincolnshire and East Midlands gig intelligence, canonical-first and fixture-gated',
    sourceIds: [
      'fizgig-gig-index',
      'fizgig-artist-index',
      'fizgig-venue-index',
      'fizgig-detail-hydration',
      'fizgig-full-reconcile',
    ],
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

async function getProjectionControl(tableName) {
  const result = await dynamodb.get({
    TableName: tableName,
    Key: { pk: 'CONTROL#PROJECTION', sk: 'GLOBAL' },
    ConsistentRead: true,
  }).promise();
  const record = result.Item || null;
  const enabled = record?.canonicalWritesEnabled === true;
  return {
    enabled,
    state: enabled ? 'enabled' : record ? 'disabled-explicit' : 'disabled-default',
    updatedAt: record?.updatedAt || null,
  };
}

function corpusConvergenceState(baseline, latest) {
  if (latest?.status === 'running') return 'hydrating';
  if (latest?.status === 'failed') return 'attention';
  if (latest?.status === 'complete') return 'converged';
  if (baseline?.status === 'complete') return 'baseline-stale';
  return 'not-ready';
}

function publicBaseline(item) {
  if (!item) return null;
  return {
    snapshotId: item.snapshotId,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    status: item.status,
    shadow: item.shadow,
    canonicalWritesEnabled: item.canonicalWritesEnabled === true,
    totals: item.totals || null,
    claims: item.claims,
    observations: item.observations,
    errors: item.errors || [],
  };
}

function publicHydration(item) {
  if (!item) return null;
  return {
    runId: item.runId,
    baselineSnapshotId: item.baselineSnapshotId,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    updatedAt: item.updatedAt,
    status: item.status,
    mode: item.mode,
    canonicalWritesEnabled: item.canonicalWritesEnabled === true,
    scanned: item.scanned || 0,
    unchanged: item.unchanged || 0,
    inserted: item.inserted || 0,
    modified: item.modified || 0,
    removed: item.removed || 0,
    claims: item.claims || 0,
    checkpointsBackfilled: item.checkpointsBackfilled || 0,
    skippedWithoutId: item.skippedWithoutId || 0,
    errors: item.errors || [],
  };
}

async function canonicalHydration(tableName) {
  const [latestResult, projectionControl] = await Promise.all([
    dynamodb.get({
      TableName: tableName,
      Key: { pk: 'HYDRATION#CANONICAL', sk: 'LATEST' },
      ConsistentRead: true,
    }).promise(),
    getProjectionControl(tableName),
  ]);
  const latest = publicHydration(latestResult.Item);
  const baselineSnapshotId = latest?.baselineSnapshotId || DEFAULT_CANONICAL_BASELINE;
  const baselineResult = await dynamodb.get({
    TableName: tableName,
    Key: { pk: `BASELINE#${baselineSnapshotId}`, sk: 'META' },
    ConsistentRead: true,
  }).promise();
  const baseline = publicBaseline(baselineResult.Item);
  return {
    status: 200,
    body: {
      state: corpusConvergenceState(baseline, latest),
      baseline,
      latest,
      projectionControl,
      readOnly: true,
      computedAt: new Date().toISOString(),
    },
  };
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

function taskLedgerStatus(family) {
  const taskLedgerAvailable = Boolean(family.taskPartition);
  return {
    taskLedgerAvailable,
    taskStatsAvailable: false,
    taskStatsReason: taskLedgerAvailable
      ? 'Full-ledger aggregation is disabled on interactive requests. Use the paginated tasks endpoint.'
      : 'This source family has no task ledger.',
    stats: null,
    taskHistoryRows: null,
    uniqueCurrentTasks: null,
    failures: [],
  };
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
    reobservedUnchanged: item.reobservedUnchanged || 0,
    projectionSkipped: item.projectionSkipped || 0,
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
  const [sources, runMetrics, families, projectionControl] = await Promise.all([
    getSources(tableName, family),
    getRunMetrics(tableName, family),
    getFamilyCards(tableName),
    getProjectionControl(tableName),
  ]);
  return {
    status: 200,
    body: {
      sourceFamily: family.id,
      family: families.find((item) => item.id === family.id),
      families,
      ...taskLedgerStatus(family),
      sources,
      runMetrics,
      readOnly: true,
      canonicalWritesEnabled: projectionControl.enabled,
      projectionControl,
      computedAt: new Date().toISOString(),
    },
  };
}

const GRAPH_NODE_KINDS = new Set(['source', 'obs', 'claim', 'candidate', 'entity']);
const GRAPH_CANDIDATE_TYPES = new Set(['artist-candidate', 'venue-candidate', 'event-candidate']);
const GRAPH_ENTITY_TYPES = new Set(['artist', 'venue', 'event', 'festival']);

function parseGraphNodeRef(value) {
  const [kind, ...parts] = String(value || '').split(':');
  if (!GRAPH_NODE_KINDS.has(kind)) throw new Error(`Unknown node ref: ${value}`);
  if ((kind === 'source' || kind === 'obs' || kind === 'claim') && parts.join(':')) {
    return { kind, id: parts.join(':') };
  }
  if (kind === 'candidate') {
    const [subjectType, ...keyParts] = parts;
    const subjectKey = keyParts.join(':');
    if (GRAPH_CANDIDATE_TYPES.has(subjectType) && subjectKey) return { kind, subjectType, subjectKey };
  }
  if (kind === 'entity') {
    const [entityType, ...idParts] = parts;
    const entityId = idParts.join(':');
    if (GRAPH_ENTITY_TYPES.has(entityType) && entityId) return { kind, entityType, entityId };
  }
  throw new Error(`Invalid node ref: ${value}`);
}

function graphClaimLabel(claim) {
  const value = typeof claim.value === 'string' ? claim.value : JSON.stringify(claim.value);
  return `${claim.predicate} = ${String(value).slice(0, 60)}`;
}

function shortGraphKey(value) {
  const text = String(value);
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

function graphCollector(limit) {
  const nodes = new Map();
  const edges = new Map();
  let truncated = false;
  return {
    node(node) {
      if (nodes.has(node.ref)) {
        if (node.data) {
          const previous = nodes.get(node.ref);
          nodes.set(node.ref, { ...previous, ...node, data: { ...(previous.data || {}), ...node.data } });
        }
        return;
      }
      if (nodes.size >= limit) { truncated = true; return; }
      nodes.set(node.ref, node);
    },
    edge(edge) {
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) return;
      edges.set(`${edge.from}|${edge.kind}|${edge.to}`, edge);
    },
    result(center) { return { center, nodes: [...nodes.values()], edges: [...edges.values()], truncated }; },
  };
}

function addGraphClaim(collector, claim) {
  const ref = `claim:${claim.id}`;
  collector.node({ ref, kind: 'claim', label: graphClaimLabel(claim), data: publicClaim(claim) });
  return ref;
}

function addGraphCandidate(collector, subjectType, subjectKey) {
  const ref = `candidate:${subjectType}:${subjectKey}`;
  collector.node({ ref, kind: 'candidate', label: shortGraphKey(subjectKey), data: { subjectType, subjectKey } });
  return ref;
}

async function queryClaimsByObservation(tableName, observationId, limit) {
  const result = await dynamodb.query({
    TableName: tableName,
    IndexName: OBSERVATION_INDEX,
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': `OBS#${observationId}` },
    ScanIndexForward: true,
    Limit: limit,
  }).promise();
  return result.Items || [];
}

async function queryClaimsBySubject(tableName, subjectType, subjectKey, limit) {
  const result = await dynamodb.query({
    TableName: tableName,
    IndexName: SUBJECT_INDEX,
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: { ':pk': `SUBJECT#${subjectType}#${subjectKey}` },
    ScanIndexForward: true,
    Limit: limit,
  }).promise();
  return result.Items || [];
}

async function graphNeighborhood(tableName, event) {
  const nodeText = event.queryStringParameters?.node;
  if (!nodeText) return { status: 400, body: { error: 'node is required' } };
  let ref;
  try { ref = parseGraphNodeRef(nodeText); } catch (error) {
    return { status: 400, body: { error: error.message } };
  }
  const limit = Math.min(Math.max(Number(event.queryStringParameters?.limit || 60), 5), 120);
  const collector = graphCollector(limit);
  const center = nodeText;

  if (ref.kind === 'source') {
    if (!KNOWN_SOURCE_IDS.has(ref.id)) return { status: 400, body: { error: 'valid Backline source node is required' } };
    const [config, observations] = await Promise.all([
      dynamodb.get({ TableName: tableName, Key: { pk: `SOURCE#${ref.id}`, sk: 'CONFIG' } }).promise(),
      dynamodb.query({
        TableName: tableName,
        IndexName: OBSERVATION_INDEX,
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
        ExpressionAttributeValues: { ':pk': `SOURCE#${ref.id}`, ':prefix': 'OBS#' },
        ScanIndexForward: false,
        Limit: Math.min(limit, 20),
      }).promise(),
    ]);
    collector.node({ ref: center, kind: 'source', label: config.Item?.name || ref.id, data: config.Item || undefined });
    for (const observation of observations.Items || []) {
      const observationRef = `obs:${observation.id}`;
      collector.node({ ref: observationRef, kind: 'observation', label: observation.observedAt || observation.id, data: observation });
      collector.edge({ from: center, to: observationRef, kind: 'PRODUCED' });
    }
  }

  if (ref.kind === 'obs') {
    const [observation, claims] = await Promise.all([
      dynamodb.get({ TableName: tableName, Key: { pk: `OBS#${ref.id}`, sk: 'META' } }).promise(),
      queryClaimsByObservation(tableName, ref.id, limit),
    ]);
    collector.node({ ref: center, kind: 'observation', label: observation.Item?.observedAt || ref.id, data: observation.Item || undefined });
    if (observation.Item?.sourceId) {
      const sourceRef = `source:${observation.Item.sourceId}`;
      collector.node({ ref: sourceRef, kind: 'source', label: observation.Item.sourceId });
      collector.edge({ from: sourceRef, to: center, kind: 'PRODUCED' });
    }
    for (const claim of claims) {
      const claimRef = addGraphClaim(collector, claim);
      collector.edge({ from: center, to: claimRef, kind: 'ASSERTS' });
      if (claim.subject?.type && claim.subject?.key) {
        const candidateRef = addGraphCandidate(collector, claim.subject.type, claim.subject.key);
        collector.edge({ from: claimRef, to: candidateRef, kind: 'ABOUT' });
      }
    }
  }

  if (ref.kind === 'claim') {
    const claimResult = await dynamodb.get({ TableName: tableName, Key: { pk: `CLAIM#${ref.id}`, sk: 'META' } }).promise();
    const claim = claimResult.Item;
    if (!claim) collector.node({ ref: center, kind: 'claim', label: ref.id });
    else {
      addGraphClaim(collector, claim);
      const observationRef = `obs:${claim.observationId}`;
      collector.node({ ref: observationRef, kind: 'observation', label: claim.observedAt || claim.observationId });
      collector.edge({ from: observationRef, to: center, kind: 'ASSERTS' });
      const sourceRef = `source:${claim.sourceId}`;
      collector.node({ ref: sourceRef, kind: 'source', label: claim.sourceId });
      collector.edge({ from: sourceRef, to: observationRef, kind: 'PRODUCED' });
      if (claim.subject?.type && claim.subject?.key) {
        const candidateRef = addGraphCandidate(collector, claim.subject.type, claim.subject.key);
        collector.edge({ from: center, to: candidateRef, kind: 'ABOUT' });
      }
    }
  }

  if (ref.kind === 'candidate') {
    addGraphCandidate(collector, ref.subjectType, ref.subjectKey);
    const [claims, resolution] = await Promise.all([
      queryClaimsBySubject(tableName, ref.subjectType, ref.subjectKey, limit),
      dynamodb.get({
        TableName: tableName,
        Key: { pk: `RESOLUTION#${ref.subjectType.replace(/-candidate$/, '')}#${ref.subjectKey}`, sk: 'META' },
      }).promise(),
    ]);
    for (const claim of claims) {
      const claimRef = addGraphClaim(collector, claim);
      collector.edge({ from: claimRef, to: center, kind: 'ABOUT' });
      const observationRef = `obs:${claim.observationId}`;
      collector.node({ ref: observationRef, kind: 'observation', label: claim.observedAt || claim.observationId });
      collector.edge({ from: observationRef, to: claimRef, kind: 'ASSERTS' });
      const value = claim.value;
      const nativeId = value && typeof value === 'object' ? value.sourceNativeId : undefined;
      const linkedType = claim.predicate === 'occursAt' ? 'venue-candidate'
        : claim.predicate === 'hasPerformer' ? 'artist-candidate' : null;
      if (linkedType && typeof nativeId === 'string' && nativeId) {
        const linkedRef = addGraphCandidate(collector, linkedType, nativeId);
        collector.edge({ from: center, to: linkedRef, kind: 'REFERENCES' });
      }
    }
    const resolved = resolution.Item;
    if (resolved) collector.node({
      ref: center,
      kind: 'candidate',
      label: shortGraphKey(ref.subjectKey),
      data: resolved,
    });
    if (resolved?.status === 'resolved' && resolved.canonicalEntityId) {
      const entityType = resolved.candidateType;
      const entityRef = `entity:${entityType}:${resolved.canonicalEntityId}`;
      collector.node({ ref: entityRef, kind: 'entity', label: `${entityType} ${shortGraphKey(resolved.canonicalEntityId)}`, data: resolved });
      collector.edge({ from: center, to: entityRef, kind: 'RESOLVES_TO' });
    }
  }

  if (ref.kind === 'entity') {
    collector.node({ ref: center, kind: 'entity', label: `${ref.entityType} ${shortGraphKey(ref.entityId)}` });
    const supports = await dynamodb.query({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `ENTITY#${ref.entityType}#${ref.entityId}`, ':prefix': 'SUPPORT#' },
      ScanIndexForward: true,
      Limit: Math.min(limit, 30),
    }).promise();
    for (const support of supports.Items || []) {
      if (!support.claimId) continue;
      const claimResult = await dynamodb.get({ TableName: tableName, Key: { pk: `CLAIM#${support.claimId}`, sk: 'META' } }).promise();
      const claim = claimResult.Item;
      if (!claim) continue;
      const claimRef = addGraphClaim(collector, claim);
      collector.edge({ from: claimRef, to: center, kind: 'SUPPORTS' });
      if (claim.subject?.type && claim.subject?.key) {
        const candidateRef = addGraphCandidate(collector, claim.subject.type, claim.subject.key);
        collector.edge({ from: claimRef, to: candidateRef, kind: 'ABOUT' });
      }
    }
  }

  return { status: 200, body: collector.result(center) };
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

function publicTrustLoopRun(item) {
  return {
    id: item.id,
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    sourceIds: item.sourceIds || [],
    candidatesSeen: item.candidatesSeen || 0,
    candidatesClassified: item.candidatesClassified || 0,
    classifications: item.classifications || { resolved: 0, unresolved: 0, conflicted: 0 },
    entityTypes: item.entityTypes || { artist: 0, venue: 0, event: 0, festival: 0 },
    noSilentDrops: item.noSilentDrops === true,
    canonicalWrites: item.canonicalWrites || 0,
    enrichment: item.enrichment || {},
    acceptance: item.acceptance || {},
    providerQualification: item.providerQualification || null,
    status: item.status,
    reviewCases: item.reviewCases || [],
  };
}

async function trustLoop(tableName, event) {
  const limit = Math.min(Math.max(Number(event.queryStringParameters?.limit || 5), 1), 20);
  const [result, projectionControl] = await Promise.all([
    dynamodb.query({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': 'TRUST_LOOP', ':prefix': 'RUN#' },
      ScanIndexForward: false,
      Limit: limit,
    }).promise(),
    getProjectionControl(tableName),
  ]);
  return {
    status: 200,
    body: {
      runs: (result.Items || []).map(publicTrustLoopRun),
      readOnly: true,
      canonicalWritesEnabled: projectionControl.enabled,
      projectionControl,
    },
  };
}

// ---------------------------------------------------------------------------
// Operations: source freshness, projection runs and shadow would-write decisions.
// Read-only. Bounded. Never returns supporting Claim bodies.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_STALENESS_HOURS = 26;
const OPERATIONS_OBSERVATIONS_PER_SOURCE = 2;
const PUBLIC_CANDIDATE_FIELDS = [
  'sourceEventKey', 'artistName', 'artistExternalId', 'artistLocation',
  'venueName', 'venueExternalId', 'venueLocation', 'venueAddress',
  'date', 'startTime', 'endTime', 'title', 'eventUrl', 'ticketUrl',
  'admissionStatus', 'price', 'status', 'observedAt',
];

function boundedLimit(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

function assessSourceFreshness(config, state, now = new Date()) {
  const maxStalenessHours = typeof config.maxStalenessHours === 'number'
    ? config.maxStalenessHours
    : DEFAULT_MAX_STALENESS_HOURS;
  const base = {
    sourceId: config.id,
    name: config.name,
    enabled: config.enabled === true,
    cadence: config.cadence,
    sourceRole: config.sourceRole,
    shadow: config.shadow !== false,
    writerAuthority: config.writerAuthority,
    nextScanAt: config.nextScanAt || null,
    maxStalenessHours,
    lastSuccessfulRunAt: state?.lastSuccessfulRunAt || null,
    lastFailureAt: state?.lastFailureAt || null,
    consecutiveFailures: Number(state?.consecutiveFailures || 0),
    ageHours: null,
  };
  if (!base.enabled) return { ...base, status: 'disabled' };
  if (!state?.lastSuccessfulRunAt) return { ...base, status: 'missing' };
  const successAt = new Date(state.lastSuccessfulRunAt);
  if (!Number.isFinite(successAt.getTime())) return { ...base, status: 'invalid' };
  const ageHours = Number(Math.max(0, (now.getTime() - successAt.getTime()) / 3_600_000).toFixed(2));
  return { ...base, ageHours, status: ageHours > maxStalenessHours ? 'stale' : 'healthy' };
}

function publicCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const out = {};
  for (const field of PUBLIC_CANDIDATE_FIELDS) {
    if (candidate[field] !== undefined) out[field] = candidate[field];
  }
  out.supportingClaims = Array.isArray(candidate.supportingClaims) ? candidate.supportingClaims.length : 0;
  return out;
}

function publicProjectionItem(item) {
  const details = item.details && typeof item.details === 'object' ? item.details : {};
  const idempotencyKey = item.idempotencyKey
    || (typeof item.pk === 'string' ? item.pk.replace(/^PROJECTION_ITEM#/, '') : undefined);
  return {
    idempotencyKey,
    sourceId: item.sourceId,
    observationId: item.observationId,
    candidateKey: item.candidateKey,
    action: item.action,
    status: item.status,
    completedAt: item.completedAt,
    wouldWrite: typeof details.wouldWrite === 'string' ? details.wouldWrite : null,
    reason: typeof details.reason === 'string' ? details.reason : null,
    outcome: typeof details.outcome === 'string' ? details.outcome : null,
    candidate: publicCandidate(details.candidate),
    error: typeof item.error === 'string' ? item.error : undefined,
  };
}

function publicProjectionRun(item) {
  return {
    observationId: item.observationId,
    sourceId: item.sourceId,
    runId: item.runId,
    status: item.status,
    expectedItems: Number(item.expectedItems || 0),
    completedAt: item.completedAt,
    counts: item.counts && typeof item.counts === 'object' ? item.counts : {},
  };
}

function byCompletedAtDesc(a, b) {
  return String(b.completedAt || '').localeCompare(String(a.completedAt || ''));
}

async function recentObservationIds(tableName, sourceId, limit) {
  const result = await dynamodb.query({
    TableName: tableName,
    IndexName: OBSERVATION_INDEX,
    KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
    ExpressionAttributeValues: { ':pk': `SOURCE#${sourceId}`, ':prefix': 'OBS#' },
    ScanIndexForward: false,
    Limit: limit,
  }).promise();
  return (result.Items || []).map((item) => item.id).filter(Boolean);
}

async function projectionRunRows(tableName, observationId) {
  const result = await dynamodb.query({
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': `PROJECTION_RUN#${observationId}` },
    Limit: 200,
  }).promise();
  return result.Items || [];
}

async function batchGetProjectionItems(tableName, idempotencyKeys) {
  const items = [];
  for (let index = 0; index < idempotencyKeys.length; index += 100) {
    const keys = idempotencyKeys.slice(index, index + 100).map((key) => ({ pk: `PROJECTION_ITEM#${key}`, sk: 'META' }));
    if (!keys.length) break;
    const result = await dynamodb.batchGet({ RequestItems: { [tableName]: { Keys: keys } } }).promise();
    items.push(...(result.Responses?.[tableName] || []));
  }
  return items;
}

async function operations(tableName, event) {
  const family = familyFromEvent(event);
  if (!family) return { status: 400, body: { error: 'Unknown Backline source family' } };
  const limit = boundedLimit(event.queryStringParameters?.limit, 25, 50);
  const now = new Date();
  const [{ configs, states }, projectionControl] = await Promise.all([
    getSourceRecords(tableName, family.sourceIds),
    getProjectionControl(tableName),
  ]);
  const knownSourceIds = family.sourceIds.filter((id) => configs.has(id));
  const freshness = knownSourceIds.map((id) => assessSourceFreshness(configs.get(id), states.get(id) || null, now));
  const observationIds = (await Promise.all(
    knownSourceIds.map((id) => recentObservationIds(tableName, id, OPERATIONS_OBSERVATIONS_PER_SOURCE)),
  )).flat();
  const runRows = (await Promise.all(observationIds.map((id) => projectionRunRows(tableName, id)))).flat();
  const projectionRuns = runRows.filter((row) => row.sk === 'META').map(publicProjectionRun).sort(byCompletedAtDesc);
  const itemRows = runRows
    .filter((row) => typeof row.sk === 'string' && row.sk.startsWith('ITEM#'))
    .sort(byCompletedAtDesc);
  const selected = itemRows.slice(0, limit);
  const items = await batchGetProjectionItems(tableName, selected.map((row) => row.idempotencyKey).filter(Boolean));
  const wouldWrite = items.map(publicProjectionItem).sort(byCompletedAtDesc);
  return {
    status: 200,
    body: {
      sourceFamily: family.id,
      freshness,
      projectionRuns,
      wouldWrite,
      truncated: itemRows.length > selected.length,
      observationsSampled: observationIds.length,
      exceptions: {
        available: false,
        reason: 'Projection exceptions are stored without a source index. Exposing them needs a GSI in the enrichment stack.',
      },
      readOnly: true,
      canonicalWritesEnabled: projectionControl.enabled,
      projectionControl,
      computedAt: now.toISOString(),
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
    if (action === 'graph') {
      const result = await graphNeighborhood(tableName, event);
      return response(result.status, result.body);
    }
    if (action === 'hydration') {
      const result = await canonicalHydration(tableName);
      return response(result.status, result.body);
    }
    if (action === 'trust-loop') {
      const result = await trustLoop(tableName, event);
      return response(result.status, result.body);
    }
    if (action === 'operations') {
      const result = await operations(tableName, event);
      return response(result.status, result.body);
    }
    return response(404, { error: 'Unknown Backline Explorer action' });
  } catch (error) {
    console.error('[BACKLINE] request failed', error);
    return response(500, { error: 'Backline Explorer query failed', detail: error.message });
  }
};

exports.__test = {
  SOURCE_FAMILIES,
  resolveFamily,
  taskStats,
  currentTasks,
  taskLedgerStatus,
  publicRunMetric,
  publicTrustLoopRun,
  parseGraphNodeRef,
  graphClaimLabel,
  shortGraphKey,
  corpusConvergenceState,
  publicBaseline,
  publicHydration,
  assessSourceFreshness,
  publicProjectionItem,
  publicProjectionRun,
  boundedLimit,
};
