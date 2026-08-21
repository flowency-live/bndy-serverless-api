# Cognito auth app client

The production auth Lambda reads its Cognito app client ID and secret from
`bndy/cognito-backstage-server-client`. The referenced app client must retain
the following hosted-UI OAuth configuration.

## Required configuration

- Callback URLs:
  - `https://api.bndy.co.uk/auth/callback`
  - `https://bndy.live/auth/callback`
  - `https://stage.bndy.live/auth/callback`
- Supported identity providers: `COGNITO`, `Google`
- Allowed OAuth flows: `code`
- Allowed OAuth scopes: `email`, `openid`, `phone`, `profile`
- Allowed OAuth flows for user-pool clients: `true`

When using `aws cognito-idp update-user-pool-client`, first read the complete
client configuration and include every populated writable property in the
update. Omitted properties can be reset by the update operation.
