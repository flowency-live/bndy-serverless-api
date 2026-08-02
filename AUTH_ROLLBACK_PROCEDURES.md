# 🚨 AUTH LAMBDA ROLLBACK PROCEDURES

**CRITICAL SAFETY DOCUMENT**

This document contains step-by-step procedures to rollback the Auth Lambda to the known-working Google OAuth-only implementation if phone authentication causes issues.

---

## Production Function Details

**Function Name:** `bndy-serverless-api-AuthFunction-gKJksEC1lGjw`
**ARN:** `arn:aws:lambda:eu-west-2:771551874768:function:bndy-serverless-api-AuthFunction-gKJksEC1lGjw`
**Runtime:** nodejs18.x
**Handler:** handler.handler

**Last Known Good State:**
- Date: 2025-10-03 20:01:20 UTC
- CodeSha256: `naIdxMBrJFaePI5LeYku8owN6G8JE7MfcTIB9CEcW3M=`
- Features: Google OAuth only, session management, DynamoDB user sync

---

## Backup Locations

### Primary Backup (Source Code)
```
C:\VSProjects\bndy-serverless-api\auth-lambda\handler.PRODUCTION_GOOGLE_OAUTH_ONLY_BACKUP.js
```

### Secondary Backup (Full Package)
```
C:\VSProjects\bndy-serverless-api\auth-lambda\PRODUCTION_BACKUP_20251011_181647.zip
```

### Git Commit
```
Branch: master
Commit: 94c8158
Message: "CRITICAL BACKUP: Production Auth Lambda (Google OAuth Only)"
```

---

## When to Rollback

Rollback immediately if you observe:

1. **Login fails** - Users cannot sign in with Google
2. **Session errors** - Authenticated users get logged out or get 401 errors
3. **Cookie issues** - Session cookies not being set correctly
4. **Redirect loops** - OAuth callback not working
5. **DynamoDB errors** - Users not being created/updated in bndy-users table

---

## Rollback Procedure

### Option A: From Local Backup (Fastest - 2 minutes)

```bash
# 1. Navigate to auth lambda directory
cd C:/VSProjects/bndy-serverless-api/auth-lambda

# 2. Restore the backup handler
cp handler.PRODUCTION_GOOGLE_OAUTH_ONLY_BACKUP.js handler.js

# 3. Verify dependencies are installed
npm install

# 4. Create deployment package
zip -r auth-lambda-rollback.zip handler.js node_modules/ package.json package-lock.json

# 5. Deploy to Lambda
MSYS_NO_PATHCONV=1 aws lambda update-function-code \
  --function-name bndy-serverless-api-AuthFunction-gKJksEC1lGjw \
  --zip-file fileb://auth-lambda-rollback.zip \
  --query '{SHA:CodeSha256,Size:CodeSize}' \
  --output json

# 6. Wait 10 seconds for deployment
sleep 10

# 7. Verify the function is active
MSYS_NO_PATHCONV=1 aws lambda get-function \
  --function-name bndy-serverless-api-AuthFunction-gKJksEC1lGjw \
  --query 'Configuration.{State:State,LastModified:LastModified}' \
  --output json
```

### Option B: From Git (If local files corrupted)

```bash
# 1. Navigate to auth lambda directory
cd C:/VSProjects/bndy-serverless-api/auth-lambda

# 2. Reset to backup commit
git checkout 94c8158 -- handler.PRODUCTION_GOOGLE_OAUTH_ONLY_BACKUP.js

# 3. Copy to handler.js
cp handler.PRODUCTION_GOOGLE_OAUTH_ONLY_BACKUP.js handler.js

# 4-7. Follow steps 3-7 from Option A above
```

### Option C: Extract from Backup ZIP

```bash
# 1. Navigate to auth lambda directory
cd C:/VSProjects/bndy-serverless-api/auth-lambda

# 2. Extract handler from backup
unzip -j PRODUCTION_BACKUP_20251011_181647.zip "*/handler.js" -d .

# 3-7. Follow steps 3-7 from Option A above
```

---

## Verification Steps

After rollback, verify everything works:

### 1. Check Function Status
```bash
MSYS_NO_PATHCONV=1 aws lambda get-function \
  --function-name bndy-serverless-api-AuthFunction-gKJksEC1lGjw \
  --query 'Configuration.{State:State,CodeSha256:CodeSha256}' \
  --output json
```

Expected: `State: "Active"`

### 2. Test Google OAuth Flow

1. Open browser (incognito): https://backstage.bndy.co.uk/login
2. Click "Continue with Google"
3. Should redirect to: https://api.bndy.co.uk/auth/google
4. Should redirect to: Google OAuth consent screen
5. After Google auth, should redirect to: https://api.bndy.co.uk/auth/callback
6. Should set cookie and redirect to: https://backstage.bndy.co.uk/dashboard

### 3. Test Session Cookie

Open browser developer tools → Application → Cookies → https://backstage.bndy.co.uk

Should see:
- Cookie name: `bndy_session`
- HttpOnly: ✓
- Secure: ✓
- SameSite: Lax
- Domain: .bndy.co.uk

### 4. Test /api/me Endpoint

