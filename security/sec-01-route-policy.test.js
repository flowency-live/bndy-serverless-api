'use strict';

/**
 * SEC-01: Route Security Regression Test
 *
 * This test prevents security regression by ensuring:
 *   1. Every mutation route is explicitly classified in route-policy.json
 *   2. New routes cannot be added without classification
 *
 * Auth methods:
 *   - handler-auth: Auth checked in Lambda handler (SEC-04)
 *   - sam-auth: SAM-level authorizer declared
 *   - community: Public routes with app-level controls (rate-limit, honeypot)
 *   - auth-flow: Auth endpoints that handle their own authentication
 *   - mcp: MCP routes (machine-to-machine, internal)
 *
 * To add a new mutation route:
 *   1. Add it to mutationRouteBaseline in this file OR explicitRoutes in route-policy.json
 *   2. Document the auth method used
 *   3. Get security review before merging
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { parseSamRoutes, MUTATION_METHODS } = require('../scripts/security-route-inventory');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_PATH = path.join(ROOT, 'template.yaml');
const POLICY_PATH = path.join(ROOT, 'security', 'route-policy.json');

/**
 * Baseline of all mutation routes as of SEC-04 completion.
 * Each route is classified by its auth method.
 *
 * IMPORTANT: This is a security-critical file. Any additions require review.
 */
