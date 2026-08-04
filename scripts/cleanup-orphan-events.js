/**
 * One-off cleanup: Delete orphan events with dead artist references (Fix #6a, 2026-07-29)
 *
 * Problem: Cleanup deleted duplicate artists but left EVENTS behind, pointing at
 * dead artistIds. Frontend renders them as artist "Artist" with no link.
 *
 * Examples: events b01a0b4c + 850b37fd @ Swiftys 2026-08-01 (already manually deleted)
 *
 * Root cause: Artist deletion before Fix #6b guard was added - no server-side
 * check that artist has zero events before allowing delete.
 *
 * Fix: Scan ALL events, verify all artist references exist, delete future-dated
 * import-only orphans, report rest for manual review.
 *
 * IMPORTANT (2026-08-04): NEVER delete events that are:
 *   - type: 'unavailable', 'rehearsal', 'other', 'blocked' (backstage events)
 *   - ownerUserId set (member-created unavailability)
 *   - non-public without venue (likely backstage, not orphaned gigs)
 * These are legitimate records, not orphaned public gigs. 182 events were
 * accidentally deleted and had to be restored via PITR.
 */

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

const EVENTS_TABLE = 'bndy-events';
const ARTISTS_TABLE = 'bndy-artists';

// Batch get helper - splits into chunks of 100 (DynamoDB limit)
async function batchGetArtists(artistIds) {
  const results = new Map();
  const chunks = [];

  // Remove duplicates
  const uniqueIds = [...new Set(artistIds)];

  // Split into chunks of 100
  for (let i = 0; i < uniqueIds.length; i += 100) {
    chunks.push(uniqueIds.slice(i, i + 100));
  }

  for (const chunk of chunks) {
    const params = {
      RequestItems: {
        [ARTISTS_TABLE]: {
          Keys: chunk.map(id => ({ id }))
        }
      }
    };

    const result = await dynamodb.batchGet(params).promise();
    const items = result.Responses[ARTISTS_TABLE] || [];

    items.forEach(item => {
      results.set(item.id, item);
    });
  }

  return results;
}

async function scanAllEvents() {
  console.log('Scanning bndy-events for all events...\n');

  const events = [];
  let lastKey = undefined;
  let scannedCount = 0;

  do {
    const params = {
      TableName: EVENTS_TABLE,
      ExclusiveStartKey: lastKey
    };

    const result = await dynamodb.scan(params).promise();
    scannedCount += result.Count;

    events.push(...result.Items);
    lastKey = result.LastEvaluatedKey;

    process.stdout.write(`\rScanned ${scannedCount} events...`);
  } while (lastKey);

  console.log(`\n\nFound ${events.length} total events\n`);
  return events;
}

function extractArtistIds(event) {
  const ids = new Set();

  // Primary artistId
  if (event.artistId) ids.add(event.artistId);

  // artistIds array (legacy multi-artist field)
  if (Array.isArray(event.artistIds)) {
    event.artistIds.forEach(id => ids.add(id));
  }

  // collaboratingArtistIds
  if (Array.isArray(event.collaboratingArtistIds)) {
    event.collaboratingArtistIds.forEach(id => ids.add(id));
  }

  return [...ids];
}

async function findOrphans(events) {
  console.log('Checking which artists still exist...\n');

  // Extract ALL artist IDs referenced by any event
  const allArtistIds = new Set();
  events.forEach(e => {
    extractArtistIds(e).forEach(id => allArtistIds.add(id));
  });

  console.log(`Unique artists referenced: ${allArtistIds.size}`);

  // Batch get all artists
  const existingArtists = await batchGetArtists([...allArtistIds]);
  console.log(`Artists that exist: ${existingArtists.size}`);

  // Find orphans (events where at least one artist reference is dead)
  const orphans = [];
  const deadArtistIds = new Set();

  events.forEach(event => {
    const artistIds = extractArtistIds(event);
    const deadIds = artistIds.filter(id => !existingArtists.has(id));

    if (deadIds.length > 0) {
      orphans.push({
        event,
        deadArtistIds: deadIds,
        allArtistIds: artistIds
      });
      deadIds.forEach(id => deadArtistIds.add(id));
    }
  });

  return { orphans, deadArtistIds, totalEvents: events.length };
}

function isImportOnlyEvent(event) {
  // Check if event only has externalIds from import sources
  const externalIds = event.external_ids || [];
  if (externalIds.length === 0) return false;

  const importSources = ['klma-stoke-gig-list', 'mcp_ai_import', 'source-runner'];
  return externalIds.every(ext => importSources.includes(ext.source));
}

