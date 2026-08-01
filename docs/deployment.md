# Lambda Deployment Guide

## Overview

The BNDY API runs on AWS Lambda functions deployed via SAM (Serverless Application Model). Deployments are handled automatically by GitHub Actions on push to `main`.

**Key Infrastructure:**
- **Stack Name**: `bndy-serverless-api`
- **API Gateway**: `qry0k6pmd0`
- **Custom Domain**: `api.bndy.co.uk`
- **Region**: `eu-west-2`
- **Total Routes**: 140

## Deployment Process

### Standard Deployment (CI/CD)

All deployments should go through GitHub Actions:

1. Make changes to Lambda code
2. Commit and push to `main` branch
3. GitHub Actions runs:
   - Tests for all Lambda functions
   - SAM validate
   - SAM build
   - SAM deploy

```bash
# View deployment status
gh run list --workflow=deploy.yml

# View deployment logs
gh run view <run-id> --log
```

### Emergency Manual Deployment

Only use this for urgent fixes when CI/CD is unavailable:

```bash
# Navigate to lambda directory
cd artists-lambda

# Create deployment package
zip -r function.zip .

# Deploy to AWS
aws lambda update-function-code \
  --function-name bndy-serverless-api-ArtistsFunction-4wCJA9JLMwF5 \
  --zip-file fileb://function.zip

# Clean up
rm function.zip
```

## Lambda Function Mapping

| Service | Function Name | Description |
|---------|--------------|-------------|
| Artists | `bndy-serverless-api-ArtistsFunction-4wCJA9JLMwF5` | Artist CRUD, MCP updates, by-external-id |
| Events | `bndy-serverless-api-EventsFunction-03skAPFIwe9g` | Event CRUD, MCP updates, public events |
| Auth | `bndy-serverless-api-AuthFunction-gKJksEC1lGjw` | OAuth, JWT, sessions |
| Venues | `bndy-serverless-api-VenuesFunction-z91LnIIRKHhq` | Venue CRUD, integration |
| Songs | `bndy-serverless-api-SongsFunction-c3eFxAdsTmeS` | Song library |
| Users | `bndy-serverless-api-UsersFunction-HNQeQw7kJO9b` | User profiles |
| Memberships | `bndy-serverless-api-MembershipsFunction-adBmJyeWuWLA` | Band memberships |
| ArtistSongs | `bndy-serverless-api-ArtistSongsFunction` | Artist song relationships |
| Invites | `bndy-serverless-api-InvitesFunction` | Band invitations |
| Issues | `bndy-serverless-api-IssuesFunction` | User-reported issues |
| Notifications | `bndy-serverless-api-NotificationsFunction` | Push notifications |
| Setlists | `bndy-serverless-api-SetlistsFunction` | Band setlists |
| Spotify | `bndy-serverless-api-SpotifyFunction` | Spotify integration |
| Uploads | `bndy-serverless-api-UploadsFunction` | S3 file uploads |
| VenueCRM | `bndy-serverless-api-VenueCRMFunction` | Venue CRM |
| EventsAgent | `bndy-serverless-api-EventsAgentFunction` | AI event discovery |

## SAM Template Structure

The infrastructure is defined in `template.yaml`:

```
bndy-serverless-api/
├── template.yaml          # SAM infrastructure definition
├── samconfig.toml         # SAM deployment configuration
├── artists-lambda/        # Lambda function code
├── events-lambda/
├── venues-lambda/
└── ... (other lambdas)
```

### Key SAM Commands

```bash
# Validate template
sam validate --lint

# Build all functions
sam build --parallel

# Deploy (with confirmation)
sam deploy

# Deploy (no confirmation - CI/CD uses this)
sam deploy --no-confirm-changeset

# View stack outputs
aws cloudformation describe-stacks --stack-name bndy-serverless-api --query "Stacks[0].Outputs"
```

## MCP Endpoints

The API exposes unauthenticated MCP endpoints for the BNDY MCP Server:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/artists/{id}/mcp` | PUT | Update artist (no auth) |
| `/api/events/{id}/mcp` | PUT | Update event (no auth) |
| `/api/artists/by-external-id` | GET | Find artist by external ID |
| `/api/events/by-external-id` | GET | Find event by external ID |
| `/api/venues/by-external-id` | GET | Find venue by external ID |

## Security Notes

- **JWT_SECRET**: Stored in AWS Secrets Manager (`bndy/jwt-secret`)
- **IAM Role**: All Lambdas use `bndy-api-instance-role`
- **CORS**: Configured for `backstage.bndy.co.uk`, `frontstage.bndy.co.uk`, and localhost

## Historical Context (2026-04-29)

- CDK stack `BndyApiStack` was deleted (created orphaned resources)
- SAM is now the single deployment method
- Previous CDK code archived at `_archived/cdk-2025/`

## Troubleshooting

### Deployment Fails

1. Check GitHub Actions logs
2. Verify AWS credentials are valid in repository secrets
3. Ensure `template.yaml` is valid: `sam validate --lint`

### Lambda Returns 500

1. Check CloudWatch Logs: `/aws/lambda/bndy-serverless-api-{Service}Function-*`
2. Verify environment variables are set
3. Check IAM role permissions

### API Gateway Returns 404

1. Verify route exists: `aws apigatewayv2 get-routes --api-id qry0k6pmd0`
2. Check Lambda integration is connected
3. Ensure route is in `template.yaml`
