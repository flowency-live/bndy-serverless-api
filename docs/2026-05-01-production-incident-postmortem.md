# Production Incident Post-Mortem: 2026-05-01

## Incident Summary

**Duration:** April 30 evening through May 1 (~18:30)
**Severity:** Critical - Complete authentication failure, data loss, deployment failures
**Impact:** All users unable to log in, band memberships lost, multiple API routes missing, repeated deployment failures

---

## Timeline of Issues

### Issue 1: Memberships Table Deleted
**Discovered:** May 1, ~10:00 AM
**Root Cause:** CloudFormation stack update deleted `bndy-artist-memberships` DynamoDB table
**Evidence:** CloudTrail shows `DeleteTable` invoked by `cloudformation.amazonaws.com` at 2026-04-30 19:41 PM

**What happened:**
- SAM deployment triggered CloudFormation update
- CloudFormation determined the table was "orphaned" (not in SAM template but existed)
- Table was deleted, losing all band membership data
- PITR was not enabled, so no recovery possible

**Fix applied:**
- Recreated table with correct schema
- Enabled deletion protection
- Enabled Point-in-Time Recovery (PITR)
- Recovered 5 owner memberships from `owner_user_id` field in artists table
- Manually recreated 8 band member relationships for Killin Scarlet and The Torrists

**Data lost:**
- 319 artists have no recoverable owner information
- Any non-owner memberships for other bands

---

### Issue 2: Missing API Routes (Auth)
**Discovered:** May 1, ~11:00 AM
**Root Cause:** SAM template was never synchronized with CDK routes

**Missing routes:**
- `GET /auth/google` (OAuth initiate)
- `GET /auth/apple` (OAuth initiate)
- `GET /auth/callback`
- `POST /auth/phone/request-otp`
- `POST /auth/phone/verify-otp`
- `POST /auth/phone/verify-and-onboard`
- `POST /auth/email/request-magic`
- `POST /auth/check-identity`

**Fix applied:**
- Added all 8 missing auth routes to `template.yaml`
- Deployed via GitHub Actions

---

### Issue 3: Missing Cognito Environment Variables
**Discovered:** May 1, ~11:30 AM
**Root Cause:** SAM template AuthFunction missing Cognito configuration

**Missing env vars:**
- `COGNITO_USER_POOL_CLIENT_ID`
- `COGNITO_USER_POOL_CLIENT_SECRET`

**Symptom:** OAuth redirect to Cognito with `client_id=undefined`

**Fix applied:**
- Added Cognito env vars to AuthFunction in template.yaml
- Values: User Pool `eu-west-2_LqtkKHs1P`, Client `tb6qcc6a4suk2pv58rd40klh7`

---

### Issue 4: Missing Lambda Functions in SAM Template
**Discovered:** May 1, ~11:30 AM
**Root Cause:** SAM template only contains 7 of 16 Lambda functions

**Functions in AWS but NOT in SAM template:**
1. IssuesFunction
2. UploadsFunction
3. EventsAgentFunction
4. InvitesFunction
5. NotificationsFunction
6. SetlistsFunction
7. SpotifyFunction
8. VenueCRMFunction
9. ArtistSongsFunction

**Missing routes (partial list):**
- `GET /api/issues`, `POST /api/issues`, etc.
- `POST /uploads/presigned-url`
- `GET /users`, `GET /users/profile`, `PUT /users/profile`
- All ingest routes

**Status:** PENDING FIX - Functions exist but routes not connected

---

### Issue 5: Event Location Showing Wrong Coordinates
**Discovered:** May 1, ~09:00 AM
**Root Cause:** Events store their own lat/lng at creation time, not derived from venue

**What happened:**
- Events were created with wrong venue (London)
- Venue was corrected to Northwich
- Event coordinates were NOT updated (stale data)

**Fix applied:**
- Created `fix-event-location.js` script to update event coordinates
- Added cascade update logic to `venues-lambda/handler.js`
- Future venue location changes will automatically update all events

---

### Issue 6: Lambda Code Size Exceeded (AuthFunction)
**Discovered:** May 1, ~16:00 PM
**Root Cause:** Backup files accidentally included in SAM deployment package

**What happened:**
- `auth-lambda/` folder contained 106MB of backup files:
  - `backup-extracted/` folder with full node_modules
  - Various `*.backup`, `*.broken-*` files
  - `handler-FAILED.js` file
- SAM build included these files, exceeding 262MB Lambda limit (311MB actual)
- Deployment failed with: `Unzipped size must be smaller than 262144000 bytes`

