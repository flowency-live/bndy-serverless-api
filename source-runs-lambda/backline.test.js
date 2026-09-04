const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('./backline');

test('Backline Explorer exposes every known source family', () => {
  assert.deepEqual(Object.keys(__test.SOURCE_FAMILIES), [
    'lemonrock',
    'onthecase',
    'klma',
    'bndy',
    'gigs-news',
    'sceniceye',
    'insangel',
    'livebandphotos',
    'fizgig',
  ]);
  assert.equal(__test.resolveFamily('klma').sourceIds[0], 'klma-stoke-gig-list');
  assert.equal(__test.resolveFamily('missing'), null);
});

test('Backline graph accepts only bounded typed node references', () => {
  assert.deepEqual(__test.parseGraphNodeRef('source:klma-stoke-gig-list'), {
    kind: 'source', id: 'klma-stoke-gig-list',
  });
  assert.deepEqual(__test.parseGraphNodeRef('candidate:event-candidate:2026-09-01:artist:venue'), {
    kind: 'candidate',
    subjectType: 'event-candidate',
    subjectKey: '2026-09-01:artist:venue',
  });
  assert.deepEqual(__test.parseGraphNodeRef('entity:venue:venue-123'), {
    kind: 'entity', entityType: 'venue', entityId: 'venue-123',
  });
  assert.throws(() => __test.parseGraphNodeRef('table:scan-all'), /Unknown node ref/);
  assert.throws(() => __test.parseGraphNodeRef('entity:user:user-123'), /Invalid node ref/);
});

test('Backline graph labels Claims without leaking unbounded values', () => {
  const label = __test.graphClaimLabel({ predicate: 'description', value: 'x'.repeat(100) });
  assert.equal(label, `description = ${'x'.repeat(60)}`);
  assert.equal(__test.shortGraphKey('x'.repeat(60)), `${'x'.repeat(45)}...`);
});

test('canonical corpus convergence state stays honest across the hydration lifecycle', () => {
  assert.equal(__test.corpusConvergenceState(null, null), 'not-ready');
  assert.equal(__test.corpusConvergenceState({ status: 'complete' }, null), 'baseline-stale');
  assert.equal(__test.corpusConvergenceState({ status: 'complete' }, { status: 'running' }), 'hydrating');
  assert.equal(__test.corpusConvergenceState({ status: 'complete' }, { status: 'failed' }), 'attention');
  assert.equal(__test.corpusConvergenceState({ status: 'complete' }, { status: 'complete' }), 'converged');
});

test('canonical hydration responses expose counts but not DynamoDB keys', () => {
  const hydration = __test.publicHydration({
    pk: 'HYDRATION#CANONICAL',
    sk: 'LATEST',
    runId: 'delta-1',
    baselineSnapshotId: 'baseline-1',
    status: 'running',
    scanned: 42,
    inserted: 3,
    canonicalWritesEnabled: false,
  });
  assert.deepEqual(hydration, {
    runId: 'delta-1', baselineSnapshotId: 'baseline-1', startedAt: undefined,
    completedAt: undefined, updatedAt: undefined, status: 'running', mode: undefined,
    canonicalWritesEnabled: false, scanned: 42, unchanged: 0, inserted: 3,
    modified: 0, removed: 0, claims: 0, checkpointsBackfilled: 0,
    skippedWithoutId: 0, errors: [],
  });
  assert.equal('pk' in hydration, false);
});

test('On The Case band hydrations count as Artist activity', () => {
  const { stats } = __test.taskStats([
    { sourceId: 'onthecase-band-hydration', taskKey: 'band:1', taskKind: 'band', status: 'completed', updatedAt: '2026-08-28T08:00:00Z' },
    { sourceId: 'onthecase-venue-hydration', taskKey: 'venue:1', taskKind: 'venue', status: 'completed', updatedAt: '2026-08-28T08:00:00Z' },
    { sourceId: 'onthecase-gig-index', taskKey: 'root:1', taskKind: 'gig-index', status: 'completed', updatedAt: '2026-08-28T08:00:00Z' },
  ]);
  assert.deepEqual(stats.artists, { discovered: 1, hydrated: 1, failed: 0 });
  assert.deepEqual(stats.venues, { discovered: 1, hydrated: 1, failed: 0 });
  assert.equal(stats.queue.completed, 3);
});