const MUTATION_ROUTE_BASELINE = {
  // === Artists ===
  'POST /api/artists': 'handler-auth',
  'PUT /api/artists/{id}': 'handler-auth',
  'PATCH /api/artists/{id}/profile': 'handler-auth',
  'PUT /api/artists/{id}/mcp': 'mcp',
  'DELETE /api/artists/{id}/mcp': 'mcp', // SEC-AUD-004: now requires service token auth
  'DELETE /api/artists/{id}': 'handler-auth',
  'POST /api/artists/{id}/refresh-facebook-image': 'handler-auth',

  // === Enrichment: Artists ===
  'PATCH /api/artists/{id}/enrichment': 'handler-auth',

  // === Curator: Artists ===
  'PUT /api/curator/artists/{id}': 'handler-auth',
  'POST /api/curator/artists/{id}/hide': 'handler-auth',
  'POST /api/curator/artists/{id}/restore': 'handler-auth',

  // === Community (public wizard - SEC-COMMUNITY) ===
  'POST /api/community/artists/find-or-create': 'community',
  'POST /api/community/venues/find-or-create': 'community',
  'POST /api/community/events': 'community',
  'POST /api/artists/find-or-create': 'community',
  'POST /api/artists/find-or-create/mcp': 'mcp',
  'POST /api/artists/community': 'community',
  'POST /api/events/community': 'community',
  'POST /api/events/community/mcp': 'mcp',

  // === Events ===
  'POST /api/events': 'handler-auth',
  'PUT /api/events/{id}': 'handler-auth',
  'PUT /api/events/{id}/mcp': 'mcp',
  'DELETE /api/events/{id}/mcp': 'mcp', // SEC-AUD-004: now requires service token auth
  'DELETE /api/events/{id}': 'handler-auth',
  'POST /api/artists/{artistId}/events': 'handler-auth',
  'PUT /api/artists/{artistId}/events/{id}': 'handler-auth',
  'DELETE /api/artists/{artistId}/events/{id}': 'handler-auth',
  'POST /api/artists/{artistId}/events/{id}/leave': 'handler-auth',
  'POST /api/artists/{artistId}/events/toggle-availability': 'handler-auth',
  'POST /api/artists/{artistId}/events/bulk-availability': 'handler-auth',
  'POST /api/artists/{artistId}/events/check-conflicts': 'handler-auth',
  'POST /api/artists/{artistId}/public-gigs': 'handler-auth',
  'POST /api/events/batch': 'handler-auth',

  // === Curator: Events ===
  'PUT /api/curator/events/{id}': 'handler-auth',
  'POST /api/curator/events/{id}/hide': 'handler-auth',
  'POST /api/curator/events/{id}/restore': 'handler-auth',
  'POST /api/curator/events/{id}/cancel': 'handler-auth',
  'POST /api/curator/events/{id}/uncancel': 'handler-auth',
  'POST /api/curator/events/festival-tag': 'handler-auth',

  // === Calendar ===
  'POST /api/artists/{artistId}/calendar/subscribe': 'handler-auth',
  'DELETE /api/artists/{artistId}/calendar/subscriptions/{subscriptionId}': 'handler-auth',
  'POST /api/users/me/unavailability': 'handler-auth',
  'POST /api/integration/events': 'handler-auth',

  // === Venues ===
  'POST /api/venues': 'handler-auth',
  'POST /api/venues/find-or-create': 'handler-auth',
  'POST /api/venues/find-or-create/mcp': 'mcp',
  'PUT /api/venues/{id}': 'handler-auth',
  'DELETE /api/venues/{id}': 'handler-auth',
  'DELETE /api/venues/{id}/mcp': 'mcp', // SEC-AUD-004: now requires service token auth
  'PUT /api/venues/{id}/mcp': 'mcp',
  'POST /api/venues/{id}/enrich': 'mcp',
  'POST /api/integration/venues': 'handler-auth',
  'POST /api/venue-groups': 'handler-auth',
  'PUT /api/venue-groups/{id}': 'handler-auth',
  'PUT /api/venues/{id}/group': 'handler-auth',

  // === Enrichment: Venues ===
  'PATCH /api/venues/{id}/enrichment': 'handler-auth',

  // === Curator: Venues ===
  'PUT /api/curator/venues/{id}': 'handler-auth',
  'POST /api/curator/venues/{id}/hide': 'handler-auth',
  'POST /api/curator/venues/{id}/restore': 'handler-auth',

  // === Festivals ===
  'POST /festivals': 'handler-auth',
  'PATCH /festivals/{id}': 'handler-auth',

  // === Curator: Festivals ===
  'POST /api/curator/festivals': 'handler-auth',
  'PATCH /api/curator/festivals/{id}': 'handler-auth',

  // === Auth (handles own authentication) ===
  'POST /auth/login': 'auth-flow',
  'POST /auth/logout': 'auth-flow',
  'POST /auth/refresh': 'auth-flow',
  'POST /auth/register': 'auth-flow',
  'POST /auth/phone/request-otp': 'auth-flow',
  'POST /auth/phone/verify-otp': 'auth-flow',
  'POST /auth/phone/verify-and-onboard': 'auth-flow',
  'POST /auth/email/request-magic': 'auth-flow',
  'POST /auth/check-identity': 'auth-flow',

  // === Users ===
  'PUT /users/{userId}': 'handler-auth',
  'DELETE /users/{userId}': 'handler-auth',
  'PUT /users/profile': 'handler-auth',
  'POST /users/favourites/toggle': 'handler-auth',
  'PUT /users/{userId}/role': 'handler-auth',

  // === Community Flags (public - rate-limited) ===
  'POST /api/community/flags': 'community',
  'PUT /users/flags/{flagId}/resolve': 'handler-auth',

  // === Memberships ===
  'POST /api/memberships': 'handler-auth',
  'PUT /api/memberships/{membershipId}': 'handler-auth',
  'DELETE /api/memberships/{membershipId}': 'handler-auth',
  'POST /api/artists/{artistId}/members': 'handler-auth',

  // === Songs ===
  'POST /api/songs': 'handler-auth',
  'PUT /api/songs/{id}': 'handler-auth',
  'DELETE /api/songs/{id}': 'handler-auth',

  // === Issues ===
  'POST /api/issues': 'handler-auth',
  'POST /api/issues/batch': 'handler-auth',
  'PUT /api/issues/{id}': 'handler-auth',
  'DELETE /api/issues/{id}': 'handler-auth',

  // === Uploads ===
  'POST /uploads/presigned-url': 'handler-auth',

  // === Invites ===
  'POST /api/invites': 'handler-auth',
  'POST /api/invites/{token}/accept': 'handler-auth',
  'POST /api/invites/{token}/decline': 'handler-auth',
  'POST /api/artists/{artistId}/invites/general': 'handler-auth',
  'POST /api/artists/{artistId}/invites/phone': 'handler-auth',
  'DELETE /api/invites/{token}': 'handler-auth',

  // === Notifications ===
  'POST /api/notifications': 'handler-auth',
  'PUT /api/notifications/{id}/read': 'handler-auth',
  'PUT /api/notifications/{id}/dismiss': 'handler-auth',
  'DELETE /api/notifications/{id}': 'handler-auth',
  'POST /api/notifications/mark-all-read': 'handler-auth',

  // === Setlists ===
  'POST /api/setlists': 'handler-auth',
  'PUT /api/setlists/{id}': 'handler-auth',
  'DELETE /api/setlists/{id}': 'handler-auth',
  'POST /api/artists/{artistId}/setlists': 'handler-auth',
  'PUT /api/artists/{artistId}/setlists/{setlistId}': 'handler-auth',
  'DELETE /api/artists/{artistId}/setlists/{setlistId}': 'handler-auth',

  // === Artists Songs (Pipeline/Playbook) ===
  'POST /api/artists/{artistId}/songs': 'handler-auth',
  'PUT /api/artists/{artistId}/songs/{songId}': 'handler-auth',
  'DELETE /api/artists/{artistId}/songs/{songId}': 'handler-auth',
  'POST /api/artists/{artistId}/playbook': 'handler-auth',
  'PUT /api/artists/{artistId}/playbook/{artistSongId}': 'handler-auth',
  'DELETE /api/artists/{artistId}/playbook/{artistSongId}': 'handler-auth',
  'POST /api/artists/{artistId}/pipeline/suggestions': 'handler-auth',
  'DELETE /api/artists/{artistId}/pipeline/{artistSongId}': 'handler-auth',
  'POST /api/artists/{artistId}/pipeline/{artistSongId}/rag': 'handler-auth',
  'PUT /api/artists/{artistId}/pipeline/{artistSongId}/rag-status': 'handler-auth',
  'PUT /api/artists/{artistId}/pipeline/{artistSongId}/status': 'handler-auth',
  'PUT /api/artists/{artistId}/pipeline/{artistSongId}/comment': 'handler-auth',
  'POST /api/artists/{artistId}/pipeline/{artistSongId}/vote': 'handler-auth',
  'POST /api/artists/{artistId}/check-vote-reminders': 'handler-auth',

  // === Venue CRM ===
  'POST /api/venue-crm': 'handler-auth',
  'POST /api/artists/{artistId}/crm/venues': 'handler-auth',
  'PUT /api/artists/{artistId}/crm/venues/{venueId}': 'handler-auth',
  'DELETE /api/artists/{artistId}/crm/venues/{venueId}': 'handler-auth',
  'POST /api/artists/{artistId}/crm/venues/{venueId}/contacts': 'handler-auth',
  'PUT /api/artists/{artistId}/crm/venues/{venueId}/contacts/{contactId}': 'handler-auth',
  'DELETE /api/artists/{artistId}/crm/venues/{venueId}/contacts/{contactId}': 'handler-auth',
  'POST /api/artists/{artistId}/crm/venues/{venueId}/notes': 'handler-auth',
  'PUT /api/artists/{artistId}/crm/venues/{venueId}/notes/{noteId}': 'handler-auth',
  'DELETE /api/artists/{artistId}/crm/venues/{venueId}/notes/{noteId}': 'handler-auth',

  // === Events Agent (Ingest) ===
  'POST /api/ingest/bulk-import': 'handler-auth',
  'POST /api/ingest/extract-from-html': 'handler-auth',
  'POST /api/ingest/extract-from-url': 'handler-auth',
  'POST /api/ingest/extract-venues': 'handler-auth',
  'POST /api/ingest/queue/{id}/approve': 'handler-auth',
  'POST /api/ingest/queue/{id}/reject': 'handler-auth',
  'POST /api/ingest/enrich-venue-facebook': 'handler-auth',
  'POST /api/ingest/update-venue-placeid': 'handler-auth',
  'POST /api/ingest/load-poc': 'handler-auth',

  // === Expenses ===
  'POST /api/artists/{artistId}/expenses': 'handler-auth',
  'PUT /api/artists/{artistId}/expenses/{id}': 'handler-auth',
  'DELETE /api/artists/{artistId}/expenses/{id}': 'handler-auth',
  'POST /api/artists/{artistId}/income': 'handler-auth',
  'DELETE /api/artists/{artistId}/income/{id}': 'handler-auth',

  // === Builders ===
  'POST /api/builders': 'handler-auth',
  'PUT /api/builders/{id}': 'handler-auth',
  'DELETE /api/builders/{id}': 'handler-auth',
  'PUT /api/builders/{id}/publish': 'handler-auth',
  'POST /api/builders/{id}/venues': 'handler-auth',
  'PUT /api/builders/{id}/venues/{venueId}': 'handler-auth',
  'DELETE /api/builders/{id}/venues/{venueId}': 'handler-auth',

  // === Source Runs (MCP) ===
  'PUT /api/source-runs/{sourceId}/{runId}': 'mcp',
};

