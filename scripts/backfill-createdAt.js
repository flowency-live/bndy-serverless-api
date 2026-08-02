/**
 * Backfill script: Rename created_at → createdAt
 *
 * Per VSCODE-AGENT-CREATEDAT.md:
 * - For records with created_at but no createdAt: copy created_at → createdAt
 * - For records with neither: set createdAt from updatedAt + createdAtInferred: true
 * - Leave created_at in place (don't delete - something may still read it)
 *
 * Usage:
 *   DRY_RUN=true node scripts/backfill-createdAt.js    # Preview changes
 *   node scripts/backfill-createdAt.js                 # Apply changes
 */

const AWS = require('aws-sdk');

// Configure AWS
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const DRY_RUN = process.env.DRY_RUN === 'true';

const TABLES = [
  { name: 'bndy-artists', entityType: 'artist' },
  { name: 'bndy-venues', entityType: 'venue' }
];

async function scanAll(tableName) {
  const items = [];
  let lastEvaluatedKey = undefined;

  do {
    const params = {
      TableName: tableName,
      ExclusiveStartKey: lastEvaluatedKey
    };

    const result = await dynamodb.scan(params).promise();
    items.push(...result.Items);
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items;
}

async function backfillTable(tableName, entityType) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing ${tableName}...`);
  console.log(`${'='.repeat(60)}`);

  const items = await scanAll(tableName);
  console.log(`Found ${items.length} ${entityType}s`);

  let stats = {
    total: items.length,
    alreadyHasCreatedAt: 0,
    copiedFromCreatedAt: 0,
    inferredFromUpdatedAt: 0,
    noTimestampAvailable: 0,
    errors: 0
  };

  for (const item of items) {
    try {
      // Skip if already has createdAt
      if (item.createdAt) {
        stats.alreadyHasCreatedAt++;
        continue;
      }

      let updateExpression = [];
      let expressionAttributeValues = {};
      let expressionAttributeNames = {};

      // Case 1: has created_at but no createdAt → copy
      if (item.created_at && !item.createdAt) {
        updateExpression.push('#createdAt = :createdAt');
        expressionAttributeNames['#createdAt'] = 'createdAt';
        expressionAttributeValues[':createdAt'] = item.created_at;
        stats.copiedFromCreatedAt++;

        if (!DRY_RUN) {
          console.log(`[COPY] ${entityType} ${item.id}: created_at (${item.created_at}) → createdAt`);
        }
      }
      // Case 2: has neither but has updatedAt → infer
      else if (!item.created_at && !item.createdAt && item.updated_at) {
        updateExpression.push('#createdAt = :createdAt');
        updateExpression.push('#inferred = :inferred');
        expressionAttributeNames['#createdAt'] = 'createdAt';
        expressionAttributeNames['#inferred'] = 'createdAtInferred';
        expressionAttributeValues[':createdAt'] = item.updated_at;
        expressionAttributeValues[':inferred'] = true;
        stats.inferredFromUpdatedAt++;

        if (!DRY_RUN) {
          console.log(`[INFER] ${entityType} ${item.id}: updatedAt (${item.updated_at}) → createdAt + createdAtInferred`);
        }
      }
      // Case 3: no timestamps available at all
      else if (!item.created_at && !item.createdAt && !item.updated_at) {
        stats.noTimestampAvailable++;
        console.log(`[SKIP] ${entityType} ${item.id}: no timestamps available`);
        continue;
      }

      // Apply the update if we have changes
      if (updateExpression.length > 0 && !DRY_RUN) {
        await dynamodb.update({
          TableName: tableName,
          Key: { id: item.id },
          UpdateExpression: 'SET ' + updateExpression.join(', '),
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues
        }).promise();
      }
    } catch (error) {
      stats.errors++;
      console.error(`[ERROR] ${entityType} ${item.id}: ${error.message}`);
    }
  }

  return stats;
}

async function main() {
  console.log(`\n${'#'.repeat(60)}`);
  console.log(`# BACKFILL: created_at → createdAt`);
  console.log(`# Mode: ${DRY_RUN ? 'DRY RUN (no changes)' : 'LIVE (applying changes)'}`);
  console.log(`${'#'.repeat(60)}`);

  const allStats = {};

  for (const table of TABLES) {
    const stats = await backfillTable(table.name, table.entityType);
    allStats[table.name] = stats;
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SUMMARY ${DRY_RUN ? '(DRY RUN)' : '(APPLIED)'}`);
  console.log(`${'='.repeat(60)}`);

  for (const [tableName, stats] of Object.entries(allStats)) {
    console.log(`\n${tableName}:`);
    console.log(`  Total records:          ${stats.total}`);
    console.log(`  Already had createdAt:  ${stats.alreadyHasCreatedAt}`);
    console.log(`  Copied from created_at: ${stats.copiedFromCreatedAt}`);
    console.log(`  Inferred from updatedAt:${stats.inferredFromUpdatedAt}`);
    console.log(`  No timestamp available: ${stats.noTimestampAvailable}`);
    console.log(`  Errors:                 ${stats.errors}`);
  }

  if (DRY_RUN) {
    console.log(`\n⚠ DRY RUN - no changes made. Run without DRY_RUN=true to apply.`);
  } else {
    console.log(`\n✓ Backfill complete.`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
