# Lambda Local Code Cleanup Plan

**Created:** 2025-11-04
**Status:** Planning Phase
**Problem:** Local bndy-serverless-api directory is a mess of zip files, backup directories, and unclear code state

---

## Current State Analysis

### Directory Count: 25 subdirectories
### Zip Files: 17 zip files (totaling ~235MB)
### Loose JS Files: 8 migration/test scripts

---

## The Problem

**TRUTH:** The only reliable Lambda code is what's deployed in production.

**MESS:** Local directory has:
- Multiple versions of the same Lambda as zip files
- Backup directories with unclear timestamps
- Deployed vs current vs rollback versions
- Migration scripts that may or may not have run
- No clear "source of truth"

---

## Current Files Inventory

### Lambda Directories (Source Code)
1. ✅ `auth-lambda/` - Auth & sessions
2. ✅ `artist-songs-lambda/` - Artist songs management
3. ✅ `artists-lambda/` - Artist profiles
4. ✅ `events-lambda/` - Band events (gigs, rehearsals)
5. ✅ `invites-lambda/` - Member invitations
6. ✅ `issues-lambda/` - Bug reports
7. ✅ `memberships-lambda/` - Artist memberships
8. ✅ `setlists-lambda/` - Setlist management
9. ✅ `songs-lambda/` - Song library
10. ✅ `uploads-lambda/` - S3 file uploads
11. ✅ `users-lambda/` - User profiles
12. ✅ `venues-lambda/` - Venue management
13. ✅ `events-agent-lambda/` - AI event extraction
14. ✅ `venue-enrichment-lambda/` - AI venue enrichment
15. ✅ `spotify-lambda/` - Spotify integration

### Backup/Temp Directories (BLOAT)
- `auth-lambda-backup-20251028-221233/` - OLD
- `auth-lambda-backups/` - Multiple backups
- `auth-lambda-deployed/` - Deployed snapshot
- `auth-lambda-deployed-temp/` - Temp extraction
- `invites-lambda-current-check/` - Temp verification
- `invites-lambda-deployed/` - Deployed snapshot
- `_production_baselines/` - Downloaded production code

### Zip Files (BLOAT)
1. `artists-lambda.zip` (14.3MB)
2. `artist-songs-lambda.zip` (14.4MB)
3. `auth-lambda.zip` (14.5MB)
4. `auth-lambda-deployed.zip` (14.5MB)
5. `auth-lambda-rollback.zip` (14.5MB)
6. `deployed-lambda-before-my-changes.zip` (6.9MB)
7. `events-agent.zip` (6.9MB)
8. `events-agent-lambda.zip` (6.9MB)
9. `invites-lambda-current.zip` (28.3MB)
10. `invites-lambda-deployed.zip` (28.3MB)
11. `memberships-lambda.zip` (14.4MB)
12. `node-modules-temp.zip` (14.4MB)
13. `setlists-lambda.zip` (14.3MB)
14. `songs-lambda.zip` (14.2MB)
15. `songs-lambda-image-support.zip` (14.2MB)
16. `songs-lambda-updated.zip` (14.2MB)
17. `spotify-lambda.zip` (2.2KB)

**Total Zip Bloat:** ~235MB

### Loose Scripts
1. `check-firestore-song.js` - Firestore migration check
2. `check-logs.js` - CloudWatch log checker
3. `cleanup-orphaned-artist-songs.js` - Orphan cleanup
4. `clear-queue.js` - SQS queue cleaner
5. `enrich-all-songs.js` - Batch song enrichment
6. `enrich-songs.js` - Song enrichment script
7. `list-firestore-collections.js` - Firestore lister
8. `migrate-songs-complete.js` - Migration script

### Other Directories
- `node_modules/` - Root dependencies (used by scripts)
- `poc/` - Proof of concept code
- `scripts/` - Utility scripts
- `.github/` - GitHub actions
- `.claude/` - Claude AI context

---

## The Solution: Production Baseline Strategy

### Principle
**The deployed Lambda code in AWS is the source of truth.**

### New Directory Structure
```
bndy-serverless-api/
├── _production_baselines/          # Downloaded from AWS (read-only)
│   ├── auth-lambda/
│   ├── artists-lambda/
│   ├── [all other lambdas]/
│   └── BASELINE_INFO.md            # When downloaded, from where
│
├── auth-lambda/                    # Working directory
├── artists-lambda/                 # Working directory
├── [all other lambdas]/            # Working directories
│
├── scripts/                        # Utility scripts
├── poc/                            # Proof of concept code
│
└── LAMBDA_CLEANUP_PLAN.md          # This file
```

**NO zip files in root** (except during active deployment)
**NO backup directories** (use git + production baselines)
**NO deployed/temp directories** (use _production_baselines)

---

## Cleanup Actions

### Phase 1: Download Production Baselines ✅
```bash
# Download all Lambda functions from production
# Store in _production_baselines/ with metadata
./scripts/download-production-baselines.sh
```

