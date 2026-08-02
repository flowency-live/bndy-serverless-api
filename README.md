# BNDY Serverless API - Lambda Functions

**Last Synced**: 2025-10-13
**Lambda Count**: 10 functions
**Runtime**: Node.js 18.x
**Region**: eu-west-2

---

## Lambda Functions

| Function | Directory | Handler | Last Modified | Size |
|----------|-----------|---------|---------------|------|
| Artists | `artists-lambda/` | handler.handler | 2025-10-10 | 14.3 MB |
| Auth | `auth-lambda/` | handler.handler | 2025-10-12 | 14.5 MB |
| Events | `events-lambda/` | handler.handler | 2025-10-13 | 14.4 MB |
| Invites | `invites-lambda/` | handler.handler | 2025-10-12 | 14.4 MB |
| Issues | `issues-lambda/` | handler.handler | 2025-10-05 | 14.4 MB |
| Memberships | `memberships-lambda/` | handler.handler | 2025-10-12 | 14.4 MB |
| Songs | `songs-lambda/` | handler.handler | 2025-10-05 | 14.2 MB |
| Uploads | `uploads-lambda/` | handler.handler | 2025-10-03 | 14.4 MB |
| Users | `users-lambda/` | handler.handler | 2025-10-03 | 14.4 MB |
| Venues | `venues-lambda/` | handler.handler | 2025-10-08 | 14.2 MB |

---

## AWS Function Names

```
bndy-serverless-api-ArtistsFunction-4wCJA9JLMwF5
bndy-serverless-api-AuthFunction-gKJksEC1lGjw
bndy-serverless-api-EventsFunction-03skAPFIwe9g
bndy-serverless-api-InvitesFunction
bndy-serverless-api-IssuesFunction
bndy-serverless-api-MembershipsFunction-adBmJyeWuWLA
bndy-serverless-api-SongsFunction-c3eFxAdsTmeS
bndy-serverless-api-UploadsFunction
bndy-serverless-api-UsersFunction-HNQeQw7kJO9b
bndy-serverless-api-VenuesFunction-z91LnIIRKHhq
```

---

## Development Workflow

### 1. Make Changes Locally
```bash
# Edit code
code artists-lambda/handler.js

# Test locally (if needed)
cd artists-lambda && npm test
```

### 2. Deploy to AWS
```bash
# Package Lambda
cd artists-lambda
zip -r ../artists-lambda-deploy.zip . -x "*.git*" "*node_modules/.cache*"
cd ..

# Deploy to AWS
aws lambda update-function-code \
  --function-name bndy-serverless-api-ArtistsFunction-4wCJA9JLMwF5 \
  --zip-file fileb://artists-lambda-deploy.zip \
  --query '{SHA:CodeSha256,Size:CodeSize}' \
  --output json

# Clean up
rm artists-lambda-deploy.zip
```

### 3. Test in Production
```bash
# Test the endpoint
curl "https://api.bndy.co.uk/api/artists"

# Check logs
aws logs tail /aws/lambda/bndy-serverless-api-ArtistsFunction-4wCJA9JLMwF5 \
  --since 5m --format short
```

### 4. Commit Changes
```bash
git add artists-lambda/
git commit -m "Update artists Lambda: <description>"
git push origin main
```

---

## Sync from AWS

If you need to re-download the latest code from AWS:

```bash
./download-all-lambdas.sh
```

Or for specific functions:
```bash
./download-remaining.sh
```

---

## Project Structure

```
bndy-serverless-api/
├── README.md                    # This file
├── AUTH_ROLLBACK_PROCEDURES.md  # Critical auth rollback doc
├── .gitignore
├── download-all-lambdas.sh      # Download all 10 Lambdas
├── download-remaining.sh        # Download missing Lambdas
│
├── artists-lambda/
│   ├── handler.js               # Main Lambda handler
│   ├── package.json
│   └── node_modules/
│
├── auth-lambda/
│   ├── handler.js
│   ├── package.json
│   └── node_modules/
│
├── events-lambda/
│   ├── handler.js
│   ├── package.json
│   └── node_modules/
│
├── invites-lambda/
│   ├── handler.js
│   ├── package.json
│   └── node_modules/
│
├── issues-lambda/
│   ├── handler.js
│   ├── package.json
│   └── node_modules/
│
├── memberships-lambda/
│   ├── handler.js
│   ├── package.json
│   └── node_modules/
│
├── songs-lambda/
│   ├── handler.js
│   ├── package.json
│   └── node_modules/
│
├── uploads-lambda/
│   ├── handler.js
│   ├── package.json
│   └── node_modules/
│
├── users-lambda/
│   ├── handler.js
│   ├── package.json
│   └── node_modules/
│
└── venues-lambda/
    ├── handler.js
    ├── package.json
    └── node_modules/
```

