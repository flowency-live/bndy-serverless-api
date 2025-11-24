#!/bin/bash
# Create Global Secondary Index for fast artist name search
# This replaces slow table Scan with fast Query operation

echo "Creating GSI: name-search-index on bndy-artists table..."
echo ""
echo "GSI Design:"
echo "  - Partition Key: name_prefix (first 2 letters of lowercase name)"
echo "  - Sort Key: name_lower (full lowercase name)"
echo "  - Projection: ALL attributes"
echo "  - Billing: PAY_PER_REQUEST (on-demand)"
echo ""

aws dynamodb update-table \
  --table-name bndy-artists \
  --region eu-west-2 \
  --attribute-definitions \
    AttributeName=name_prefix,AttributeType=S \
    AttributeName=name_lower,AttributeType=S \
  --global-secondary-index-updates \
    "[{\"Create\":{\"IndexName\":\"name-search-index\",\"KeySchema\":[{\"AttributeName\":\"name_prefix\",\"KeyType\":\"HASH\"},{\"AttributeName\":\"name_lower\",\"KeyType\":\"RANGE\"}],\"Projection\":{\"ProjectionType\":\"ALL\"}}}]"

echo ""
echo "GSI creation initiated. This will take 5-10 minutes to backfill."
echo "Check status with: aws dynamodb describe-table --table-name bndy-artists --region eu-west-2 --query 'Table.GlobalSecondaryIndexes[?IndexName==\`name-search-index\`].IndexStatus'"
echo ""
echo "Once status shows 'ACTIVE', the Lambda can use it for fast searches."