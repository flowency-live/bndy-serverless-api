/**
 * Backfill geohash4/geohash6/geoLat/geoLng on bndy-events (audit A1).
 *
 * DRY-RUN BY DEFAULT — prints what it would do. Run with --execute to write.
 * Writes geo-backfill-report.json either way. Events whose venue has no
 * coordinates are REPORTED (they feed the venue-geocoding cleanup), not
 * silently skipped.
 *
 *   node backfill-geohash.js            # dry run
 *   node backfill-geohash.js --execute  # write updates
 */
const AWS = require('aws-sdk');
const fs = require('fs');
const { computeGeohashFields } = require('./lib/geohash');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const EVENTS_TABLE = 'bndy-events';
const VENUES_TABLE = 'bndy-venues';
const EXECUTE = process.argv.includes('--execute');
const CONCURRENCY = 10;

async function scanAllPaginated(params) {
  const items = [];
  let key;
  do {
    const page = await dynamodb.scan(key ? { ...params, ExclusiveStartKey: key } : params).promise();
    items.push(...(page.Items || []));
    key = page.LastEvaluatedKey;
    process.stdout.write(`\r  scanned so far: ${items.length}   `);
  } while (key);
  console.log('');
  return items;
}

const venueCache = new Map();
async function getVenue(venueId) {
  if (!venueId) return null;
  if (venueCache.has(venueId)) return venueCache.get(venueId);
  const res = await dynamodb.get({ TableName: VENUES_TABLE, Key: { id: venueId } }).promise();
  venueCache.set(venueId, res.Item || null);
  return res.Item || null;
}

async function updateWithRetry(id, fields, attempt = 0) {
  try {
    await dynamodb.update({
      TableName: EVENTS_TABLE,
      Key: { id },
      UpdateExpression: 'SET geohash4 = :g4, geohash6 = :g6, geoLat = :lat, geoLng = :lng',
      ExpressionAttributeValues: {
        ':g4': fields.geohash4, ':g6': fields.geohash6,
        ':lat': fields.geoLat, ':lng': fields.geoLng,
      },
    }).promise();
  } catch (err) {
    if (attempt < 3 && (err.code === 'ProvisionedThroughputExceededException' || err.code === 'ThrottlingException')) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      return updateWithRetry(id, fields, attempt + 1);
    }
    throw err;
  }
}

async function main() {
  console.log(`Backfill geohash fields on ${EVENTS_TABLE} — ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}`);
  const candidates = await scanAllPaginated({
    TableName: EVENTS_TABLE,
    FilterExpression: 'attribute_not_exists(geohash4) OR attribute_not_exists(geohash6)',
  });
  console.log(`Candidates missing geohash fields: ${candidates.length}`);

  const report = {
    timestamp: new Date().toISOString(),
    mode: EXECUTE ? 'execute' : 'dry-run',
    candidates: candidates.length,
    updated: 0,
    failed: [],
    missingVenue: [],
    missingCoords: [],
  };

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (ev) => {
      const venue = await getVenue(ev.venueId);
      if (!venue) {
        report.missingVenue.push({ eventId: ev.id, venueId: ev.venueId || null, date: ev.date });
        return;
      }
      const fields = computeGeohashFields(venue);
      if (!fields.geohash4 || !fields.geohash6) {
        report.missingCoords.push({ eventId: ev.id, venueId: venue.id, venueName: venue.name, date: ev.date });
        return;
      }
      if (EXECUTE) {
        try {
          await updateWithRetry(ev.id, fields);
          report.updated += 1;
        } catch (err) {
          report.failed.push({ eventId: ev.id, error: err.message });
        }
      } else {
        report.updated += 1; // would update
      }
    }));
    process.stdout.write(`\r  processed: ${Math.min(i + CONCURRENCY, candidates.length)}/${candidates.length}   `);
  }
  console.log('');

  const label = EXECUTE ? 'updated' : 'would update';
  console.log(`${label}: ${report.updated}`);
  console.log(`missing venue record: ${report.missingVenue.length}`);
  console.log(`venue has no coordinates: ${report.missingCoords.length}  <- feeds venue-geocoding cleanup`);
  console.log(`failed: ${report.failed.length}`);
  fs.writeFileSync('geo-backfill-report.json', JSON.stringify(report, null, 2));
  console.log('Report written to geo-backfill-report.json');
  if (report.failed.length > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