### Phase 2: Delete Bloat
```bash
# Delete all zip files
rm *.zip

# Delete backup directories
rm -rf auth-lambda-backup-*
rm -rf auth-lambda-backups
rm -rf auth-lambda-deployed
rm -rf auth-lambda-deployed-temp
rm -rf invites-lambda-current-check
rm -rf invites-lambda-deployed

# Keep _production_baselines/
```

### Phase 3: Verify Working Directories
```bash
# Ensure each Lambda directory has:
# - handler.js (or index.js)
# - package.json
# - node_modules/ (or can npm install)
```

### Phase 4: Document Baseline Info
Create `_production_baselines/BASELINE_INFO.md`:
```markdown
# Production Baselines

Downloaded: 2025-11-04
Region: eu-west-2
API Gateway: qry0k6pmd0

## Functions
- auth-lambda: bndy-serverless-api-AuthFunction-gKJksEC1lGjw
- artists-lambda: bndy-serverless-api-ArtistsFunction-4wCJA9JLMwF5
- [etc]

## How to Update Baselines
./scripts/download-production-baselines.sh
```

---

## New Workflow

### Making Changes to a Lambda

1. **Start from working directory:**
   ```bash
   cd artist-songs-lambda/
   # Make changes to handler.js
   ```

2. **Test locally:**
   ```bash
   node test-local.js
   ```

3. **Deploy to production:**
   ```bash
   cd ..
   ./deploy-lambda.sh artist-songs-lambda
   ```

4. **If deployment fails, rollback:**
   ```bash
   # Restore from production baseline
   cp -r _production_baselines/artist-songs-lambda/* artist-songs-lambda/
   ```

5. **After successful deployment, update baseline:**
   ```bash
   ./scripts/download-production-baselines.sh artist-songs-lambda
   ```

### No More Manual Zip Management
- Deployment script handles zipping
- No zip files left in root after deployment
- Baseline downloads are stored in dedicated directory

---

## Benefits

1. **Single Source of Truth:** `_production_baselines/` = what's in production
2. **Clean Root Directory:** No zip file clutter
3. **Easy Rollback:** Copy from baselines
4. **Clear State:** Working directories are for development
5. **Git-Friendly:** Baselines can be gitignored or committed separately
6. **Disaster Recovery:** Can rebuild everything from baselines

---

## Migration Scripts Status

These scripts were one-time operations and are now historical:
- ✅ `migrate-songs-complete.js` - Songs migrated to DynamoDB
- ✅ `check-firestore-song.js` - Verification complete
- ✅ `list-firestore-collections.js` - Used for initial assessment

**Action:** Keep in `/scripts/archive/` for reference

Ongoing utility scripts:
- ✅ `enrich-all-songs.js` - Still useful for batch song enrichment
- ✅ `cleanup-orphaned-artist-songs.js` - Maintenance script
- ✅ `check-logs.js` - Debugging utility
- ✅ `clear-queue.js` - Queue management

**Action:** Keep in `/scripts/` for active use

---

## Gitignore Updates

```gitignore
# Lambda zip files (created during deployment)
*.zip
!template-lambda.zip  # Keep template if needed

# Temporary directories
*-deployed/
*-deployed-temp/
*-backup-*/
*-current-check/

# Production baselines (optional - decide if we commit these)
_production_baselines/

# Node modules in Lambda directories
*/node_modules/
node_modules/

# Test files
lambda-test.json
test.json
```

---

## Rollout Plan

### Step 1: Preparation (NOW)
- [x] Create this cleanup plan
- [ ] Review with team
- [ ] Ensure git is clean (commit current work)

### Step 2: Backup (NEXT)
- [ ] Download all production baselines to `_production_baselines/`
- [ ] Verify each baseline matches deployed code
- [ ] Document baseline metadata

### Step 3: Clean (THEN)
- [ ] Delete all zip files in root
- [ ] Delete all backup/deployed/temp directories
- [ ] Move migration scripts to `/scripts/archive/`
- [ ] Update .gitignore

### Step 4: Verify (AFTER)
- [ ] Each Lambda directory has valid handler + package.json
- [ ] Can deploy any Lambda successfully
- [ ] Can rollback from baseline
- [ ] Documentation is clear

### Step 5: Commit (FINALLY)
- [ ] Commit clean state to git
- [ ] Update platform documentation
- [ ] Share new workflow with team

---

## Risk Mitigation

**What if we delete something important?**
- Git history preserves everything
- Production baselines downloaded first
- Can restore from AWS if needed

**What if deployment breaks?**
- Baseline provides instant rollback
- AWS Lambda versions preserve previous deployments
- Can restore from AWS console if needed

**What if we need old zip files?**
- They're in git history
- Newer deployment is always better
- Production baseline is the truth

---

## Success Criteria

✅ Root directory has <5 files
✅ No zip files except during active deployment
✅ All Lambda working directories are clean and functional
✅ `_production_baselines/` contains verified production code
✅ Team understands new workflow
✅ Documentation updated

---

## Next Steps

1. Review this plan
2. Run `download-production-baselines.sh` script
3. Execute cleanup
4. Test deployment workflow
5. Update team documentation