test('newer task state wins for the same logical source identity', () => {
  const { stats, current } = __test.taskStats([
    { sourceId: 'lemonrock-gig-hydration', taskKey: 'old', logicalTaskKey: 'gig:1', taskKind: 'gig', status: 'failed', updatedAt: '2026-08-27T08:00:00Z' },
    { sourceId: 'lemonrock-gig-hydration', taskKey: 'new', logicalTaskKey: 'gig:1', taskKind: 'gig', status: 'completed', updatedAt: '2026-08-28T08:00:00Z' },
  ]);
  assert.equal(current.length, 1);
  assert.deepEqual(stats.gigs, { discovered: 1, hydrated: 1, failed: 0 });
});

test('interactive summary never claims to aggregate the full task ledger', () => {
  assert.deepEqual(__test.taskLedgerStatus(__test.resolveFamily('lemonrock')), {
    taskLedgerAvailable: true,
    taskStatsAvailable: false,
    taskStatsReason: 'Full-ledger aggregation is disabled on interactive requests. Use the paginated tasks endpoint.',
    stats: null,
    taskHistoryRows: null,
    uniqueCurrentTasks: null,
    failures: [],
  });
  assert.equal(__test.taskLedgerStatus(__test.resolveFamily('klma')).taskLedgerAvailable, false);
});

test('Trust Loop output is bounded to the read-only decision and health contract', () => {
  const value = __test.publicTrustLoopRun({
    id: 'trust-loop-1', completedAt: '2026-08-28T12:00:00Z', status: 'needs-review',
    candidatesSeen: 40, candidatesClassified: 40, canonicalWrites: 0,
    classifications: { resolved: 8, unresolved: 30, conflicted: 2 },
    providerQualification: {
      gateStatus: 'capture-failed',
      cases: 20,
      captureErrors: 17,
      canonicalWrites: 0,
    },
    reviewCases: [{ candidateKey: 'artist-1' }],
    decisions: [{ shouldNotLeakThroughSummary: true }],
  });
  assert.equal(value.candidatesClassified, 40);
  assert.equal(value.canonicalWrites, 0);
  assert.equal(value.providerQualification.gateStatus, 'capture-failed');
  assert.equal(value.providerQualification.canonicalWrites, 0);
  assert.equal(value.reviewCases.length, 1);
  assert.equal(value.decisions, undefined);
});

test('operations freshness verdict follows the 26 hour coverage contract', () => {
  const now = new Date('2026-09-04T12:00:00Z');
  const config = { id: 'klma-stoke-gig-list', name: 'KLMA', enabled: true, cadence: 'daily', shadow: true, writerAuthority: 'cowork', sourceRole: 'coverage-root', nextScanAt: '2026-09-05T08:00:00.000Z' };
  const healthy = __test.assessSourceFreshness(config, { lastSuccessfulRunAt: '2026-09-04T08:54:53.361Z', consecutiveFailures: 0 }, now);
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.ageHours, 3.09);
  assert.equal(healthy.maxStalenessHours, 26);
  assert.equal(healthy.nextScanAt, '2026-09-05T08:00:00.000Z');

  const stale = __test.assessSourceFreshness(config, { lastSuccessfulRunAt: '2026-09-02T08:00:00Z', consecutiveFailures: 2 }, now);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.consecutiveFailures, 2);

  assert.equal(__test.assessSourceFreshness(config, null, now).status, 'missing');
  assert.equal(__test.assessSourceFreshness(config, { lastSuccessfulRunAt: 'not-a-date' }, now).status, 'invalid');
  assert.equal(__test.assessSourceFreshness({ ...config, enabled: false }, { lastSuccessfulRunAt: '2026-09-04T08:00:00Z' }, now).status, 'disabled');
  assert.equal(__test.assessSourceFreshness({ ...config, maxStalenessHours: 2 }, { lastSuccessfulRunAt: '2026-09-04T08:54:53.361Z' }, now).status, 'stale');
});

