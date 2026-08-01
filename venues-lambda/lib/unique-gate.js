/**
 * bndy hard uniqueness gate — DynamoDB-enforced, client-proof.
 *
 * Writes the entity record AND its uniqueness sentinel item(s) in a single
 * TransactWriteItems, with attribute_not_exists on every sentinel. A second
 * create with the same business key — from ANY client, with ANY bug, in ANY
 * race — cancels the transaction. "Even if the client's logic seems good, the
 * backend bounces the write if its assumptions are wrong." (Gate plan, 2026-07-27.)
 *
 * Sentinels live in a SEPARATE table (default 'bndy-unique-keys', PK 'key')
 * — NOT in the entity tables, because several read paths full-scan those
 * tables and sentinel items would leak into the app.
 *
 * Modes (env GATE_MODE, default 'log' until backfill completes — see rollout
 * plan Phase 4/5):
 *   off     — plain put, no gate (emergency hatch only)
 *   log     — duplicate detected -> loud WOULD_BOUNCE log, record still
 *             written WITHOUT claiming the key (collision telemetry mode)
 *   enforce — duplicate detected -> record NOT written, caller returns 409
 *
 * Degrades safely: if the unique-keys table doesn't exist yet, logs a loud
 * warning and behaves like 'off' for that call.
 *
 * This file is canonical in shared/identity/ and byte-synced into each
 * lambda's lib/ by shared/identity/check-sync.test.js. aws-sdk v2
 * DocumentClient only (events-agent-lambda is SDK v3 and carries its own
 * v3 port — see events-agent-lambda/lib note in the manifest).
 */

'use strict';

const UNIQUE_KEYS_TABLE = process.env.UNIQUE_KEYS_TABLE || 'bndy-unique-keys';

function gateMode() {
  const m = (process.env.GATE_MODE || 'log').toLowerCase();
  return ['off', 'log', 'enforce'].includes(m) ? m : 'log';
}

/**
 * Find which of the given sentinel keys already exists (used after a
 * transaction cancel to report the conflict; aws-sdk v2 doesn't expose
 * CancellationReasons structurally, so we re-read).
 */
async function findExistingKey(dynamodb, keys) {
  for (const key of keys) {
    try {
      const res = await dynamodb.get({ TableName: UNIQUE_KEYS_TABLE, Key: { key } }).promise();
      if (res.Item) return res.Item;
    } catch (e) { /* fall through — reported as unknown conflict */ }
  }
  return null;
}

/**
 * Atomically write an entity record plus its uniqueness sentinels.
 *
 * @param {AWS.DynamoDB.DocumentClient} dynamodb
 * @param {object} opts
 * @param {string}   opts.tableName   entity table
 * @param {object}   opts.item        entity item to put
 * @param {string[]} opts.keys        sentinel key strings (e.g. 'venue#gplace#ChIJ…'); empty array -> plain put
 * @param {string}   opts.entityType  'artist' | 'venue' | 'event'
 * @param {string}   [opts.source]    writer attribution for the sentinel item
 * @returns {Promise<{written: boolean, gate: 'off'|'claimed'|'logged-duplicate'|'duplicate'|'unavailable', existing?: {key: string, refId: string}}>}
 *   gate==='duplicate' means NOT written — caller must return 409 with existing.refId.
 */
async function gatedPut(dynamodb, { tableName, item, keys, entityType, source }) {
  const mode = gateMode();
  const cleanKeys = (keys || []).filter(Boolean);

  if (mode === 'off' || cleanKeys.length === 0) {
    await dynamodb.put({ TableName: tableName, Item: item }).promise();
    return { written: true, gate: 'off' };
  }

  const now = new Date().toISOString();
  const transactItems = [
    ...cleanKeys.map((key) => ({
      Put: {
        TableName: UNIQUE_KEYS_TABLE,
        Item: { key, refId: item.id, entityType, source: source || 'unknown', createdAt: now },
        ConditionExpression: 'attribute_not_exists(#k)',
        ExpressionAttributeNames: { '#k': 'key' },
      },
    })),
    { Put: { TableName: tableName, Item: item } },
  ];

  try {
    await dynamodb.transactWrite({ TransactItems: transactItems }).promise();
    return { written: true, gate: 'claimed' };
  } catch (err) {
    if (err.code === 'ResourceNotFoundException') {
      console.error(`UNIQUE-GATE UNAVAILABLE: table ${UNIQUE_KEYS_TABLE} missing — writing UNGATED. Create the table.`);
      await dynamodb.put({ TableName: tableName, Item: item }).promise();
      return { written: true, gate: 'unavailable' };
    }
    if (err.code === 'TransactionCanceledException') {
      const existing = await findExistingKey(dynamodb, cleanKeys);
      const detail = {
        entityType, mode,
        attemptedId: item.id,
        conflictKey: existing ? existing.key : '(unresolved)',
        existingRefId: existing ? existing.refId : null,
        source: source || 'unknown',
      };
      if (mode === 'enforce') {
        console.warn('UNIQUE-GATE BOUNCED', JSON.stringify(detail));
        return { written: false, gate: 'duplicate', existing: existing || undefined };
      }
      // log mode: telemetry, then write anyway (no sentinel claimed — backfill will reconcile)
      console.warn('UNIQUE-GATE WOULD_BOUNCE (log mode)', JSON.stringify(detail));
      await dynamodb.put({ TableName: tableName, Item: item }).promise();
      return { written: true, gate: 'logged-duplicate', existing: existing || undefined };
    }
    throw err;
  }
}

