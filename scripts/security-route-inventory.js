'use strict';

const fs = require('fs');
const path = require('path');

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function leadingSpaces(line) {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function parseSamRoutes(templateText) {
  const lines = templateText.split(/\r?\n/);
  const routes = [];
  let resource = null;
  let inEvents = false;
  let event = null;
  let eventIndent = null;

  function flushEvent() {
    if (event && event.type === 'HttpApi' && event.path && event.method) {
      routes.push({
        resource,
        event: event.name,
        method: event.method.toUpperCase(),
        path: event.path,
        authorizer: event.authorizer || null,
        authDeclared: Boolean(event.authorizer),
        line: event.line
      });
    }
    event = null;
    eventIndent = null;
  }

  lines.forEach((line, index) => {
    const indent = leadingSpaces(line);
    const trimmed = line.trim();

    const resourceMatch = line.match(/^  ([A-Za-z0-9]+):\s*$/);
    if (resourceMatch) {
      flushEvent();
      resource = resourceMatch[1];
      inEvents = false;
      return;
    }

    if (resource && line.match(/^      Events:\s*$/)) {
      flushEvent();
      inEvents = true;
      return;
    }

    if (!inEvents) return;

    if (indent <= 4 && trimmed) {
      flushEvent();
      inEvents = false;
      return;
    }

    const eventMatch = line.match(/^        ([A-Za-z0-9]+):\s*$/);
    if (eventMatch) {
      flushEvent();
      event = {
        name: eventMatch[1],
        type: null,
        path: null,
        method: null,
        authorizer: null,
        line: index + 1
      };
      eventIndent = indent;
      return;
    }

    if (!event) return;

    if (indent <= eventIndent && trimmed) {
      flushEvent();
      return;
    }

    const typeMatch = trimmed.match(/^Type:\s*(\S+)$/);
    if (typeMatch) event.type = typeMatch[1];

    const pathMatch = trimmed.match(/^Path:\s*(.+)$/);
    if (pathMatch) event.path = pathMatch[1].trim().replace(/^['"]|['"]$/g, '');

    const methodMatch = trimmed.match(/^Method:\s*(\S+)$/);
    if (methodMatch) event.method = methodMatch[1].replace(/^['"]|['"]$/g, '');

    const authorizerMatch = trimmed.match(/^(?:Authorizer|DefaultAuthorizer):\s*(\S+)$/);
    if (authorizerMatch) event.authorizer = authorizerMatch[1].replace(/^['"]|['"]$/g, '');
  });

  flushEvent();
  return routes;
}

function duplicateRoutes(routes) {
  const byKey = new Map();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(route);
  }

  return [...byKey.entries()]
    .filter(([, declarations]) => declarations.length > 1)
    .map(([route, declarations]) => ({ route, declarations }));
}

function classifyBaseline(route) {
  if (route.path.startsWith('/api/ai/')) return 'ai-integration';
  if (route.path.includes('/mcp')) return 'deprecated';
  if (MUTATION_METHODS.has(route.method)) return 'admin';
  if (route.method === 'GET' || route.method === 'OPTIONS') return 'public-read-review-required';
  return 'unclassified';
}

function buildInventory(routes) {
  const enriched = routes
    .map(route => ({
      ...route,
      baselineZone: classifyBaseline(route),
      currentRisk: MUTATION_METHODS.has(route.method) && !route.authDeclared
        ? 'unauthenticated-mutation-declared-in-sam'
        : null
    }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  const mutations = enriched.filter(route => MUTATION_METHODS.has(route.method));
  const unauthenticatedMutations = mutations.filter(route => !route.authDeclared);
  const httpMcpRoutes = enriched.filter(route => route.path.includes('/mcp'));
  const duplicates = duplicateRoutes(enriched);

  return {
    generatedAt: new Date().toISOString(),
    source: 'template.yaml',
    status: 'baseline-unenforced',
    summary: {
      totalRoutes: enriched.length,
      mutationRoutes: mutations.length,
      unauthenticatedMutationRoutes: unauthenticatedMutations.length,
      httpMcpRoutes: httpMcpRoutes.length,
      duplicateRouteKeys: duplicates.length
    },
    routes: enriched,
    duplicates
  };
}

function toMarkdown(inventory) {
  const lines = [
    '# BNDY SAM Route Inventory',
    '',
    `Generated: ${inventory.generatedAt}`,
    '',
    '> Baseline only. This report does not change production behaviour. A missing event-level authorizer is reported from the SAM declaration; handler-level checks require separate review.',
    '',
    '## Summary',
    '',
    `- Total routes: ${inventory.summary.totalRoutes}`,
    `- Mutation routes: ${inventory.summary.mutationRoutes}`,
    `- Mutation routes without a declared event authorizer: ${inventory.summary.unauthenticatedMutationRoutes}`,
    `- HTTP routes containing /mcp: ${inventory.summary.httpMcpRoutes}`,
    `- Duplicate method/path declarations: ${inventory.summary.duplicateRouteKeys}`,
    '',
    '## Routes',
    '',
    '| Method | Path | Resource | Event | Declared authorizer | Baseline zone | Risk |',
    '|---|---|---|---|---|---|---|'
  ];

  for (const route of inventory.routes) {
    lines.push(`| ${route.method} | \`${route.path}\` | ${route.resource} | ${route.event} | ${route.authorizer || 'None'} | ${route.baselineZone} | ${route.currentRisk || ''} |`);
  }

  lines.push('', '## Duplicate declarations', '');
  if (inventory.duplicates.length === 0) {
    lines.push('None detected.');
  } else {
    for (const duplicate of inventory.duplicates) {
      lines.push(`- **${duplicate.route}**: ${duplicate.declarations.map(item => `${item.resource}.${item.event}`).join(', ')}`);
    }
  }

  lines.push('', '## Interpretation', '');
  lines.push('- `public-read-review-required` does not mean the route has been approved for anonymous public use. SEC-01 will replace this broad baseline with an explicit allowlist.');
  lines.push('- `admin` is the target trust zone for existing mutations, not evidence that the route is currently protected.');
  lines.push('- `deprecated` identifies legacy HTTP MCP routes. The local stdio MCP repository remains out of scope.');
  lines.push('- Handler-level authentication and authorisation are not inferred by this script and must be inspected separately.');

  return `${lines.join('\n')}\n`;
}

function writeInventory(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const templatePath = options.templatePath || path.join(root, 'template.yaml');
  const outputDir = options.outputDir || path.join(root, 'docs', 'security', 'generated');
  const templateText = fs.readFileSync(templatePath, 'utf8');
  const inventory = buildInventory(parseSamRoutes(templateText));

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'route-inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'route-inventory.md'), toMarkdown(inventory));

  return inventory;
}

if (require.main === module) {
  try {
    const inventory = writeInventory();
    process.stdout.write(`${JSON.stringify(inventory.summary, null, 2)}\n`);
    if (inventory.summary.unauthenticatedMutationRoutes > 0) {
      process.stdout.write('WARNING: baseline contains mutation routes without declared event authorizers.\n');
    }
  } catch (error) {
    console.error(`Failed to generate route inventory: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  MUTATION_METHODS,
  parseSamRoutes,
  duplicateRoutes,
  classifyBaseline,
  buildInventory,
  toMarkdown,
  writeInventory
};
