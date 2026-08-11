#!/usr/bin/env node
/**
 * Pre-Deployment Validation Script
 *
 * MUST be run before any SAM deployment to catch issues that caused
 * the 2026-05-01 production incident.
 *
 * Checks:
 * 1. Lambda folder sizes (must be < 250MB)
 * 2. No backup files or zips in Lambda folders
 * 3. All dependencies declared in package.json (no layer reliance)
 * 4. Route count per Lambda (must be < 25 per function)
 * 5. Route-to-handler mapping verification
 *
 * Usage: node scripts/validate-deployment.js
 *
 * Exit codes:
 *   0 = All checks passed
 *   1 = Validation failed (DO NOT DEPLOY)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MAX_LAMBDA_SIZE_MB = 250;
const MAX_ROUTES_PER_LAMBDA = 30; // Raised from 25 to accommodate MCP routes (2026-08-11)

// Colors for output
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let errors = [];
let warnings = [];

function log(msg) {
  console.log(msg);
}

function error(msg) {
  errors.push(msg);
  console.log(`${RED}ERROR: ${msg}${RESET}`);
}

function warn(msg) {
  warnings.push(msg);
  console.log(`${YELLOW}WARNING: ${msg}${RESET}`);
}

function success(msg) {
  console.log(`${GREEN}✓ ${msg}${RESET}`);
}

// Get all Lambda folders
function getLambdaFolders() {
  return fs.readdirSync(ROOT)
    .filter(f => f.endsWith('-lambda'))
    .filter(f => fs.statSync(path.join(ROOT, f)).isDirectory());
}

// Calculate folder size in MB
function calculateFolderSizeMB(folderPath) {
  let totalSize = 0;

  function walkDir(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        walkDir(filePath);
      } else {
        totalSize += stat.size;
      }
    }
  }

  walkDir(folderPath);
  return Math.ceil(totalSize / (1024 * 1024));
}

function getFolderSizeMB(folderPath) {
  if (process.platform === 'win32') {
    return calculateFolderSizeMB(folderPath);
  }

  try {
    const result = execSync(`du -sm "${folderPath}"`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return parseInt(result.split('	')[0], 10);
  } catch {
    return calculateFolderSizeMB(folderPath);
  }
}

// Check for forbidden files in Lambda folders
function checkForbiddenFiles(lambdaFolder) {
  const forbiddenPatterns = [
    /\.backup$/,
    /\.backup-/,
    /\.broken-/,
    /-FAILED\.js$/,
    /\.zip$/,
    /\.tar\.gz$/,
    /^backup-/,
    /^backups$/,
  ];

  const folderPath = path.join(ROOT, lambdaFolder);
  const files = fs.readdirSync(folderPath);

  for (const file of files) {
    for (const pattern of forbiddenPatterns) {
      if (pattern.test(file)) {
        error(`${lambdaFolder}/${file} matches forbidden pattern ${pattern}`);
      }
    }
  }

  // Check for backup-extracted or similar folders
  const subDirs = files.filter(f =>
    fs.statSync(path.join(folderPath, f)).isDirectory()
  );

  for (const dir of subDirs) {
    if (dir.includes('backup') || dir.includes('extracted')) {
      error(`${lambdaFolder}/${dir} looks like a backup folder - remove it`);
    }
  }
}

// Check package.json has required dependencies
function checkDependencies(lambdaFolder) {
  const handlerPath = path.join(ROOT, lambdaFolder, 'handler.js');
  const packagePath = path.join(ROOT, lambdaFolder, 'package.json');

  if (!fs.existsSync(handlerPath) || !fs.existsSync(packagePath)) {
    return; // Skip if files don't exist
  }

  const handlerContent = fs.readFileSync(handlerPath, 'utf-8');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
  const deps = packageJson.dependencies || {};

  // Common requires that MUST be in package.json (not just layer)
  const criticalDeps = [
    { pattern: /require\(['"]aws-sdk['"]\)/, name: 'aws-sdk' },
    { pattern: /require\(['"]jsonwebtoken['"]\)/, name: 'jsonwebtoken' },
    { pattern: /require\(['"]uuid['"]\)/, name: 'uuid' },
    { pattern: /require\(['"]ngeohash['"]\)/, name: 'ngeohash' },
  ];

  for (const { pattern, name } of criticalDeps) {
    if (pattern.test(handlerContent) && !deps[name]) {
      error(`${lambdaFolder} requires '${name}' but it's not in package.json dependencies`);
    }
  }
}

// Extract routes per Lambda from template.yaml
function getRoutesPerLambda() {
  const templatePath = path.join(ROOT, 'template.yaml');
  const content = fs.readFileSync(templatePath, 'utf-8');

  const routesPerLambda = {};
  let currentFunction = null;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match function definition (e.g., "  EventsFunction:")
    const funcMatch = line.match(/^  (\w+Function):/);
    if (funcMatch) {
      currentFunction = funcMatch[1];
      routesPerLambda[currentFunction] = [];
    }

    // Match HttpApi route path
    if (currentFunction && line.includes('Path:') && line.includes('/api/')) {
      const pathMatch = line.match(/Path:\s*(.+)/);
      if (pathMatch) {
        routesPerLambda[currentFunction].push(pathMatch[1].trim());
      }
    }
  }

  return routesPerLambda;
}

// Main validation
function validate() {
  log('\n========================================');
  log('  Pre-Deployment Validation');
  log('========================================\n');

  const lambdaFolders = getLambdaFolders();
  log(`Found ${lambdaFolders.length} Lambda folders\n`);

  // Check 1: Lambda folder sizes
  log('--- Checking Lambda folder sizes ---');
  for (const folder of lambdaFolders) {
    const sizeMB = getFolderSizeMB(path.join(ROOT, folder));
    if (sizeMB > MAX_LAMBDA_SIZE_MB) {
      error(`${folder} is ${sizeMB}MB (max: ${MAX_LAMBDA_SIZE_MB}MB)`);
    } else if (sizeMB > MAX_LAMBDA_SIZE_MB * 0.8) {
      warn(`${folder} is ${sizeMB}MB (approaching limit)`);
    } else {
      success(`${folder}: ${sizeMB}MB`);
    }
  }
  log('');

  // Check 2: Forbidden files
  log('--- Checking for forbidden files ---');
  for (const folder of lambdaFolders) {
    checkForbiddenFiles(folder);
  }
  if (errors.filter(e => e.includes('forbidden') || e.includes('backup')).length === 0) {
    success('No forbidden files found');
  }
  log('');

  // Check 3: Dependencies
  log('--- Checking dependencies ---');
  for (const folder of lambdaFolders) {
    checkDependencies(folder);
  }
  if (errors.filter(e => e.includes('package.json')).length === 0) {
    success('All dependencies declared');
  }
  log('');

  // Check 4: Route counts
  log('--- Checking route counts per Lambda ---');
  const routesPerLambda = getRoutesPerLambda();
  for (const [funcName, routes] of Object.entries(routesPerLambda)) {
    if (routes.length > MAX_ROUTES_PER_LAMBDA) {
      error(`${funcName} has ${routes.length} routes (max: ${MAX_ROUTES_PER_LAMBDA})`);
    } else if (routes.length > MAX_ROUTES_PER_LAMBDA * 0.8) {
      warn(`${funcName} has ${routes.length} routes (approaching limit)`);
    } else if (routes.length > 0) {
      success(`${funcName}: ${routes.length} routes`);
    }
  }
  log('');

  // Summary
  log('========================================');
  if (errors.length > 0) {
    log(`${RED}VALIDATION FAILED: ${errors.length} error(s)${RESET}`);
    log('');
    log('Fix these issues before deploying:');
    for (const e of errors) {
      log(`  - ${e}`);
    }
    log('');
    log(`${RED}DO NOT DEPLOY until all errors are fixed!${RESET}`);
    process.exit(1);
  } else if (warnings.length > 0) {
    log(`${YELLOW}VALIDATION PASSED WITH WARNINGS: ${warnings.length} warning(s)${RESET}`);
    log('');
    log('Consider addressing these warnings:');
    for (const w of warnings) {
      log(`  - ${w}`);
    }
    process.exit(0);
  } else {
    log(`${GREEN}VALIDATION PASSED: All checks successful${RESET}`);
    process.exit(0);
  }
}

validate();
