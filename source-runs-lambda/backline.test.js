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
  ]);
  assert.equal(__test.resolveFamily('klma').sourceIds[0], 'klma-stoke-gig-list');
  assert.equal(__test.resolveFamily('missing'), null);
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
