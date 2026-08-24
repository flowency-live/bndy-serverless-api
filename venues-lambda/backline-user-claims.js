const AWS = require('aws-sdk');
const crypto = require('crypto');

const REGION = 'eu-west-2';
const SOURCE_ID = 'join-user-created-venue';
let documentClient;
let rawDynamo;
let cachedStateTableName;

function getClients() {
  if (!documentClient) documentClient = new AWS.DynamoDB.DocumentClient({ region: REGION });
  if (!rawDynamo) rawDynamo = new AWS.DynamoDB({ region: REGION });
  return { documentClient, rawDynamo };
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== null && value !== undefined;
}

function stableClaimId(observationId, predicate, value) {
  return `join-venue-claim-${crypto.createHash('sha256').update(JSON.stringify([observationId, predicate, value])).digest('hex').slice(0, 24)}`;
}

function buildUserCreatedVenueClaims(venue, observedAt = new Date().toISOString()) {
  const observationId = `join-venue-create-${venue.id}`;
  const definitions = [
    ['hasName', venue.name],
    ['hasAddress', venue.address],
    ['hasCity', venue.city],
    ['hasPostcode', venue.postcode],
    ['hasGooglePlaceId', venue.google_place_id],
    ['hasLatitude', venue.latitude],
    ['hasLongitude', venue.longitude],
    ['hasWebsiteUrl', venue.website],
    ['hasPhone', venue.phone],
    ...(Array.isArray(venue.social_media_urls) ? venue.social_media_urls.map((url) => ['hasSocialUrl', url]) : []),
  ].filter(([, value]) => hasValue(value));

  return definitions.map(([predicate, value]) => {
    const id = stableClaimId(observationId, predicate, value);
    return {
      pk: `CLAIM#${id}`,
      sk: 'META',
      entityType: 'KnowledgeClaim',
      id,
      observationId,
      sourceId: SOURCE_ID,
      subject: { type: 'venue', key: venue.id },
      predicate,
      value,
      confidence: 0.99,
      evidence: { text: 'Submitted by an authenticated user when creating and owning this venue in Bndy.' },
      assertedAt: observedAt,
      observedAt,
      status: 'active',
      GSI1PK: `OBS#${observationId}`,
      GSI1SK: `${observedAt}#${id}`,
      GSI2PK: `SUBJECT#venue#${venue.id}`,
      GSI2SK: `${observedAt}#${id}`,
    };
  });
}

async function getStateTableName() {
  if (process.env.BACKLINE_STATE_TABLE) return process.env.BACKLINE_STATE_TABLE;
  if (cachedStateTableName) return cachedStateTableName;
  let start;
  do {
    const { rawDynamo: dynamo } = getClients();
    const result = await dynamo.listTables({ ExclusiveStartTableName: start, Limit: 100 }).promise();
    const match = (result.TableNames || []).find((name) => /^BndyEnrichmentStack-StateTable/i.test(name));
    if (match) { cachedStateTableName = match; return match; }
    start = result.LastEvaluatedTableName;
  } while (start);
  throw new Error('BndyEnrichmentStack StateTable not found');
}

async function ensureSource(tableName) {
  const { documentClient: client } = getClients();
  const source = {
    pk: `SOURCE#${SOURCE_ID}`, sk: 'CONFIG', entityType: 'GigSource', id: SOURCE_ID,
    name: 'Bndy user-created owned venues', type: 'MANUAL', timezone: 'Europe/London',
    cadence: 'manual', localTime: '05:00', mode: 'append-only', snapshotSemantics: 'one_shot',
    authorityClass: 'curated', thresholds: {}, runtimeClass: 'standard', enabled: false,
    shadow: true, writerAuthority: 'aws', health: 'healthy'
  };
  try { await client.put({ TableName: tableName, Item: source, ConditionExpression: 'attribute_not_exists(pk)' }).promise(); }
  catch (error) { if (error.code !== 'ConditionalCheckFailedException') throw error; }
}

async function publishUserCreatedVenueClaims(venue) {
  if (!venue || !venue.id || !venue.name) throw new Error('A persisted venue id and name are required');
  const tableName = await getStateTableName();
  const observedAt = new Date().toISOString();
  const observationId = `join-venue-create-${venue.id}`;
  const claims = buildUserCreatedVenueClaims(venue, observedAt);
  await ensureSource(tableName);
  const observation = {
    pk: `OBS#${observationId}`, sk: 'META', entityType: 'SourceObservation', id: observationId,
    sourceId: SOURCE_ID, observedAt, enumerationMethod: 'user-form', complete: true,
    paginationComplete: true, captureStable: true, itemCount: claims.length,
    GSI1PK: `SOURCE#${SOURCE_ID}`, GSI1SK: `OBS#${observedAt}#${observationId}`
  };
  const { documentClient: client } = getClients();
  await client.transactWrite({ TransactItems: [
    { Put: { TableName: tableName, Item: observation } },
    ...claims.map((claim) => ({ Put: { TableName: tableName, Item: claim } }))
  ] }).promise();
  return { observationId, claimCount: claims.length };
}

module.exports = { SOURCE_ID, buildUserCreatedVenueClaims, publishUserCreatedVenueClaims };
