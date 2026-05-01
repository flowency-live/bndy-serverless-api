# Production Incident Post-Mortem: 2026-05-01

## Incident Summary

**Duration:** April 30 evening through May 1
**Severity:** Critical - Complete authentication failure, data loss
**Impact:** All users unable to log in, band memberships lost, multiple API routes missing

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

---

## Action Items

### Immediate (Today)
- [x] Fix auth routes
- [x] Fix Cognito env vars
- [ ] Add all 9 missing Lambda functions to SAM template
- [ ] Add all missing routes
- [ ] Verify all 140 routes exist

### Short-term (This Week)
- [ ] Enable deletion protection on ALL DynamoDB tables
- [ ] Enable PITR on ALL DynamoDB tables
- [ ] Create pre-deployment validation script
- [ ] Add route count smoke test to CI/CD

### Long-term
- [ ] Document all required environment variables
- [ ] Create infrastructure inventory document
- [ ] Add CloudWatch alarms for critical failures
- [ ] Consider implementing canary deployments

---

## Resources Affected

| Resource | Status | Data Loss |
|----------|--------|-----------|
| bndy-artist-memberships table | Recreated | Yes - partial |
| Auth routes | Fixed | No |
| Auth env vars | Fixed | No |
| Issues routes | Missing | N/A |
| Uploads routes | Missing | N/A |
| Users routes | Missing | N/A |
| Event coordinates | Fixed | No |

---

## Commits Related to Fixes

1. `feat: cascade venue location changes to events`
2. `fix: add missing auth routes for OAuth and phone login`
3. `fix: add missing Cognito env vars to auth lambda`