function loadPolicy() {
  return JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
}

function loadRoutes() {
  const templateText = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return parseSamRoutes(templateText);
}

function routeKey(method, routePath) {
  return `${method} ${routePath}`;
}

test('SEC-01: All mutation routes must be in the baseline', () => {
  const routes = loadRoutes();
  const policy = loadPolicy();

  // Combine baseline with explicit routes from policy
  const explicitKeys = new Set(
    policy.explicitRoutes.map(r => routeKey(r.method, r.path))
  );

  // Find mutation routes not in baseline
  const unclassified = routes
    .filter(r => MUTATION_METHODS.has(r.method))
    .filter(r => {
      const key = routeKey(r.method, r.path);
      return !MUTATION_ROUTE_BASELINE[key] && !explicitKeys.has(key);
    });

  if (unclassified.length > 0) {
    const details = unclassified
      .map(r => `  - ${r.method} ${r.path} (${r.resource}.${r.event})`)
      .join('\n');

    assert.fail(
      `SEC-01 VIOLATION: ${unclassified.length} NEW mutation route(s) not in security baseline.\n\n` +
      `Unclassified routes:\n${details}\n\n` +
      `To fix:\n` +
      `  1. Add to MUTATION_ROUTE_BASELINE in security/sec-01-route-policy.test.js\n` +
      `  2. Specify auth method: handler-auth, sam-auth, community, auth-flow, or mcp\n` +
      `  3. Ensure auth is actually implemented\n` +
      `  4. Get security review before merging`
    );
  }
});