---

## API Gateway

**API ID**: `qry0k6pmd0`
**Base URL**: `https://api.bndy.co.uk`
**Type**: HTTP API (v2)

### Routes

All Lambda functions are accessible via API Gateway routes:
- `/api/artists/*` → Artists Lambda
- `/auth/*` → Auth Lambda
- `/api/events/*` → Events Lambda
- `/api/invites/*` → Invites Lambda
- `/api/issues/*` → Issues Lambda
- `/api/memberships/*` → Memberships Lambda
- `/api/songs/*` → Songs Lambda
- `/uploads/*` → Uploads Lambda
- `/api/users/*` → Users Lambda
- `/api/venues/*` → Venues Lambda

---

## DynamoDB Tables

All Lambdas interact with these DynamoDB tables:

- `bndy-artists` - Artist profiles
- `bndy-artist-memberships` - Artist membership/ownership
- `bndy-events` - Events (gigs, practices, unavailability)
- `bndy-invites` - Artist/venue invitations
- `bndy-issues` - Bug reports/feedback
- `bndy-songs` - Song library
- `bndy-users` - User profiles
- `bndy-venues` - Venue directory
- `bndy-otp-codes` - OTP codes for phone auth

---

## Environment Variables

All Lambda functions have access to:
- `JWT_SECRET` - Session token signing
- `COGNITO_USER_POOL_CLIENT_ID: stored in `bndy/cognito-backstage-server-client` (`clientId`); value not documented.
- `COGNITO_USER_POOL_CLIENT_SECRET: stored in `bndy/cognito-backstage-server-client` (`clientSecret`); value not documented.
- `NODE_ENV=production`

---

## Dependencies

All Lambdas use:
- `aws-sdk@2.x` - AWS SDK for Node.js
- `jsonwebtoken` - JWT handling
- `crypto` - Built-in Node.js crypto

Individual Lambdas may have additional dependencies (check `package.json`).

---

## Current Task: Event Wizard Integration

**Goal**: Add community event creation endpoints to artists-lambda and events-lambda

**New Endpoints**:
- `GET /api/artists/search?name=<query>&location=<location>` - Fuzzy artist search
- `POST /api/artists/community` - Create community artist (no auth)
- `POST /api/events/community` - Create community event (no auth)

**Status**: Ready to start implementation

**Documentation**: See `EVENT_WIZARD_MASTER_PLAN.md` in `bndy All Platform Docs/`

---

## Git Workflow

This repository is tracked in Git:

```bash
# Check status
git status

# Commit changes
git add .
git commit -m "Descriptive message"

# Push to remote (if configured)
git push origin main
```

---

## Notes

- **DO NOT** edit code directly in AWS Console - always edit locally and deploy
- **DO** commit changes to git after every deployment
- **DO** test endpoints after deployment
- **DO** check CloudWatch logs if something breaks
- **KEEP** `AUTH_ROLLBACK_PROCEDURES.md` - it's your safety net

---

## Quick Commands

```bash
# List all Lambda functions
aws lambda list-functions --query "Functions[?starts_with(FunctionName, 'bndy')].FunctionName"

# Get function info
aws lambda get-function --function-name <FUNCTION_NAME>

# View logs
aws logs tail /aws/lambda/<FUNCTION_NAME> --since 1h --format short

# Update function code
aws lambda update-function-code \
  --function-name <FUNCTION_NAME> \
  --zip-file fileb://lambda.zip
```

---

**Last Updated**: 2025-10-13
**Maintained By**: Claude Code + Jason
