# Events Lambda Deployment Guide

## CRITICAL: Layer Architecture

This Lambda uses AWS Lambda Layers for shared dependencies:
- **bndy-jwt layer** (14MB): Contains `jsonwebtoken`, `aws-sdk`, and other common dependencies
- **Lambda code** (~22KB): Contains only `handler.js` + `ngeohash` module

**NEVER include all node_modules** - Only include `ngeohash` which is not in the layer.

## Correct Deployment Command

```bash
cd C:/VSProjects/bndy-serverless-api/events-lambda

# Create zip with handler.js AND ngeohash module ONLY
powershell "Compress-Archive -Path handler.js,node_modules/ngeohash -DestinationPath events-lambda-deploy.zip -Force"

# Deploy to AWS
aws lambda update-function-code \
  --function-name bndy-serverless-api-EventsFunction-03skAPFIwe9g \
  --zip-file fileb://events-lambda-deploy.zip \
  --region eu-west-2
```

## Quick Reference

- **Function Name**: `bndy-serverless-api-EventsFunction-03skAPFIwe9g`
- **Region**: `eu-west-2`
- **Runtime**: Node.js 20.x
- **Layer**: `bndy-jwt:2` (contains jsonwebtoken, aws-sdk)
- **Included in package**: `ngeohash` module only

## Common Mistakes

❌ **WRONG**: `Compress-Archive -Path handler.js` (missing ngeohash)
❌ **WRONG**: `Compress-Archive -Path handler.js,node_modules` (too large, 14MB)
✅ **CORRECT**: `Compress-Archive -Path handler.js,node_modules/ngeohash` (~22KB)

## Verification

After deployment, check:
1. Code size should be ~22KB (NOT 13KB, NOT 14MB)
2. No "Cannot find module" errors in logs:

```bash
MSYS_NO_PATHCONV=1 aws logs tail /aws/lambda/bndy-serverless-api-EventsFunction-03skAPFIwe9g --follow --region eu-west-2
```