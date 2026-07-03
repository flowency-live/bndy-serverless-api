/**
 * Fully paginated DynamoDB scan.
 *
 * A bare dynamodb.scan() returns at most 1MB of items; callers that ignore
 * LastEvaluatedKey silently truncate results. Always use this for full reads.
 */
async function scanAll(dynamodb, params) {
  const items = [];
  let lastEvaluatedKey;

  do {
    const pageParams = lastEvaluatedKey
      ? { ...params, ExclusiveStartKey: lastEvaluatedKey }
      : { ...params };
    const page = await dynamodb.scan(pageParams).promise();
    items.push(...(page.Items || []));
    lastEvaluatedKey = page.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items;
}

module.exports = { scanAll };
