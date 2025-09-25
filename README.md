# BNDY Serverless API

AWS SAM-based serverless API for the BNDY platform, migrating from App Runner to Lambda for cost optimization.

## Architecture

```
CloudFront → API Gateway → Lambda Functions → Aurora PostgreSQL
```

## Lambda Functions

- **venues-lambda**: Handles `/api/venues` endpoints for bndy.live map
- **auth-lambda**: Handles authentication and session management
- **bands-lambda**: Handles band/artist management
- **events-lambda**: Handles calendar and event management

## Cost Optimization

- **Current**: App Runner ~$35/month (always running)
- **Target**: Lambda ~$8/month (pay-per-use)
- **Savings**: 77% reduction in compute costs

## Deployment

```bash
# Install dependencies
sam build

# Deploy to AWS
sam deploy --guided

# Update CloudFront origin
aws cloudfront update-distribution --id E38Q1M8JJ4XWO5 --distribution-config file://cloudfront-config.json
```

## Environment

- **Runtime**: Node.js 18.x
- **Region**: eu-west-2
- **Database**: Aurora PostgreSQL Serverless v2

## Migration Status

- [x] SAM template created
- [x] venues-lambda implemented
- [ ] auth-lambda implemented
- [ ] bands-lambda implemented
- [ ] events-lambda implemented
- [ ] CloudFront integration
- [ ] DNS cutover