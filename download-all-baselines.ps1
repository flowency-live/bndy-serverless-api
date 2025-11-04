# Download All Production Lambda Baselines
# Created: 2025-11-04

$ErrorActionPreference = "Stop"
$region = "eu-west-2"
$baseDir = "_production_baselines"

# Ensure baseline directory exists
if (-not (Test-Path $baseDir)) {
    New-Item -ItemType Directory -Path $baseDir | Out-Null
}

# Lambda function mappings (local name -> AWS function name)
$lambdas = @{
    "auth-lambda" = "bndy-serverless-api-AuthFunction-gKJksEC1lGjw"
    "artist-songs-lambda" = "bndy-serverless-api-ArtistSongsFunction"
    "artists-lambda" = "bndy-serverless-api-ArtistsFunction-4wCJA9JLMwF5"
    "events-lambda" = "bndy-serverless-api-EventsFunction-03skAPFIwe9g"
    "invites-lambda" = "bndy-serverless-api-InvitesFunction"
    "issues-lambda" = "bndy-serverless-api-IssuesFunction"
    "memberships-lambda" = "bndy-serverless-api-MembershipsFunction-adBmJyeWuWLA"
    "setlists-lambda" = "bndy-serverless-api-SetlistsFunction"
    "songs-lambda" = "bndy-serverless-api-SongsFunction-c3eFxAdsTmeS"
    "uploads-lambda" = "bndy-serverless-api-UploadsFunction"
    "users-lambda" = "bndy-serverless-api-UsersFunction-HNQeQw7kJO9b"
    "venues-lambda" = "bndy-serverless-api-VenuesFunction-z91LnIIRKHhq"
    "events-agent-lambda" = "bndy-serverless-api-EventsAgentFunction"
    "spotify-lambda" = "bndy-serverless-api-SpotifyFunction"
}

Write-Host "=== Downloading Production Lambda Baselines ===" -ForegroundColor Cyan
Write-Host "Target: $baseDir" -ForegroundColor Gray
Write-Host "Region: $region" -ForegroundColor Gray
Write-Host ""

$successCount = 0
$failCount = 0
$results = @()

foreach ($lambda in $lambdas.GetEnumerator()) {
    $localName = $lambda.Key
    $awsName = $lambda.Value
    $zipFile = "$baseDir\$localName-BASELINE.zip"

    Write-Host "Downloading $localName..." -NoNewline

    try {
        # Get function URL
        $functionUrl = aws lambda get-function --function-name $awsName --region $region --query 'Code.Location' --output text 2>&1

        if ($LASTEXITCODE -ne 0) {
            Write-Host " FAILED (function not found)" -ForegroundColor Red
            $failCount++
            $results += @{
                Name = $localName
                AWS = $awsName
                Status = "NOT_FOUND"
                File = $null
            }
            continue
        }

        # Download via curl
        curl.exe -s -o $zipFile $functionUrl

        if ($LASTEXITCODE -eq 0 -and (Test-Path $zipFile)) {
            $size = (Get-Item $zipFile).Length / 1MB
            Write-Host " OK ($([math]::Round($size, 2)) MB)" -ForegroundColor Green
            $successCount++
            $results += @{
                Name = $localName
                AWS = $awsName
                Status = "DOWNLOADED"
                File = $zipFile
            }
        } else {
            Write-Host " FAILED (download error)" -ForegroundColor Red
            $failCount++
            $results += @{
                Name = $localName
                AWS = $awsName
                Status = "DOWNLOAD_FAILED"
                File = $null
            }
        }
    }
    catch {
        Write-Host " FAILED ($($_.Exception.Message))" -ForegroundColor Red
        $failCount++
        $results += @{
            Name = $localName
            AWS = $awsName
            Status = "ERROR"
            File = $null
        }
    }
}

Write-Host ""
Write-Host "=== Download Complete ===" -ForegroundColor Cyan
Write-Host "Success: $successCount" -ForegroundColor Green
Write-Host "Failed: $failCount" -ForegroundColor Red
Write-Host ""

# Create baseline metadata
$metadata = @"
# Production Lambda Baselines

**Downloaded:** $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
**Region:** $region
**API Gateway:** qry0k6pmd0 (api.bndy.co.uk)

## Downloaded Functions ($successCount of $($lambdas.Count))

| Local Name | AWS Function Name | Status | File |
|------------|-------------------|--------|------|
"@

foreach ($result in $results) {
    $status = switch ($result.Status) {
        "DOWNLOADED" { "✅ Downloaded" }
        "NOT_FOUND" { "❌ Not Found" }
        "DOWNLOAD_FAILED" { "❌ Failed" }
        "ERROR" { "❌ Error" }
    }
    $file = if ($result.File) { Split-Path $result.File -Leaf } else { "-" }
    $metadata += "`n| $($result.Name) | $($result.AWS) | $status | $file |"
}

$metadata += @"

## How to Use Baselines

### Restore a Lambda from baseline:
``````powershell
# Extract baseline
Expand-Archive -Path _production_baselines\auth-lambda-BASELINE.zip -DestinationPath auth-lambda-restored -Force

# Copy to working directory
Copy-Item -Path auth-lambda-restored\* -Destination auth-lambda\ -Recurse -Force
``````

### Update baselines after deployment:
``````powershell
.\download-all-baselines.ps1
``````

### Verify a baseline matches production:
``````powershell
aws lambda get-function --function-name bndy-serverless-api-AuthFunction-gKJksEC1lGjw --region eu-west-2 --query 'Configuration.[LastModified,CodeSha256]'
``````

## Deployment History

See git log for deployment history:
``````bash
git log --oneline --all -- auth-lambda/
``````

## Rollback Procedure

1. Stop and assess the issue
2. Check git history for last known good state
3. If needed, restore from baseline:
   ``````powershell
   Expand-Archive -Path _production_baselines\[lambda]-BASELINE.zip -DestinationPath [lambda]\ -Force
   ``````
4. Deploy restored version
5. Investigate issue offline

## Notes

- Baselines are snapshots of deployed Lambda code
- Update baselines after successful deployments
- Baselines include node_modules (ready to deploy)
- Do not modify baseline files directly
- Git history is the source of truth for changes
"@

$metadata | Out-File -FilePath "$baseDir\BASELINE_INFO.md" -Encoding UTF8

Write-Host "Metadata created: $baseDir\BASELINE_INFO.md" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Review baselines in $baseDir" -ForegroundColor Gray
Write-Host "2. Run cleanup script to remove zip files and backups" -ForegroundColor Gray
Write-Host "3. Commit clean state to git" -ForegroundColor Gray
