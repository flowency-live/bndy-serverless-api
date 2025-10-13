#!/bin/bash
# Download all Lambda functions from AWS
# Run this to get fresh copies of production code

set -e

echo "🚀 Downloading all Lambda functions from AWS"
echo "============================================="
echo ""

cd "$(dirname "$0")"

# Lambda function names and their local directory names
declare -A LAMBDAS=(
  ["bndy-serverless-api-ArtistsFunction-4wCJA9JLMwF5"]="artists-lambda"
  ["bndy-serverless-api-AuthFunction-gKJksEC1lGjw"]="auth-lambda"
  ["bndy-serverless-api-EventsFunction-03skAPFIwe9g"]="events-lambda"
  ["bndy-serverless-api-InvitesFunction"]="invites-lambda"
  ["bndy-serverless-api-IssuesFunction"]="issues-lambda"
  ["bndy-serverless-api-MembershipsFunction-adBmJyeWuWLA"]="memberships-lambda"
  ["bndy-serverless-api-SongsFunction-c3eFxAdsTmeS"]="songs-lambda"
  ["bndy-serverless-api-UploadsFunction"]="uploads-lambda"
  ["bndy-serverless-api-UsersFunction-HNQeQw7kJO9b"]="users-lambda"
  ["bndy-serverless-api-VenuesFunction-z91LnIIRKHhq"]="venues-lambda"
)

TOTAL=${#LAMBDAS[@]}
COUNT=0

for FUNC_NAME in "${!LAMBDAS[@]}"; do
  COUNT=$((COUNT+1))
  DIR_NAME="${LAMBDAS[$FUNC_NAME]}"

  echo "[$COUNT/$TOTAL] Downloading $DIR_NAME..."
  echo "  Function: $FUNC_NAME"

  # Get download URL (expires in 10 minutes)
  URL=$(MSYS_NO_PATHCONV=1 aws lambda get-function \
    --function-name "$FUNC_NAME" \
    --query 'Code.Location' \
    --output text 2>&1)

  if [[ $URL == *"error"* ]] || [[ -z "$URL" ]]; then
    echo "  ❌ Failed to get download URL"
    continue
  fi

  # Download zip
  curl -s "$URL" -o "${DIR_NAME}.zip"

  # Extract to directory
  mkdir -p "$DIR_NAME"
  unzip -q "${DIR_NAME}.zip" -d "$DIR_NAME"

  # Check what we got
  if [ -f "$DIR_NAME/handler.js" ]; then
    LINES=$(wc -l < "$DIR_NAME/handler.js")
    echo "  ✅ Downloaded handler.js ($LINES lines)"
  else
    echo "  ⚠️  No handler.js found (check structure)"
  fi

  # Clean up zip
  rm "${DIR_NAME}.zip"

  echo ""
done

echo "✨ Download Complete!"
echo "===================="
echo ""
echo "Downloaded Lambda functions:"
ls -d *-lambda | while read dir; do
  if [ -f "$dir/handler.js" ]; then
    SIZE=$(du -sh "$dir" | cut -f1)
    LINES=$(wc -l < "$dir/handler.js" 2>/dev/null || echo "0")
    echo "  ✓ $dir ($SIZE, $LINES lines of code)"
  fi
done

echo ""
echo "Next steps:"
echo "  1. Review code: ls -la *-lambda/"
echo "  2. Commit to git: git add . && git commit -m 'Download all Lambdas from production'"
echo "  3. Start development!"
