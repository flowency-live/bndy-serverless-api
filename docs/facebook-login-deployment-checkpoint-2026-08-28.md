# Facebook Login Deployment Checkpoint

This checkpoint deliberately triggers the standard BNDY API deployment pipeline after the Facebook Cognito OAuth initiation route was added to `master`.

Expected production route: `GET /auth/facebook`

Expected behaviour: HTTP 302 to the configured Cognito `/oauth2/authorize` endpoint with `identity_provider=Facebook`, preserving the validated BNDY `returnTo` flow.
