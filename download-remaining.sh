#!/bin/bash
# Download remaining 4 Lambdas

cd "$(dirname "$0")"

echo "Downloading remaining Lambda functions..."
echo ""

# Events Lambda
echo "[1/4] Events Lambda..."
aws lambda get-function --function-name bndy-serverless-api-EventsFunction-03skAPFIwe9g --query 'Code.Location' --output text > url.txt
curl -s "$(cat url.txt)" -o events-lambda.zip
mkdir -p events-lambda
unzip -o -q events-lambda.zip -d events-lambda 2>/dev/null
rm events-lambda.zip url.txt
echo "✅ Events Lambda"

# Songs Lambda
echo "[2/4] Songs Lambda..."
aws lambda get-function --function-name bndy-serverless-api-SongsFunction-c3eFxAdsTmeS --query 'Code.Location' --output text > url.txt
curl -s "$(cat url.txt)" -o songs-lambda.zip
mkdir -p songs-lambda
unzip -o -q songs-lambda.zip -d songs-lambda 2>/dev/null
rm songs-lambda.zip url.txt
echo "✅ Songs Lambda"

# Uploads Lambda
echo "[3/4] Uploads Lambda..."
aws lambda get-function --function-name bndy-serverless-api-UploadsFunction --query 'Code.Location' --output text > url.txt
curl -s "$(cat url.txt)" -o uploads-lambda.zip
mkdir -p uploads-lambda
unzip -o -q uploads-lambda.zip -d uploads-lambda 2>/dev/null
rm uploads-lambda.zip url.txt
echo "✅ Uploads Lambda"

# Users Lambda
echo "[4/4] Users Lambda..."
aws lambda get-function --function-name bndy-serverless-api-UsersFunction-HNQeQw7kJO9b --query 'Code.Location' --output text > url.txt
curl -s "$(cat url.txt)" -o users-lambda.zip
mkdir -p users-lambda
unzip -o -q users-lambda.zip -d users-lambda 2>/dev/null
rm users-lambda.zip url.txt
echo "✅ Users Lambda"

echo ""
echo "✨ All 10 Lambda functions downloaded!"
echo ""
echo "Directories:"
ls -d *-lambda
