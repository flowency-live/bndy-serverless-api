#!/bin/bash
# Deploy venue-enrichment-lambda to AWS

set -e

echo "Deploying venue-enrichment-lambda..."

# Create deployment package
echo "Creating deployment package..."
zip -r function.zip . -x "*.git*" "test-local.js" "deploy.sh" "README.md" "function.zip"

# Check if Lambda function exists
FUNCTION_NAME="venue-enrichment-lambda"
if aws lambda get-function --function-name $FUNCTION_NAME --region eu-west-2 >/dev/null 2>&1; then
  echo "Lambda function exists, updating code..."
  aws lambda update-function-code \
    --function-name $FUNCTION_NAME \
    --zip-file fileb://function.zip \
    --region eu-west-2
else
  echo "Lambda function does not exist, creating..."
  echo "ERROR: Please create the Lambda function first via AWS Console"
  echo "Required settings:"
  echo "  - Runtime: Node.js 18.x or higher"
  echo "  - Handler: handler.handler"
  echo "  - Role: Lambda execution role with DynamoDB access"
  echo "  - Environment variable: ANTHROPIC_API_KEY"
  exit 1
fi

echo ""
echo "Deployment complete!"
echo ""
echo "Next steps:"
echo "1. Set ANTHROPIC_API_KEY environment variable if not already set"
echo "2. Create API Gateway route: POST /api/admin/venues/enrich"
echo "3. Test with a sample venue"