test('SEC-01: Baseline routes must exist in template.yaml', () => {
  const routes = loadRoutes();
  const routeSet = new Set(routes.map(r => routeKey(r.method, r.path)));

  const orphaned = Object.keys(MUTATION_ROUTE_BASELINE)
    .filter(key => !routeSet.has(key));

  if (orphaned.length > 0) {
    assert.fail(
      `SEC-01 WARNING: ${orphaned.length} baseline route(s) not found in template.yaml.\n\n` +
      `Orphaned entries:\n${orphaned.map(r => `  - ${r}`).join('\n')}\n\n` +
      `These routes may have been removed. Update MUTATION_ROUTE_BASELINE if intentional.`
    );
  }
});

test('SEC-01: Mutation route count should not decrease unexpectedly', () => {
  const routes = loadRoutes();
  const mutationCount = routes.filter(r => MUTATION_METHODS.has(r.method)).length;
  const baselineCount = Object.keys(MUTATION_ROUTE_BASELINE).length;

  // Allow some variance but catch major removals
  const minExpected = Math.floor(baselineCount * 0.9);

  assert.ok(
    mutationCount >= minExpected,
    `SEC-01 WARNING: Mutation route count dropped significantly.\n` +
    `Expected at least ${minExpected}, found ${mutationCount}.\n` +
    `This may indicate routes were removed without updating the baseline.`
  );
});

test('SEC-01: Auth method values must be valid', () => {
  const validAuthMethods = new Set([
    'handler-auth',
    'sam-auth',
    'community',
    'auth-flow',
    'mcp'
  ]);

  const invalid = Object.entries(MUTATION_ROUTE_BASELINE)
    .filter(([, authMethod]) => !validAuthMethods.has(authMethod));

  if (invalid.length > 0) {
    assert.fail(
      `SEC-01 ERROR: Invalid auth methods in baseline.\n\n` +
      `Invalid entries:\n${invalid.map(([route, method]) => `  - ${route}: "${method}"`).join('\n')}\n\n` +
      `Valid methods: ${[...validAuthMethods].join(', ')}`
    );
  }
});

test('SEC-01: Policy status must be sec-01-enforced', () => {
  const policy = loadPolicy();

  assert.equal(
    policy.status,
    'sec-01-enforced',
    `Policy status must be 'sec-01-enforced'. Current: '${policy.status}'`
  );
});