function isFutureEvent(event) {
  const eventDate = new Date(event.date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return eventDate >= today;
}

async function categorizeOrphans(orphans) {
  // GUARD: Never delete member-created events (unavailability, rehearsals, etc.)
  // These are legitimate backstage records, not orphaned public gigs.
  // Fix applied 2026-08-04 after accidental deletion of 182 events.
  const PROTECTED_TYPES = ['unavailable', 'rehearsal', 'other', 'blocked'];

  const autoDelete = [];
  const manualReview = [];

  for (const orphan of orphans) {
    const event = orphan.event;

    // Protect events with ownerUserId (member-created)
    if (event.ownerUserId) {
      manualReview.push(orphan);
      continue;
    }

    // Protect private event types
    if (PROTECTED_TYPES.includes(event.type)) {
      manualReview.push(orphan);
      continue;
    }

    // Protect non-public events without a venue (likely backstage events)
    if (!event.isPublic && !event.venueId) {
      manualReview.push(orphan);
      continue;
    }

    // Public gigs with dead artist references can be auto-deleted
    autoDelete.push(orphan);
  }

  return { autoDelete, manualReview };
}

async function deleteOrphans(orphans, dryRun = false) {
  if (orphans.length === 0) {
    console.log('\n✅ No orphan events to auto-delete\n');
    return { deleted: 0, ids: [] };
  }

  console.log(`\n⚠️  Found ${orphans.length} orphan events eligible for auto-delete\n`);

  if (dryRun) {
    console.log('DRY RUN - would delete the following orphan events:');
    orphans.forEach(({ event, deadArtistIds }) => {
      console.log(`  - ${event.id} "${event.title}" @ ${event.date} (dead artists: ${deadArtistIds.join(', ')})`);
    });
    return { deleted: 0, ids: orphans.map(o => o.event.id) };
  }

  console.log('Deleting orphan events...\n');

  const deletedIds = [];
  let deleted = 0;

  // Delete in batches of 25 (DynamoDB batchWrite limit)
  for (let i = 0; i < orphans.length; i += 25) {
    const batch = orphans.slice(i, i + 25);

    const params = {
      RequestItems: {
        [EVENTS_TABLE]: batch.map(o => ({
          DeleteRequest: { Key: { id: o.event.id } }
        }))
      }
    };

    await dynamodb.batchWrite(params).promise();

    deleted += batch.length;
    deletedIds.push(...batch.map(o => o.event.id));

    process.stdout.write(`\rDeleted ${deleted}/${orphans.length} orphan events...`);
  }

  console.log('\n');
  return { deleted, ids: deletedIds };
}

function generateReport(orphans, deadArtistIds, autoDeleted, manualReview) {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ORPHAN EVENTS CLEANUP REPORT');
  console.log('═══════════════════════════════════════════════════════════\n');

  console.log(`Total orphan events found: ${orphans.length}`);
  console.log(`Dead artist IDs: ${deadArtistIds.size}`);
  console.log(`Auto-deleted (future + import-only): ${autoDeleted.length}`);
  console.log(`Requires manual review: ${manualReview.length}\n`);

  if (deadArtistIds.size > 0) {
    console.log('Dead artist IDs referenced:\n');
    [...deadArtistIds].forEach(id => console.log(`  - ${id}`));
    console.log('');
  }

  if (autoDeleted.length > 0) {
    console.log('Auto-deleted events:\n');
    autoDeleted.forEach(({ event, deadArtistIds }) => {
      console.log(`  Event: ${event.id}`);
      console.log(`    Title: ${event.title || 'Untitled'}`);
      console.log(`    Date: ${event.date}`);
      console.log(`    Venue: ${event.venueId || 'None'}`);
      console.log(`    Dead artists: ${deadArtistIds.join(', ')}`);
      console.log(`    Created: ${event.created_at || event.createdAt || 'Unknown'}`);
      console.log('');
    });
  }

  if (manualReview.length > 0) {
    console.log('⚠️  MANUAL REVIEW REQUIRED (past events or non-import sources):\n');
    manualReview.forEach(({ event, deadArtistIds, allArtistIds }) => {
      console.log(`  Event: ${event.id}`);
      console.log(`    Title: ${event.title || 'Untitled'}`);
      console.log(`    Date: ${event.date}`);
      console.log(`    Venue: ${event.venueId || 'None'}`);
      console.log(`    Dead artists: ${deadArtistIds.join(', ')}`);
      console.log(`    All artists: ${allArtistIds.join(', ')}`);
      console.log(`    External IDs: ${JSON.stringify(event.external_ids || [])}`);
      console.log(`    Created: ${event.created_at || event.createdAt || 'Unknown'}`);
      console.log('');
    });
  }

  console.log('═══════════════════════════════════════════════════════════\n');

  return {
    totalOrphans: orphans.length,
    deadArtists: deadArtistIds.size,
    autoDeleted: autoDeleted.length,
    manualReview: manualReview.length
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
  }

  try {
    // Step 1: Scan all events
    const events = await scanAllEvents();

    // Step 2: Find orphans
    const { orphans, deadArtistIds, totalEvents } = await findOrphans(events);

    if (orphans.length === 0) {
      console.log('✅ No orphan events found - all event→artist references are valid!\n');
      return;
    }

    // Step 3: Categorize (auto-delete vs manual review)
    const { autoDelete, manualReview } = await categorizeOrphans(orphans);

    // Step 4: Delete auto-delete candidates
    const { deleted, ids } = await deleteOrphans(autoDelete, dryRun);

    // Step 5: Generate report
    const stats = generateReport(orphans, deadArtistIds, autoDelete, manualReview);

    console.log('✅ Cleanup complete!\n');

    if (!dryRun && deleted > 0) {
      console.log(`Deleted ${deleted} orphan events with dead artist references.\n`);
    }

    if (manualReview.length > 0) {
      console.log(`⚠️  ${manualReview.length} events require manual review (see above).\n`);
    }

  } catch (error) {
    console.error('\n❌ ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run cleanup
console.log('Starting orphan events cleanup...\n');
main();