**Fix applied:**
- Moved all backup files to `_archived_backups/auth-lambda/`
- Created `.samignore` to exclude backup patterns from builds
- Updated `.gitignore` to prevent backup files from being committed

---

### Issue 7: Lambda Code Size Exceeded (ArtistsFunction)
**Discovered:** May 1, ~16:30 PM
**Root Cause:** Old deployment zip files left in lambda folders

**What happened:**
- `artists-lambda/` contained deployment zips from manual deployments:
  - `artists-lambda-deploy.zip` (21MB)
  - `function.zip` (41MB)
- Similar zips existed in `venues-lambda/` and `events-lambda/`
- SAM build included these, exceeding limits

**Fix applied:**
- Deleted all `*.zip` files from lambda folders
- Added `*.zip` and `*.tar.gz` to `.gitignore`

---

### Issue 8: Lambda Policy Size Exceeded
**Discovered:** May 1, ~17:00 PM
**Root Cause:** Too many routes on single Lambda function

**What happened:**
- EventsFunction had 28 routes attached
- Each route creates a Lambda permission in CloudFormation
- Total policy size: 20,605 bytes (limit: 20,480 bytes)
- Deployment failed with: `The final policy size is bigger than the limit`

**Fix applied:**
- Split 6 calendar routes to new `CalendarFunction`
- CalendarFunction uses same `events-lambda/` code but handles calendar-specific routes
- Manually deleted orphaned Lambda permissions from previous failed deployments

---

### Issue 9: Missing Dependencies (NotificationsFunction)
**Discovered:** May 1, ~17:30 PM
**Root Cause:** Lambda relied on layer for aws-sdk but SAM build doesn't resolve layer dependencies

**What happened:**
- `notifications-lambda/package.json` had NO runtime dependencies
- Code required `aws-sdk`, `jsonwebtoken`, `uuid`
- Assumed bndy-jwt layer would provide these
- SAM build creates isolated packages - layer deps not resolved at build time
- Lambda crashed with: `Cannot find module 'aws-sdk'`

**Fix applied:**
- Added explicit dependencies to `notifications-lambda/package.json`:
  ```json
  "dependencies": {
    "aws-sdk": "^2.1692.0",
    "jsonwebtoken": "^9.0.2",
    "uuid": "^9.0.0"
  }
  ```

**Lesson:** Never rely on Lambda layers for dependencies that code requires at runtime. Always declare dependencies explicitly in package.json.

---

### Issue 10: Routes on Wrong Lambda Functions
**Discovered:** May 1, ~18:00 PM
**Root Cause:** Routes defined in template.yaml but pointing to Lambda with no handler

**What happened:**
- `/api/artists/{artistId}/members` route was on ArtistsFunction
- `/api/artists/{artistId}/crm/venues` route was on ArtistsFunction
- But handlers were in `memberships-lambda/` and `venue-crm-lambda/`
- Resulted in 404 errors

**Fix applied:**
- Moved `/api/artists/{artistId}/members` routes to MembershipsFunction
- Moved `/api/artists/{artistId}/crm/venues/*` routes to VenueCRMFunction
- Added 15 CRM routes (venues, contacts, gigs, notes CRUD)

---

## Root Cause Analysis

### The Core Problem: Incomplete IaC Migration

The BNDY API was originally deployed using **CDK (Cloud Development Kit)**. At some point, a migration to **SAM (Serverless Application Model)** was started but **never completed**.

**State before incident:**
- SAM template contained only 7 of 16 Lambda functions
- SAM template was missing critical routes and environment variables
- CDK stack still owned some resources
- Some resources were orphaned (owned by neither)

**What triggered the incident:**
- April 29: CDK stack was deleted (documented in deployment.md as "BndyApiStack was deleted")
- Resources managed by CDK were deleted or orphaned
- SAM deployments continued, unaware of missing configuration
- Memberships table was in a state where CloudFormation thought it should delete it

### Why Claude Caused This

Every change to the infrastructure was initiated by Claude Code:
1. Claude made changes to template.yaml without fully auditing existing AWS state
2. Claude did not verify all Lambda functions were in the SAM template
3. Claude did not verify all routes existed before/after deployments
4. Claude deleted the CDK stack without ensuring SAM had all resources
5. Claude did not run validation scripts before deploying
6. Claude did not check Lambda package sizes before deploying
7. Claude did not verify route-to-handler mappings
8. Claude assumed layer dependencies would work without explicit package.json entries

---

## Lessons Learned

### 1. Never Delete IaC Without Full Migration
- Before deleting CDK, SAM should have had 100% coverage of all resources
- A resource inventory should have been created and verified

