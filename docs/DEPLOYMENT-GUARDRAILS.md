# BNDY Serverless API - Deployment Guardrails

> **Created:** 2026-05-01 after critical production incident
>
> **Purpose:** Prevent the deployment failures that caused 6-8 hours of production downtime

---

## TL;DR - Before Every Deployment

```bash
# Run this BEFORE every deployment
npm run validate

# If validation passes, deploy
npm run deploy
```

---

## The Rules (Non-Negotiable)

### 1. Never Deploy Without Validation

Every deployment MUST be preceded by running `scripts/validate-deployment.js`:

```bash
node scripts/validate-deployment.js
```

This checks:
- Lambda folder sizes (< 250MB each)
- No backup files or zips in folders
- All dependencies in package.json
- Route count per Lambda (< 25)

### 2. Lambda Size Limits

| Limit | Value | What Happens If Exceeded |
|-------|-------|-------------------------|
| Unzipped Lambda | 262 MB | Deployment fails |
| Lambda policy | 20 KB | Deployment fails |
| Practical Lambda size | 250 MB | Buffer for safety |
| Routes per Lambda | ~25 | Policy size exceeded |

**If your Lambda is too big:**
1. Check for backup files: `ls -la *-lambda/`
2. Check for zip files: `find . -name "*.zip"`
3. Check node_modules: `du -sh *-lambda/node_modules`
4. Move junk to `_archived_backups/`

### 3. Dependencies MUST Be Explicit

**WRONG:** Relying on Lambda layer for dependencies
```json
{
  "devDependencies": { "jest": "^29.0.0" }
}
// Handler uses aws-sdk, jsonwebtoken, uuid - NOT IN PACKAGE.JSON
// Layer provides them... but SAM build doesn't know that!
```

**RIGHT:** All runtime dependencies in package.json
```json
{
  "dependencies": {
    "aws-sdk": "^2.1692.0",
    "jsonwebtoken": "^9.0.2",
    "uuid": "^9.0.0"
  },
  "devDependencies": { "jest": "^29.0.0" }
}
```

**Why:** SAM builds each Lambda independently. It doesn't know what's in the layer.

### 4. Routes Must Match Handlers

Every route in `template.yaml` must have a handler in the Lambda code:

| Template Route | Handler Location |
|----------------|------------------|
| `/api/artists/{id}/members` | `memberships-lambda/handler.js` |
| `/api/artists/{id}/crm/venues` | `venue-crm-lambda/handler.js` |
| `/api/events/*` | `events-lambda/handler.js` |

**If you add a route:** Verify the handler exists!
**If you see 404s:** Check if route points to wrong Lambda.

### 5. Clean Lambda Folders

**Allowed in Lambda folders:**
- `handler.js` (or `index.js`)
- `package.json`
- `package-lock.json`
- Source `.js` files
- `node_modules/` (from npm install)

**FORBIDDEN in Lambda folders:**
- `*.backup`, `*.backup-*`
- `*.broken-*`, `*-FAILED.js`
- `*.zip`, `*.tar.gz`
- `backup-*/`, `backups/`, `*-extracted/`
- Old deployment artifacts

### 6. Route Limits Per Lambda

AWS Lambda policy limit = 20KB.
Each route ≈ 750 bytes of policy.
Max routes ≈ 25 per Lambda function.

**If you hit the limit:**
1. Split routes into a new Lambda function
2. Example: CalendarFunction split from EventsFunction

---

## .samignore File

This file excludes junk from SAM builds:

```
# MUST be in .samignore
node_modules/
**/node_modules/
*.backup*
*.broken-*
backup-*/
backups/
*.zip
*.tar.gz
*.log
__tests__/
```

**Never delete .samignore!**

---

## CI/CD Pipeline Checks

The GitHub Actions workflow (`deploy.yml`) includes:

1. **Validation step** - Runs `validate-deployment.js`
2. **Route verification** - Runs `verify-routes.js`
3. **SAM validate** - CloudFormation template check

If ANY check fails, deployment is blocked.

---

## Quick Fixes for Common Issues

### "Unzipped size must be smaller than 262144000 bytes"

```bash
# Find large files
du -sh *-lambda/

# Check for backup files
ls -la auth-lambda/backup*

# Move backups out
mkdir -p _archived_backups/auth-lambda
mv auth-lambda/backup* _archived_backups/auth-lambda/
```

### "The final policy size is bigger than the limit"

```bash
# Count routes per Lambda
grep -A 20 "EventsFunction:" template.yaml | grep "Path:" | wc -l

# If > 25, split into new Lambda function
```

### "Cannot find module 'aws-sdk'"

```bash
# Check package.json
cat notifications-lambda/package.json

# Add missing dependency
cd notifications-lambda
npm install aws-sdk --save
```

### "404 Not Found on existing route"

```bash
# Check which Lambda handles the route
grep "/api/artists/{artistId}/members" template.yaml

# Verify handler exists in that Lambda
grep "members" memberships-lambda/handler.js
```

---

## Emergency Recovery

If deployment breaks production:

1. **Don't panic**
2. **Check CloudWatch Logs** for error messages
3. **Roll back** using AWS Console or:
   ```bash
   aws lambda update-function-code \
     --function-name FUNCTION_NAME \
     --s3-bucket PREVIOUS_BUCKET \
     --s3-key PREVIOUS_KEY
   ```
4. **Document** what went wrong in post-mortem

---

## Checklist Before Merging to Main

- [ ] Ran `node scripts/validate-deployment.js`
- [ ] Ran `node scripts/verify-routes.js`
- [ ] No backup files in Lambda folders
- [ ] All dependencies in package.json
- [ ] Routes point to correct Lambda functions
- [ ] Route count < 25 per Lambda
- [ ] Tested locally with `sam local invoke`

---

## References

- Post-mortem: `docs/2026-05-01-production-incident-postmortem.md`
- Validation script: `scripts/validate-deployment.js`
- Route verification: `scripts/verify-routes.js`
- CI/CD workflow: `.github/workflows/deploy.yml`
