const AWS = require('aws-sdk');
const crypto = require('crypto');

const REGION = 'eu-west-2';
const SOURCE_ID = 'frontstage-user-created-artist';
const SUBJECT_INDEX_PREFIX = 'SUBJECT';
const OBSERVATION_INDEX_PREFIX = 'OBS';

const documentClient = new AWS.DynamoDB.DocumentClient({ region: REGION });
const rawDynamo = new AWS.DynamoDB({ region: REGION });

let cachedStateTableName;

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== null && value !== undefined;
}

function stableClaimId(observationId, predicate, value) {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify([observationId, predicate, value]))
    .digest('hex')
    .slice(0, 24);
  return `frontstage-claim-${digest}`;
}

function buildUserCreatedArtistClaims(artist, observedAt = new Date().toISOString()) {
  const observationId = `frontstage-create-${artist.id}`;
  const definitions = [
    ['hasName', artist.name],
    ['hasFacebookUrl', artist.facebookUrl],
    ['hasWebsiteUrl', artist.websiteUrl],
    ['hasInstagramUrl', artist.instagramUrl],
    ['hasLocation', artist.location],
    ['hasArtistType', artist.artist_type],
    ['hasActType', artist.actType],
    ['hasBio', artist.bio],
    ...(Array.isArray(artist.genres)
      ? artist.genres.map((genre) => ['hasGenre', genre])
      : []),
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
      subject: { type: 'artist', key: artist.id },
      predicate,
      value,
      confidence: 0.99,
      evidence: {
        ...(predicate === 'hasFacebookUrl' ? { sourceUrl: value } : {}),
        text: 'Submitted by a user when creating this artist in Bndy.',
      },
      assertedAt: observedAt,
      observedAt,
      status: 'active',
      GSI1PK: `${OBSERVATION_INDEX_PREFIX}#${observationId}`,
      GSI1SK: `${observedAt}#${id}`,
      GSI2PK: `${SUBJECT_INDEX_PREFIX}#artist#${artist.id}`,
      GSI2SK: `${observedAt}#${id}`,
    };
  });
}

async function getStateTableName() {
  if (process.env.BACKLINE_STATE_TABLE) return process.env.BACKLINE_STATE_TABLE;
  if (cachedStateTableName) return cachedStateTableName;

  let start;
  do {
    const result = await rawDynamo.listTables({
      ExclusiveStartTableName: start,
      Limit: 100,
    }).promise();
    const match = (result.TableNames || [])
      .find((name) => /^BndyEnrichmentStack-StateTable/i.test(name));
    if (match) {
      cachedStateTableName = match;
      return match;
    }
    start = result.LastEvaluatedTableName;
  } while (start);

  throw new Error('BndyEnrichmentStack StateTable not found');
}

async function ensureSource(tableName) {
  const source = {
    pk: `SOURCE#${SOURCE_ID}`,
    sk: 'CONFIG',
    entityType: 'GigSource',
    id: SOURCE_ID,
    name: 'Bndy user-created artists',
    type: 'MANUAL',
    timezone: 'Europe/London',
    cadence: 'manual',
    localTime: '05:00',
    mode: 'append-only',
    snapshotSemantics: 'one_shot',
    authorityClass: 'curated',
    thresholds: {},
    runtimeClass: 'standard',
    enabled: false,
    shadow: true,
    writerAuthority: 'aws',
    health: 'healthy',
  };

  try {
    await documentClient.put({
      TableName: tableName,
      Item: source,
      ConditionExpression: 'attribute_not_exists(pk)',
    }).promise();
  } catch (error) {
    if (error.code !== 'ConditionalCheckFailedException') throw error;
  }
}

async function publishUserCreatedArtistClaims(artist) {
  if (!artist || !artist.id || !artist.name) {
    throw new Error('A persisted artist id and name are required');
  }

  const tableName = await getStateTableName();
  const observedAt = new Date().toISOString();
  const observationId = `frontstage-create-${artist.id}`;
  const claims = buildUserCreatedArtistClaims(artist, observedAt);

  await ensureSource(tableName);

  const observation = {
    pk: `OBS#${observationId}`,
    sk: 'META',
    entityType: 'SourceObservation',
    id: observationId,
    sourceId: SOURCE_ID,
    observedAt,
    ...(hasValue(artist.facebookUrl) ? { sourceUrl: artist.facebookUrl } : {}),
    enumerationMethod: 'user-form',
    complete: true,
    paginationComplete: true,
    captureStable: true,
    itemCount: claims.length,
    GSI1PK: `SOURCE#${SOURCE_ID}`,
    GSI1SK: `OBS#${observedAt}#${observationId}`,
  };

  await documentClient.transactWrite({
    TransactItems: [
      { Put: { TableName: tableName, Item: observation } },
      ...claims.map((claim) => ({ Put: { TableName: tableName, Item: claim } })),
    ],
  }).promise();

  return { observationId, claimCount: claims.length };
}

module.exports = {
  SOURCE_ID,
  buildUserCreatedArtistClaims,
  publishUserCreatedArtistClaims,
};