### 2. Enable Deletion Protection on Critical Resources
- All DynamoDB tables should have `DeletionProtectionEnabled: true`
- This was added to memberships table AFTER it was deleted and recreated

### 3. Enable Point-in-Time Recovery
- PITR should be enabled on all DynamoDB tables
- Without it, deleted data cannot be recovered

### 4. Audit Before Deploy
- Before any infrastructure change, run a diff of:
  - Current AWS state vs. IaC template
  - Current routes vs. handler expectations
  - Environment variables required vs. configured

### 5. Route Count Monitoring
- docs/deployment.md stated "140 routes"
- Actual routes dropped to 57, then 65
- Should have an automated check for route count

### 6. Never Trust Filesystem Cleanliness
- Lambda folders accumulate garbage: backup files, zips, old node_modules
- Always use `.samignore` to exclude non-essential files
- Run size checks before every deployment

### 7. Never Rely on Lambda Layers for Core Dependencies
- SAM builds each Lambda independently
- Layer contents are NOT available at build time
- Always declare dependencies explicitly in package.json
- Layers should only supplement, never replace, package.json deps

### 8. Validate Route-to-Handler Mappings
- Routes in template.yaml MUST have corresponding handlers in Lambda code
- Create automated checks that verify:
  - Every route path has a matching handler
  - Routes point to the correct Lambda function

### 9. Limit Routes Per Lambda
- AWS Lambda policy limit: 20KB
- Each route creates ~750 bytes of policy
- Practical limit: ~25 routes per Lambda
- Split large Lambdas into focused functions (e.g., CalendarFunction)

### 10. No Deploy Without Validation
- Every deployment MUST be preceded by:
  - `sam validate`
  - Size check (each Lambda < 250MB)
  - Route count check (< 25 per Lambda)
  - Dependency verification
  - Route-to-handler mapping check

---

## Action Items

### Completed (May 1)
- [x] Fix auth routes
- [x] Fix Cognito env vars
- [x] Add all 9 missing Lambda functions to SAM template
- [x] Add all missing routes
- [x] Clean up backup files from lambda folders
- [x] Create `.samignore` file
- [x] Fix Lambda policy size limit (split CalendarFunction)
- [x] Add missing dependencies to notifications-lambda
- [x] Fix route-to-handler mappings (members, crm/venues)

### Short-term (This Week)
- [ ] Enable deletion protection on ALL DynamoDB tables
- [ ] Enable PITR on ALL DynamoDB tables
- [x] Create pre-deployment validation script (`scripts/validate-deployment.js`)
- [x] Add route verification to CI/CD (`scripts/verify-routes.js`)
- [ ] Add pre-commit hooks for deployment validation

### Long-term
- [ ] Document all required environment variables
- [ ] Create infrastructure inventory document
- [ ] Add CloudWatch alarms for critical failures
- [ ] Consider implementing canary deployments
- [ ] Upgrade all Lambdas to nodejs24.x

---

## Resources Affected

| Resource | Status | Data Loss |
|----------|--------|-----------|
| bndy-artist-memberships table | Recreated | Yes - partial |
| Auth routes | Fixed | No |
| Auth env vars | Fixed | No |
| Issues routes | Fixed | No |
| Uploads routes | Fixed | No |
| Users routes | Fixed | No |
| Event coordinates | Fixed | No |
| Notifications endpoint | Fixed | No |
| Calendar endpoint | Fixed | No |
| CRM venues endpoint | Fixed | No |
| Artist members endpoint | Fixed | No |

---

## Commits Related to Fixes

1. `feat: cascade venue location changes to events`
2. `fix: add missing auth routes for OAuth and phone login`
3. `fix: add missing Cognito env vars to auth lambda`
4. `fix: clean up backup files and create .samignore`
5. `fix: split CalendarFunction to resolve policy size limit`
6. `fix: add missing dependencies to notifications-lambda`
7. `fix: move routes to correct Lambda functions`

---

## Guardrails Implemented

### 1. Pre-Deployment Validation Script
**File:** `scripts/validate-deployment.js`
- Checks Lambda folder sizes (must be < 250MB)
- Verifies all dependencies in package.json
- Validates route count per Lambda (< 25)
- Verifies route-to-handler mappings

### 2. Route Verification Script
**File:** `scripts/verify-routes.js`
- Extracts all routes from template.yaml
- Verifies handlers exist for each route
- Checks for orphaned routes

### 3. .samignore File
**File:** `.samignore`
- Excludes backup files, zips, test files
- Prevents accidental inclusion of large files

### 4. CI/CD Pipeline Updates
**File:** `.github/workflows/deploy.yml`
- Runs validation script before deployment
- Runs route verification
- Fails fast on validation errors