In browser console (while logged in):
```javascript
fetch('https://api.bndy.co.uk/api/me', { credentials: 'include' })
  .then(r => r.json())
  .then(console.log)
```

Should return user data with:
- user.id
- user.email
- user.cognitoId
- session.issuedAt

### 5. Check CloudWatch Logs

```bash
MSYS_NO_PATHCONV=1 aws logs tail \
  /aws/lambda/bndy-serverless-api-AuthFunction-gKJksEC1lGjw \
  --since 5m \
  --format short
```

Look for successful auth logs, no errors.

---

## API Routes (Google OAuth Only)

The rolled-back function handles these routes:

| Method | Route | Description |
|--------|-------|-------------|
| GET | /auth/google | Initiates Google OAuth flow |
| GET | /auth/callback | OAuth callback handler |
| GET | /api/me | Get current user (requires auth) |
| POST | /auth/logout | Logout user (clears cookie) |
| OPTIONS | /* | CORS preflight |

**These routes WILL NOT exist after rollback:**
- POST /auth/phone/request-otp
- POST /auth/phone/verify-otp
- POST /auth/phone/verify-and-onboard

---

## Environment Variables

The rolled-back function requires these environment variables (already set in Lambda):

- `COGNITO_USER_POOL_CLIENT_ID: stored in `bndy/cognito-backstage-server-client` (`clientId`); value not documented.
- `COGNITO_USER_POOL_CLIENT_SECRET: stored in `bndy/cognito-backstage-server-client` (`clientSecret`); value not documented.
- `JWT_SECRET`
- `NODE_ENV=production`

**Verify they're set:**
```bash
MSYS_NO_PATHCONV=1 aws lambda get-function-configuration \
  --function-name bndy-serverless-api-AuthFunction-gKJksEC1lGjw \
  --query 'Environment.Variables' \
  --output json
```

---

## Frontend Compatibility

The rolled-back Auth Lambda is compatible with the current frontend as of 2025-10-11:

✅ **Works with:**
- Login page: `/login` (Google OAuth button)
- OAuth result page: `/oauth-result`
- All authenticated routes (session cookie validated)

❌ **Will break (if implemented):**
- Phone auth pages: `/auth/phone`
- OTP verification flows
- Magic link invite acceptance flows that require phone verification

---

## Troubleshooting After Rollback

### Issue: Still getting 401 errors

**Solution:**
1. Clear all cookies for .bndy.co.uk domain
2. Clear browser cache
3. Try in incognito window
4. Re-authenticate via Google

### Issue: "Route not found" errors

**Check API Gateway routes:**
```bash
MSYS_NO_PATHCONV=1 aws apigatewayv2 get-routes \
  --api-id qry0k6pmd0 \
  --query "Items[?contains(RouteKey, 'auth')].{Route:RouteKey,Integration:Target}" \
  --output table
```

Required routes:
- GET /auth/google
- GET /auth/callback
- GET /api/me
- POST /auth/logout

### Issue: Cognito errors

**Verify Cognito configuration:**
```bash
MSYS_NO_PATHCONV=1 aws cognito-idp describe-user-pool \
  --user-pool-id eu-west-2_LqtkKHs1P \
  --query 'UserPool.{MfaConfiguration:MfaConfiguration,UsernameAttributes:UsernameAttributes}' \
  --output json
```

### Issue: DynamoDB errors

**Check bndy-users table exists:**
```bash
MSYS_NO_PATHCONV=1 aws dynamodb describe-table \
  --table-name bndy-users \
  --query 'Table.{Status:TableStatus,Keys:KeySchema}' \
  --output json
```

---

## Contact Information

If rollback fails or issues persist:

1. **Check CloudWatch Logs** (last 30 minutes):
```bash
MSYS_NO_PATHCONV=1 aws logs tail \
  /aws/lambda/bndy-serverless-api-AuthFunction-gKJksEC1lGjw \
  --since 30m \
  --follow
```

2. **Check Function State:**
```bash
MSYS_NO_PATHCONV=1 aws lambda get-function \
  --function-name bndy-serverless-api-AuthFunction-gKJksEC1lGjw \
  --query 'Configuration.State' \
  --output text
```

3. **Last Resort - Redeploy from scratch:**
   - See: `PHONE_AUTH_MAGIC_LINK_IMPLEMENTATION_PLAN.md`
   - Section: "Emergency: Complete Auth Lambda Rebuild"

---

## Success Criteria

✅ Rollback is successful when:

1. Users can log in with Google OAuth
2. Sessions persist across page refreshes
3. /api/me returns user data
4. No 401/403 errors on authenticated routes
5. CloudWatch logs show no errors
6. Function state is "Active"

---

## Notes

- **DO NOT** delete `handler.PRODUCTION_GOOGLE_OAUTH_ONLY_BACKUP.js` - it's your safety net
- **DO NOT** push broken code to production without testing locally first
- **ALWAYS** test in staging/local before deploying to production Lambda
- **KEEP** this document updated if auth architecture changes

---

**Last Updated:** 2025-10-11
**Backup Created:** 2025-10-11 18:16 UTC
**Git Commit:** 94c8158
