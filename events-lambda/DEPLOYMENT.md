# Events Lambda Deployment Guide

## CRITICAL: Layer Architecture

This Lambda uses AWS Lambda Layers for shared dependencies:
- **bndy-jwt layer** (14MB): Contains `jsonwebtoken`, `aws-sdk`, and other common dependencies
- **Lambda code** (~350KB): Contains handler.js + module files + required npm modules

**NEVER include all node_modules** - Only include specific modules not in the layer.

## Correct Deployment Command

```bash
cd C:/VSProjects/bndy-serverless-api/events-lambda

# Create zip with ALL JS files and required modules (9 total)
powershell "Compress-Archive -Path *.js,node_modules/ngeohash,node_modules/ics,node_modules/nanoid,node_modules/runes2,node_modules/yup,node_modules/property-expr,node_modules/tiny-case,node_modules/toposort,node_modules/type-fest -DestinationPath events-lambda-deploy.zip -Force"

# Deploy to AWS
MSYS_NO_PATHCONV=1 aws lambda update-function-code \
  --function-name bndy-serverless-api-EventsFunction-03skAPFIwe9g \
  --zip-file fileb://events-lambda-deploy.zip \
  --region eu-west-2

# Wait for deployment to complete
MSYS_NO_PATHCONV=1 aws lambda wait function-updated \
  --function-name bndy-serverless-api-EventsFunction-03skAPFIwe9g \
  --region eu-west-2
```

## Quick Reference

- **Function Name**: `bndy-serverless-api-EventsFunction-03skAPFIwe9g`
- **Region**: `eu-west-2`
- **Runtime**: Node.js 20.x
- **Layer**: `bndy-jwt:3` (contains jsonwebtoken, aws-sdk)

## Included Modules (9 total)

| Module | Purpose |
|--------|---------|
| `*.js` | Handler + calendar modules |
| `ngeohash` | Geolocation hashing |
| `ics` | iCal generation library |
| `nanoid` | ID generation (ics dependency) |
| `runes2` | Unicode handling (ics dependency) |
| `yup` | Schema validation (ics dependency) |
| `property-expr` | Property access (yup dependency) |
| `tiny-case` | Case conversion (yup dependency) |
| `toposort` | Topological sort (yup dependency) |
| `type-fest` | TypeScript utilities (yup dependency) |

## Common Mistakes

❌ **WRONG**: `Compress-Archive -Path handler.js` (missing modules)
❌ **WRONG**: `Compress-Archive -Path *.js,node_modules/ics` (missing ics dependencies)
❌ **WRONG**: `Compress-Archive -Path handler.js,node_modules` (too large, 14MB)
✅ **CORRECT**: Include all 9 modules listed above (~350KB)

## Verification

After deployment, check:
1. Code size should be ~350KB
2. No "Cannot find module" errors in logs:

```bash
MSYS_NO_PATHCONV=1 aws logs tail /aws/lambda/bndy-serverless-api-EventsFunction-03skAPFIwe9g --follow --region eu-west-2
```

## Future: CDK Migration

This manual deployment process should be migrated to CDK for:
- Automated deployments via CI/CD
- Infrastructure as code
- Atomic deployments with rollback

See plan file for CDK migration details.

---

## Geo endpoint upgrade — deploy handoff (2026-07-11, audit A1)

Design: `Projects/bndy/GEO-EVENTS-ENDPOINT-PLAN.md` (v2 addendum). Code changes (committed by Claude/Cowork, tests green: `npx jest lib/geo-query.test.js handlers/public.geo.test.js handlers/public-perf.test.js`):
- `lib/geo-query.js` (+tests) — bbox parsing, adaptive precision planning, capped fan-out
- `handlers/public.js` — `GET /api/events/public/geo` now accepts `bbox=west,south,east,north` (legacy `geohash` param kept); country-scale falls back to whole-window scan with `truncated:true`
- `backfill-geohash.js` — dry-run default

Deploy order (each step gates the next):
1. Create the viewport GSI (online, no downtime):
   ```bash
   aws dynamodb update-table --table-name bndy-events --region eu-west-2 \
     --attribute-definitions AttributeName=geohash4,AttributeType=S AttributeName=date,AttributeType=S \
     --global-secondary-index-updates '[{"Create":{"IndexName":"geohash4-date-index","KeySchema":[{"AttributeName":"geohash4","KeyType":"HASH"},{"AttributeName":"date","KeyType":"RANGE"}],"Projection":{"ProjectionType":"INCLUDE","NonKeyAttributes":["artistId","venueId","startTime","geoLat","geoLng","isPublic"]}}}]'
   ```
   Wait until `IndexStatus: ACTIVE` (describe-table). NB `id` is the table PK — projected automatically.
2. `node backfill-geohash.js` (dry run) → review counts + `geo-backfill-report.json` → `node backfill-geohash.js --execute`. The `missingCoords` list = venues needing geocoding.
3. `npm run validate` + `node scripts/verify-routes.js` → deploy EventsFunction.
4. Smoke: city bbox `?bbox=-2.4,52.9,-2.0,53.15&startDate=<today>&endDate=<+14d>` returns events with `truncated:false`; UK bbox returns `truncated:true`.
5. Existing `geohash6-date-index` GSI exists in prod but not in IaC — record it alongside this one.
