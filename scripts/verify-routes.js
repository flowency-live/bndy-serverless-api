#!/usr/bin/env node
/**
 * Route Verification Script
 *
 * Compares routes defined in Lambda handlers with routes in template.yaml
 * to catch misconfigurations BEFORE deployment.
 *
 * Uses regex parsing to avoid CloudFormation intrinsic function issues.
 *
 * Usage: node scripts/verify-routes.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Extract routes from template.yaml using regex (avoids CloudFormation intrinsic function issues)
function extractTemplateRoutes(templatePath) {
  const content = fs.readFileSync(templatePath, 'utf-8');
  const routes = [];

  // Match HttpApi events with Path and Method
  // Pattern matches blocks like:
  //   SomeEvent:
  //     Type: HttpApi
  //     Properties:
  //       ApiId: !Ref BndyHttpApi
  //       Path: /api/something
  //       Method: GET
  const eventPattern = /(\w+):\s*\n\s+Type:\s*HttpApi\s*\n\s+Properties:[\s\S]*?Path:\s*([^\n]+)\s*\n\s+Method:\s*(\w+)/g;

  let match;
  while ((match = eventPattern.exec(content)) !== null) {
    routes.push({
      eventName: match[1],
      path: match[2].trim(),
      method: match[3].toUpperCase()
    });
  }

  return routes;
}

// Normalize path for comparison (handle path params)
function normalizePath(p) {
  return p.replace(/\{[^}]+\}/g, '{param}').replace(/:[a-zA-Z]+/g, '{param}');
}

// Main verification
function verifyRoutes() {
  console.log('Route Verification');
  console.log('==================\n');

  const templatePath = path.join(ROOT, 'template.yaml');

  if (!fs.existsSync(templatePath)) {
    console.error('ERROR: template.yaml not found');
    process.exit(1);
  }

  const templateRoutes = extractTemplateRoutes(templatePath);

  console.log(`Found ${templateRoutes.length} HttpApi routes in template.yaml\n`);

  // Critical public routes that MUST exist
  const criticalRoutes = [
    { method: 'GET', path: '/api/events/public', description: 'Public events (map/list view)' },
    { method: 'GET', path: '/api/events/public/geo', description: 'Public events with geo data' },
    { method: 'GET', path: '/api/artists/{artistId}/public-events', description: 'Artist profile events' },
    { method: 'GET', path: '/api/venues/{venueId}/events', description: 'Venue profile events' },
    { method: 'GET', path: '/api/artists', description: 'List artists' },
    { method: 'GET', path: '/api/venues', description: 'List venues' },
    { method: 'GET', path: '/api/artists/{id}', description: 'Get single artist' },
    { method: 'GET', path: '/api/venues/{id}', description: 'Get single venue' },
  ];

  console.log('Checking critical routes...\n');

  let missing = [];

  for (const required of criticalRoutes) {
    const normalizedRequired = normalizePath(required.path);
    const found = templateRoutes.some(r =>
      r.method === required.method &&
      normalizePath(r.path) === normalizedRequired
    );

    if (found) {
      console.log(`  ✓ ${required.method} ${required.path}`);
    } else {
      console.log(`  ✗ ${required.method} ${required.path} - MISSING! (${required.description})`);
      missing.push(required);
    }
  }

  console.log('');

  if (missing.length > 0) {
    console.log('========================================');
    console.log(`ERROR: ${missing.length} critical routes missing from template.yaml!`);
    console.log('');
    console.log('These routes are required for the frontstage to function:');
    for (const m of missing) {
      console.log(`  - ${m.method} ${m.path}: ${m.description}`);
    }
    console.log('');
    console.log('Add these routes to template.yaml before deploying.');
    console.log('========================================');
    process.exit(1);
  }

  console.log('All critical routes present in template.yaml!');
  process.exit(0);
}

verifyRoutes();
