# Deploy artists-lambda to AWS
# PowerShell deployment script for Windows

$ErrorActionPreference = "Stop"

Write-Host "Deploying artists-lambda..." -ForegroundColor Green

# Navigate to the lambda directory
Push-Location $PSScriptRoot

try {
    # Create deployment package
    Write-Host "Creating deployment package..." -ForegroundColor Yellow
    if (Test-Path function.zip) {
        Remove-Item function.zip
    }

    # Compress the necessary files
    Compress-Archive -Path handler.js, package.json, node_modules -DestinationPath function.zip -Force

    # Check if Lambda function exists
    $FunctionName = "bndy-serverless-api-ArtistsFunction-4wCJA9JLMwF5"
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
        Write-Host "Lambda function does not exist or update failed" -ForegroundColor Red
        Write-Host "Error: $_" -ForegroundColor Red
        exit 1
    }
}
finally {
    Pop-Location
}