test('operations exposes a would-write decision without leaking the supporting Claim bodies', () => {
  const item = __test.publicProjectionItem({
    pk: 'PROJECTION_ITEM#lemonrock-gig-hydration:obs-1:event:lemonrock-gig-hydration:lemonrock:gig:973876:create',
    sk: 'META',
    sourceId: 'lemonrock-gig-hydration',
    observationId: 'obs-1',
    candidateKey: 'event:lemonrock-gig-hydration:lemonrock:gig:973876',
    action: 'create',
    status: 'shadow',
    completedAt: '2026-09-04T11:17:33.651Z',
    details: {
      wouldWrite: 'create',
      reason: 'source is in shadow mode',
      candidate: {
        candidateKey: 'event:lemonrock-gig-hydration:lemonrock:gig:973876',
        sourceEventKey: 'lemonrock:gig:973876',
        artistName: 'Basher Tate',
        artistExternalId: 'lemonrock:artist:1',
        venueName: 'Cowick Street Railway Club',
        venueExternalId: 'lemonrock:venue:2',
        venueLocation: 'Exeter',
        date: '2027-05-01',
        startTime: '20:30',
        title: 'Basher Tate gig at Cowick Street Railway Club, Exeter',
        eventUrl: 'https://www.lemonrock.com/gig.php?id=973876',
        observedAt: '2026-09-04T11:17:00Z',
        supportingClaims: [{ id: 'c1', value: 'x'.repeat(5000) }, { id: 'c2' }],
      },
    },
  });
  assert.equal(item.idempotencyKey, 'lemonrock-gig-hydration:obs-1:event:lemonrock-gig-hydration:lemonrock:gig:973876:create');
  assert.equal(item.status, 'shadow');
  assert.equal(item.wouldWrite, 'create');
  assert.equal(item.reason, 'source is in shadow mode');
  assert.equal(item.candidate.artistName, 'Basher Tate');
  assert.equal(item.candidate.venueLocation, 'Exeter');
  assert.equal(item.candidate.supportingClaims, 2);
  assert.equal(JSON.stringify(item).includes('xxxxx'), false);
  assert.equal(item.details, undefined);

  const failed = __test.publicProjectionItem({ sourceId: 's', observationId: 'o', candidateKey: 'k', action: 'create', status: 'failed', error: 'boom', completedAt: '2026-09-04T00:00:00Z' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'boom');
  assert.equal(failed.wouldWrite, null);
  assert.equal(failed.candidate, null);
});

test('operations projection run summary is bounded to counts and status', () => {
  const run = __test.publicProjectionRun({
    pk: 'PROJECTION_RUN#obs-1', sk: 'META', entityType: 'ProjectionRun', sourceId: 'lemonrock-gig-hydration', observationId: 'obs-1',
    runId: 'run-1', status: 'success', expectedItems: 1, completedAt: '2026-09-04T11:17:33.651Z',
    counts: { itemsSeen: 1, claims: 156, artistsCreated: 0, artistsMatched: 0, venuesCreated: 0, venuesMatched: 0, eventsCreated: 0, eventsUpdated: 0, eventsCancelled: 0, projectionFailures: 0 },
    secret: 'never',
  });
  assert.deepEqual(Object.keys(run).sort(), ['completedAt', 'counts', 'expectedItems', 'observationId', 'runId', 'sourceId', 'status']);
  assert.equal(run.counts.claims, 156);
});

test('operations limit is bounded and defaults sensibly', () => {
  assert.equal(__test.boundedLimit(undefined, 25, 50), 25);
  assert.equal(__test.boundedLimit('10', 25, 50), 10);
  assert.equal(__test.boundedLimit('500', 25, 50), 50);
  assert.equal(__test.boundedLimit('0', 25, 50), 1);
  assert.equal(__test.boundedLimit('abc', 25, 50), 25);
});

test('operations route is registered in the handler dispatch pattern', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./handler.js'), 'utf8');
  assert.match(source, /\|operations\)\$\//);
});

test('run metrics expose the testimony savings counters', () => {
  const value = __test.publicRunMetric({
    runId: 'run-1', sourceId: 'onthecase-gig-index', startedAt: '2026-09-04T13:00:00Z', completedAt: '2026-09-04T13:00:03Z',
    status: 'completed', reason: 'manual', shadow: true, writerAuthority: 'cowork',
    claims: 0, unchanged: 250, projectionWorkItems: 0, reobservedUnchanged: 250, projectionSkipped: 0,
  });
  assert.equal(value.reobservedUnchanged, 250);
  assert.equal(value.projectionSkipped, 0);
  assert.equal(__test.publicRunMetric({ runId: 'r', sourceId: 's' }).reobservedUnchanged, 0);
});

test('would-write candidate count reads the compact record and the legacy embedded array alike', () => {
  const compact = __test.publicProjectionItem({ sourceId: 's', observationId: 'o', candidateKey: 'k', action: 'create', status: 'shadow',
    details: { wouldWrite: 'create', reason: 'r', candidate: { artistName: 'A', supportingClaimIds: ['c1', 'c2', 'c3'], supportingClaimCount: 3 } } });
  assert.equal(compact.candidate.supportingClaims, 3);
  assert.equal(JSON.stringify(compact).includes('supportingClaimIds'), false);
  const legacy = __test.publicProjectionItem({ sourceId: 's', observationId: 'o', candidateKey: 'k', action: 'create', status: 'shadow',
    details: { wouldWrite: 'create', reason: 'r', candidate: { artistName: 'A', supportingClaims: [{ id: 'c1' }, { id: 'c2' }] } } });
  assert.equal(legacy.candidate.supportingClaims, 2);
});