/**
 * Re-key sentinels when an entity's identity fields CHANGE (rename, relocate,
 * FB change, event artist/venue/date edit). Verification finding 2026-07-28:
 * updates previously bypassed the gate entirely — a rename could create an
 * unguarded duplicate identity AND permanently strand the old key.
 *
 * Atomically (one TransactWriteItems): claims every NEW key with
 * attribute_not_exists + releases every no-longer-used OLD key that this
 * entity actually owns (refId check via pre-read; sentinels owned by another
 * record, or absent, are left alone).
 *
 * Returns:
 *   {changed:false}                       — keys identical, nothing to do
 *   {changed:true, ok:true}               — re-keyed (or mode off / table missing)
 *   {changed:true, ok:false, existing}    — ENFORCE mode: new key already owned
 *       by another record. Caller must 409 and NOT perform the update.
 *   In log mode a conflict logs WOULD_BOUNCE and returns ok:true WITHOUT
 *   touching sentinels (update proceeds; integrity check reconciles later).
 */
async function rekeyUniqueKeys(dynamodb, { oldKeys, newKeys, refId, entityType, source }) {
  const mode = gateMode();
  const oldSet = new Set((oldKeys || []).filter(Boolean));
  const newSet = new Set((newKeys || []).filter(Boolean));
  const toClaim = [...newSet].filter((k) => !oldSet.has(k));
  const toRelease = [...oldSet].filter((k) => !newSet.has(k));

  if (toClaim.length === 0 && toRelease.length === 0) return { changed: false };
  if (mode === 'off') return { changed: true, ok: true, gate: 'off' };

  try {
    // Only release old sentinels this record actually owns.
    const ownedReleases = [];
    for (const key of toRelease) {
      const res = await dynamodb.get({ TableName: UNIQUE_KEYS_TABLE, Key: { key } }).promise();
      if (res.Item && res.Item.refId === refId) ownedReleases.push(key);
    }

    const now = new Date().toISOString();
    const transactItems = [
      ...toClaim.map((key) => ({
        Put: {
          TableName: UNIQUE_KEYS_TABLE,
          Item: { key, refId, entityType, source: source || 'rekey', createdAt: now },
          ConditionExpression: 'attribute_not_exists(#k)',
          ExpressionAttributeNames: { '#k': 'key' },
        },
      })),
      ...ownedReleases.map((key) => ({
        Delete: { TableName: UNIQUE_KEYS_TABLE, Key: { key } },
      })),
    ];
    if (transactItems.length === 0) return { changed: true, ok: true, gate: 'noop' };

    await dynamodb.transactWrite({ TransactItems: transactItems }).promise();
    return { changed: true, ok: true, gate: 'rekeyed' };
  } catch (err) {
    if (err.code === 'ResourceNotFoundException') {
      console.error(`UNIQUE-GATE UNAVAILABLE (rekey): table ${UNIQUE_KEYS_TABLE} missing`);
      return { changed: true, ok: true, gate: 'unavailable' };
    }
    if (err.code === 'TransactionCanceledException') {
      const existing = await findExistingKey(dynamodb, toClaim);
      const detail = { entityType, mode, refId, conflictKey: existing ? existing.key : '(unresolved)', existingRefId: existing ? existing.refId : null };
      if (mode === 'enforce') {
        console.warn('UNIQUE-GATE REKEY BOUNCED', JSON.stringify(detail));
        return { changed: true, ok: false, gate: 'duplicate', existing: existing || undefined };
      }
      console.warn('UNIQUE-GATE REKEY WOULD_BOUNCE (log mode)', JSON.stringify(detail));
      return { changed: true, ok: true, gate: 'logged-duplicate', existing: existing || undefined };
    }
    throw err;
  }
}

/**
 * Best-effort sentinel release — call from delete/merge paths so a deleted
 * entity's business key becomes claimable again. Never throws.
 */
async function releaseUniqueKeys(dynamodb, keys, expectedRefId) {
  for (const key of (keys || []).filter(Boolean)) {
    try {
      const params = { TableName: UNIQUE_KEYS_TABLE, Key: { key } };
      if (expectedRefId) {
        params.ConditionExpression = 'refId = :r';
        params.ExpressionAttributeValues = { ':r': expectedRefId };
      }
      await dynamodb.delete(params).promise();
    } catch (e) {
      if (e.code !== 'ConditionalCheckFailedException' && e.code !== 'ResourceNotFoundException') {
        console.warn(`UNIQUE-GATE release failed for ${key}: ${e.code || e.message}`);
      }
    }
  }
}

/** Standard 409 body so every route reports duplicates the same way (MCP parses this shape — no more regex-on-message). */
function duplicateResponseBody(entityType, existing) {
  return {
    error: `Duplicate ${entityType}`,
    code: 'DUPLICATE',
    entityType,
    existingId: existing ? existing.refId : null,
    conflictKey: existing ? existing.key : null,
  };
}

module.exports = { gatedPut, rekeyUniqueKeys, releaseUniqueKeys, duplicateResponseBody, gateMode, UNIQUE_KEYS_TABLE };
