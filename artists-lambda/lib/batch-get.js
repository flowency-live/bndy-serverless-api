/**
 * BatchGetItem-based lookup: fetches items for a list of ids in chunks of 25
 * (the BatchGetItem limit), retrying UnprocessedKeys, and returns a map of
 * id -> item. Replaces Promise.all(ids.map(id => dynamodb.get(...))) fan-out.
 */
const BATCH_LIMIT = 25;
const MAX_RETRIES = 3;

async function fetchChunk(dynamodb, tableName, keys, keyName, resultMap) {
  let pendingKeys = keys;
  let attempt = 0;

  while (pendingKeys.length > 0 && attempt <= MAX_RETRIES) {
    if (attempt > 0) {
      await new Promise(resolve => setTimeout(resolve, 50 * attempt));
    }
    const result = await dynamodb.batchGet({
      RequestItems: { [tableName]: { Keys: pendingKeys } }
    }).promise();

    const items = (result.Responses && result.Responses[tableName]) || [];
    items.forEach(item => {
      resultMap[item[keyName]] = item;
    });

    const unprocessed = result.UnprocessedKeys &&
      result.UnprocessedKeys[tableName] &&
      result.UnprocessedKeys[tableName].Keys;
    pendingKeys = unprocessed || [];
    attempt += 1;
  }
}

async function batchGetByIds(dynamodb, tableName, ids, options) {
  const { keyName = 'id' } = options || {};
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  const resultMap = {};

  if (uniqueIds.length === 0) return resultMap;

  const chunks = [];
  for (let i = 0; i < uniqueIds.length; i += BATCH_LIMIT) {
    chunks.push(uniqueIds.slice(i, i + BATCH_LIMIT).map(id => ({ [keyName]: id })));
  }

  await Promise.all(chunks.map(keys => fetchChunk(dynamodb, tableName, keys, keyName, resultMap)));

  return resultMap;
}

module.exports = { batchGetByIds };
