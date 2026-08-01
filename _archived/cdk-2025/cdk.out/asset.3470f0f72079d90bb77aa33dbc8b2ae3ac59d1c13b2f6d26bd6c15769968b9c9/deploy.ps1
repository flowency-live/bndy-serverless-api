# Deploy venue-enrichment-lambda to AWS
# PowerShell deployment script for Windows

$ErrorActionPreference = "Stop"

Write-Host "Deploying venue-enrichment-lambda..." -ForegroundColor Green

# Create deployment package
Write-Host "Creating deployment package..." -ForegroundColor Yellow
if (Test-Path function.zip) {
    Remove-Item function.zip
}

# Use PowerShell's Compress-Archive
$filesToExclude = @("*.git*", "test-local.js", "deploy.sh", "deploy.ps1", "README.md", "function.zip")
$filesToInclude = Get-ChildItem -Recurse | Where-Object {
    $file = $_
    -not ($filesToExclude | Where-Object { $file.Name -like $_ })
}

Compress-Archive -Path handler.js, package.json, package-lock.json, node_modules -DestinationPath function.zip -Force

# Check if Lambda function exists
$FunctionName = "venue-enrichment-lambda"
$Region = "eu-west-2"

try {
    aws lambda get-function --function-name $FunctionName --region $Region 2>$null | Out-Null
    Write-Host "Lambda function exists, updating code..." -ForegroundColor Yellow

    aws lambda update-function-code `
        --function-name $FunctionName `
        --zip-file fileb://function.zip `
        --region $Region

    Write-Host ""
    Write-Host "Deployment complete!" -ForegroundColor Green
}
catch {
    Write-Host "Lambda function does not exist, creating..." -ForegroundColor Red
    Write-Host ""
    Write-Host "ERROR: Please create the Lambda function first via AWS Console or CLI" -ForegroundColor Red
    Write-Host ""
    Write-Host "Required settings:" -ForegroundColor Yellow
    Write-Host "  - Function name: venue-enrichment-lambda"
    Write-Host "  - Runtime: Node.js 18.x or higher"
    Write-Host "  - Handler: handler.handler"
    Write-Host "  - Role: Lambda execution role with DynamoDB access"
    Write-Host "  - Environment variable: ANTHROPIC_API_KEY=<your-key>"
    Write-Host ""
    Write-Host "Create command:" -ForegroundColor Cyan
    Write-Host "aws lambda create-function \"
    Write-Host "  --function-name venue-enrichment-lambda \"
    Write-Host "  --runtime nodejs18.x \"
    Write-Host "  --role arn:aws:iam::YOUR_ACCOUNT:role/lambda-dynamodb-role \"
    Write-Host "  --handler handler.handler \"
    Write-Host "  --zip-file fileb://function.zip \"
    Write-Host "  --timeout 30 \"
    Write-Host "  --memory-size 256 \"
    Write-Host "  --region eu-west-2"
    exit 1
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Set ANTHROPIC_API_KEY environment variable if not already set"
Write-Host "2. Create API Gateway route: POST /api/admin/venues/enrich"
Write-Host "3. Test with a sample venue"
