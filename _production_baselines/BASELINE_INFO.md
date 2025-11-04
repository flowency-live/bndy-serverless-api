# Production Lambda Baselines

**Downloaded:** 2025-11-04 20:27:59
**Region:** eu-west-2
**API Gateway:** qry0k6pmd0 (api.bndy.co.uk)

## Downloaded Functions (14 of 14)

| Local Name | AWS Function Name | Status | File |
|------------|-------------------|--------|------|
| spotify-lambda | bndy-serverless-api-SpotifyFunction | âœ… Downloaded | spotify-lambda-BASELINE.zip |
| artists-lambda | bndy-serverless-api-ArtistsFunction-4wCJA9JLMwF5 | âœ… Downloaded | artists-lambda-BASELINE.zip |
| songs-lambda | bndy-serverless-api-SongsFunction-c3eFxAdsTmeS | âœ… Downloaded | songs-lambda-BASELINE.zip |
| memberships-lambda | bndy-serverless-api-MembershipsFunction-adBmJyeWuWLA | âœ… Downloaded | memberships-lambda-BASELINE.zip |
| artist-songs-lambda | bndy-serverless-api-ArtistSongsFunction | âœ… Downloaded | artist-songs-lambda-BASELINE.zip |
| invites-lambda | bndy-serverless-api-InvitesFunction | âœ… Downloaded | invites-lambda-BASELINE.zip |
| venues-lambda | bndy-serverless-api-VenuesFunction-z91LnIIRKHhq | âœ… Downloaded | venues-lambda-BASELINE.zip |
| auth-lambda | bndy-serverless-api-AuthFunction-gKJksEC1lGjw | âœ… Downloaded | auth-lambda-BASELINE.zip |
| uploads-lambda | bndy-serverless-api-UploadsFunction | âœ… Downloaded | uploads-lambda-BASELINE.zip |
| users-lambda | bndy-serverless-api-UsersFunction-HNQeQw7kJO9b | âœ… Downloaded | users-lambda-BASELINE.zip |
| events-agent-lambda | bndy-serverless-api-EventsAgentFunction | âœ… Downloaded | events-agent-lambda-BASELINE.zip |
| events-lambda | bndy-serverless-api-EventsFunction-03skAPFIwe9g | âœ… Downloaded | events-lambda-BASELINE.zip |
| issues-lambda | bndy-serverless-api-IssuesFunction | âœ… Downloaded | issues-lambda-BASELINE.zip |
| setlists-lambda | bndy-serverless-api-SetlistsFunction | âœ… Downloaded | setlists-lambda-BASELINE.zip |
## How to Use Baselines

### Restore a Lambda from baseline:
```powershell
# Extract baseline
Expand-Archive -Path _production_baselines\auth-lambda-BASELINE.zip -DestinationPath auth-lambda-restored -Force

# Copy to working directory
Copy-Item -Path auth-lambda-restored\* -Destination auth-lambda\ -Recurse -Force
```

### Update baselines after deployment:
```powershell
.\download-all-baselines.ps1
```

### Verify a baseline matches production:
```powershell
aws lambda get-function --function-name bndy-serverless-api-AuthFunction-gKJksEC1lGjw --region eu-west-2 --query 'Configuration.[LastModified,CodeSha256]'
```

## Deployment History

See git log for deployment history:
```bash
git log --oneline --all -- auth-lambda/
```

## Rollback Procedure

1. Stop and assess the issue
2. Check git history for last known good state
3. If needed, restore from baseline:
   ```powershell
   Expand-Archive -Path _production_baselines\[lambda]-BASELINE.zip -DestinationPath [lambda]\ -Force
   ```
4. Deploy restored version
5. Investigate issue offline

## Notes

- Baselines are snapshots of deployed Lambda code
- Update baselines after successful deployments
- Baselines include node_modules (ready to deploy)
- Do not modify baseline files directly
- Git history is the source of truth for changes
