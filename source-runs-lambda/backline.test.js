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
    'venue',
  ]);
  assert.equal(__test.resolveFamily('klma').sourceIds[0], 'klma-stoke-gig-list');
  assert.deepEqual(__test.resolveFamily('venue').sourceIds, ['venue-sugarmill', 'venue-eleven', 'venue-rigger']);
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

// ---------------------------------------------------------------------------
// Godmode holds inbox, read side (docs/delegation/TASK-godmode-holds-inbox-read.md)
// ---------------------------------------------------------------------------

test('holds route is registered in the handler dispatch pattern', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('./handler.js'), 'utf8');
  assert.match(source, /\|holds\|operations\)\$\//);
});

test('exception id is the engine digest of the projection idempotency key', () => {
  // sha256('abc') = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
  assert.equal(__test.exceptionIdFor('abc'), 'projection-exception-ba7816bf8f01cfea414140de5dae2223');
});

test('hold filters default to a thirty day window and bound the limit', () => {
  const now = new Date('2026-09-06T12:00:00Z');
  const defaults = __test.parseHoldFilters({}, now);
  assert.equal(defaults.since, '2026-08-07T12:00:00.000Z');
  assert.equal(defaults.limit, 100);
  assert.equal(defaults.source, null);
  assert.equal(defaults.classification, null);

  const explicit = __test.parseHoldFilters({ source: 'lemonrock-gig-hydration', classification: 'near-tie', since: '2026-09-01', limit: '9999' }, now);
  assert.equal(explicit.source, 'lemonrock-gig-hydration');
  assert.equal(explicit.classification, 'near-tie');
  assert.equal(explicit.since, '2026-09-01T00:00:00.000Z');
  assert.equal(explicit.limit, 200);

  assert.throws(() => __test.parseHoldFilters({ since: 'yesterday' }, now), /since/);
});

test('hold kind is derived from the classification and the reason text', () => {
  const kind = (classification, reason) => __test.holdKind({ classification }, reason);
  assert.equal(kind('unresolved-entity', "artist 'X' needs review: Near-tie margin guard: top 2 candidates within 10pt"), 'near-tie');
  assert.equal(kind('unresolved-entity', 'Name matched but location differs - possible same-name collision'), 'location-differs');
  assert.equal(kind('unresolved-entity', 'Same-name collision detected'), 'ambiguous');
  assert.equal(kind('awaiting-verification', 'x'), 'awaiting-verification');
  assert.equal(kind('rejected-by-canonical', 'x'), 'rejected-by-canonical');
  assert.equal(kind('existing-event-bill-differs', 'x'), 'existing-event-bill-differs');
  assert.equal(kind('existing-event-venue-differs', 'x'), 'existing-event-venue-differs');
  assert.equal(kind('bill-too-large', 'x'), 'bill-too-large');
  assert.equal(kind('match-only-violation', 'x'), 'other');
  assert.equal(kind(undefined, 'Additive-only projection will not reinstate a tombstoned Event'), 'other');
});

test('public hold carries the gig, the reason and the bndy candidates without raw keys', () => {
  const exception = {
    pk: 'EXCEPTION#projection-exception-abc',
    sk: 'META',
    status: 'open',
    sourceId: 'lemonrock-gig-hydration',
    observationId: 'obs-1',
    candidateKey: 'event:lemonrock-gig-hydration:lemonrock:gig:973876',
    projectionAction: 'create',
    reason: "artist 'Basher Tate' needs review: Near-tie margin guard: top 2 candidates within 10pt (margin=4)",
    createdAt: '2026-09-05T10:00:00.000Z',
    details: {
      classification: 'unresolved-entity',
      entityType: 'artist',
      entityName: 'Basher Tate',
      reason: 'Near-tie margin guard: top 2 candidates within 10pt (margin=4)',
      candidates: [
        { id: 'a1', name: 'Basher Tate', location: 'Exeter, UK', nameVariants: ['Basher'], confidence: 0.91, secret: 'no' },
        { id: 'a2', name: 'Basher Tate Band', location: 'Plymouth, UK', confidence: 0.87 },
      ],
    },
  };
  const candidate = {
    pk: 'CANDIDATE#event#event:lemonrock-gig-hydration:lemonrock:gig:973876',
    sk: 'META',
    artistName: 'Basher Tate',
    venueName: 'Cowick Street Railway Club',
    venueLocation: 'Exeter',
    date: '2027-05-01',
    startTime: '20:30',
    eventUrl: 'https://www.lemonrock.com/gig.php?id=973876',
    supportingClaimIds: ['c1', 'c2'],
    GSI1PK: 'SOURCE#lemonrock-gig-hydration',
  };
  const hold = __test.publicHold(exception, candidate);
  assert.deepEqual(hold, {
    id: 'projection-exception-abc',
    status: 'open',
    createdAt: '2026-09-05T10:00:00.000Z',
    sourceId: 'lemonrock-gig-hydration',
    observationId: 'obs-1',
    candidateKey: 'event:lemonrock-gig-hydration:lemonrock:gig:973876',
    action: 'create',
    classification: 'unresolved-entity',
    kind: 'near-tie',
    reason: "artist 'Basher Tate' needs review: Near-tie margin guard: top 2 candidates within 10pt (margin=4)",
    entityType: 'artist',
    entityName: 'Basher Tate',
    gig: {
      artistName: 'Basher Tate',
      venueName: 'Cowick Street Railway Club',
      venueLocation: 'Exeter',
      date: '2027-05-01',
      startTime: '20:30',
      eventUrl: 'https://www.lemonrock.com/gig.php?id=973876',
    },
    candidates: [
      { id: 'a1', name: 'Basher Tate', location: 'Exeter, UK', confidence: 0.91 },
      { id: 'a2', name: 'Basher Tate Band', location: 'Plymouth, UK', confidence: 0.87 },
    ],
    details: { eventId: undefined, eventVenueId: undefined, venueId: undefined, missingArtistIds: undefined, acts: undefined, code: undefined, detail: undefined, subjectKey: undefined },
  });
  assert.equal(Object.keys(hold).includes('pk'), false);

  const bare = __test.publicHold({ pk: 'EXCEPTION#projection-exception-x', status: 'open', reason: 'r', createdAt: '2026-09-01T00:00:00Z' }, null);
  assert.equal(bare.kind, 'other');
  assert.equal(bare.gig, null);
  assert.deepEqual(bare.candidates, []);
});

test('hold summary counts open holds per kind and per source', () => {
  const rows = [
    { kind: 'near-tie', sourceId: 'a' },
    { kind: 'near-tie', sourceId: 'b' },
    { kind: 'awaiting-verification', sourceId: 'a' },
  ];
  assert.deepEqual(__test.summariseHolds(rows), {
    total: 3,
    byKind: { 'near-tie': 2, 'awaiting-verification': 1 },
    bySource: { a: 2, b: 1 },
  });
});

test('held projection items are the successes whose outcome was an exception', () => {
  assert.equal(__test.isHeldProjectionItem({ status: 'success', details: { outcome: 'exception' } }), true);
  assert.equal(__test.isHeldProjectionItem({ status: 'success', details: { outcome: 'projected' } }), false);
  assert.equal(__test.isHeldProjectionItem({ status: 'shadow', details: { outcome: 'exception' } }), false);
  assert.equal(__test.isHeldProjectionItem({ status: 'failed' }), false);
});
