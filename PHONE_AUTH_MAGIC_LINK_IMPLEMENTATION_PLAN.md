# 📱 Phone Authentication & Magic Link Invites - Implementation Plan

**Project:** BNDY Platform - Mobile Auth & Invites
**Date:** 2025-10-11
**Status:** Planning Phase

---

## Table of Contents

1. [Overview](#overview)
2. [Current State Analysis](#current-state-analysis)
3. [Architecture Design](#architecture-design)
4. [Phase 1: AWS SNS Sandbox Exit](#phase-1-aws-sns-sandbox-exit-critical)
5. [Phase 2: DynamoDB Tables](#phase-2-dynamodb-tables)
6. [Phase 3: Invites Lambda Function](#phase-3-invites-lambda-function)
7. [Phase 4: Phone Auth Flow (Auth Lambda)](#phase-4-phone-auth-flow-auth-lambda)
8. [Phase 5: API Gateway Routes](#phase-5-api-gateway-routes)
9. [Phase 6: Frontend Implementation](#phase-6-frontend-implementation)
10. [Phase 7: Testing & Validation](#phase-7-testing--validation)
11. [Phase 8: Security & Polish](#phase-8-security--polish)
12. [Rollback Strategy](#rollback-strategy)
13. [Cost Estimates](#cost-estimates)

---

## Overview

### Goals

1. **Phone Authentication**: Users can sign up/login using phone number + OTP
2. **Magic Link Invites**: Band admins can invite members via SMS magic links
3. **Seamless Onboarding**: Invited users can accept and register in one flow
4. **Backward Compatibility**: Existing Google OAuth must continue working

### Key Requirements

- ✅ Google OAuth continues working (CRITICAL - no breaking changes)
- ✅ Phone number verification via SMS OTP (6-digit codes)
- ✅ Magic link invites sent via SMS
- ✅ 7-day invite expiry
- ✅ 3 OTP attempts max per request
- ✅ Auto-join artist on invite acceptance
- ✅ Secure session management (JWT cookies)

---

## Current State Analysis

### ✅ Already Implemented

**AWS Infrastructure:**
- **Cognito User Pool**: `eu-west-2_LqtkKHs1P`
  - Supports phone_number as username ✓
  - Auto-verifies phone_number ✓
  - SMS configuration active ✓
- **SNS SMS**: Configured with IAM role
- **DynamoDB Tables**: 8 tables including:
  - `bndy-users` (has phone field)
  - `bndy-artist-memberships` (has invited_by, invited_at, status)
- **Lambda Functions**: 9 deployed, including Auth + Memberships
- **API Gateway**: HTTP API v2 (qry0k6pmd0) with CORS configured

**Frontend:**
- Invite page skeleton: `/invite/:token`
- Admin UI with invite buttons (lines 665-769 in admin.tsx)
- OTP input component: `input-otp.tsx`
- Phone input fields ready
- Routing configured for invite flows

**Auth Lambda Backup:**
- ✅ Production code backed up: `handler.PRODUCTION_GOOGLE_OAUTH_ONLY_BACKUP.js`
- ✅ Committed to git: commit 94c8158
- ✅ Rollback procedures documented: `AUTH_ROLLBACK_PROCEDURES.md`

### ❌ Not Implemented

1. No `bndy-invites` table
2. No `bndy-otp-codes` table (for OTP storage)
3. No Invites Lambda function
4. No phone auth routes in Auth Lambda
5. No API Gateway routes for invites/phone auth
6. No phone auth pages in frontend
7. No SMS sending logic
8. SNS still in sandbox mode

### ⚠️ Critical Blocker

**AWS SNS Sandbox Mode:**
```
Status: In Sandbox
Verified Numbers: +447758240770 (Pending)
Limitation: Can only send SMS to verified numbers
```

**MUST exit sandbox before any SMS can be sent to users.**

---

## Architecture Design

### System Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     PHONE AUTH FLOW                              │
└─────────────────────────────────────────────────────────────────┘

1. User enters phone number
   ↓
2. POST /auth/phone/request-otp { phone: "+447XXX" }
   ↓
3. Auth Lambda:
   - Generate 6-digit OTP
   - Store in bndy-otp-codes (5 min expiry)
   - Send SMS via SNS
   ↓
4. User enters OTP
   ↓
5. POST /auth/phone/verify-otp { phone, otp }
   ↓
6. Auth Lambda:
   - Validate OTP from DynamoDB
   - Check attempts < 3
   - Create/update user in bndy-users
   - Generate JWT session
   - Set cookie
   ↓
7. Redirect to /dashboard or /onboarding


┌─────────────────────────────────────────────────────────────────┐
│                  MAGIC LINK INVITE FLOW                          │
└─────────────────────────────────────────────────────────────────┘

1. Admin clicks "Send Invite" in /admin
   ↓
2. POST /api/artists/{artistId}/invites/phone { phone: "+447XXX" }
   ↓
3. Invites Lambda:
   - Verify user is admin/owner
   - Generate invite token (UUID)
   - Store in bndy-invites (7 day expiry)
   - Generate magic link: https://backstage.bndy.co.uk/invite/{token}
   - Send SMS via SNS: "You've been invited to join [Artist Name]! [link]"
   ↓
4. User clicks link on phone
   ↓
5. Frontend loads /invite/{token}
   - GET /api/invites/{token}
   - Shows artist name, who invited, expiry
   ↓
6. User clicks "Accept Invitation"
   ↓
7. Check if logged in:
   - NO → Redirect to /auth/phone?returnUrl=/invite/{token}
   - YES → POST /api/invites/{token}/accept
   ↓
8. Invites Lambda:
   - Verify token valid & not expired
   - Create membership in bndy-artist-memberships
   - Mark invite as accepted
   - Update artist member_count
   ↓
9. Redirect to artist dashboard
```

### Data Models

#### bndy-otp-codes Table
```json
{
  "phone": "+447758240770",           // PK
  "otp": "123456",                    // 6-digit code
  "expiresAt": 1697123456789,         // Unix timestamp (5 minutes)
  "attempts": 0,                      // Max 3
  "createdAt": "2025-10-11T18:30:00Z",
  "requestId": "uuid"                 // For logging/debugging
}
```

#### bndy-invites Table
```json
{
  "token": "550e8400-e29b-41d4-a716-446655440000",  // PK (UUID)
  "artistId": "artist-uuid",          // GSI: artistId-expiresAt-index
  "invitedByUserId": "user-uuid",     // Who created invite
  "phone": "+447758240770",           // Target (nullable for general links)
  "inviteType": "phone-specific",     // 'general' | 'phone-specific'
  "status": "pending",                // 'pending' | 'accepted' | 'expired'
  "expiresAt": 1697123456789,         // Unix timestamp (7 days)
  "createdAt": "2025-10-11T18:30:00Z",
  "acceptedAt": null,                 // ISO timestamp when accepted
  "acceptedByUserId": null,           // Who accepted
  "metadata": {
    "artistName": "Not Guilty",
    "inviterName": "Jason"
  }
}
```

#### bndy-users Table (existing, add phone field)
```json
{
  "cognito_id": "cognito-uuid",       // PK
  "user_id": "user-uuid",
  "email": "jason@example.com",       // Nullable now
  "phone": "+447758240770",           // NEW: Phone number (nullable)
  "username": "jason_google",         // From OAuth or generated
  "first_name": "Jason",
  "last_name": "Smith",
  "display_name": "Jason S",
  "hometown": "London",
  "instrument": "Guitar",
  "avatar_url": "https://...",
  "oauth_profile_picture": "https://...",
  "profile_complete": true,
  "created_at": "2025-01-01T00:00:00Z",
  "updated_at": "2025-10-11T18:30:00Z"
}
```

---

## Phase 1: AWS SNS Sandbox Exit (CRITICAL)

**Priority:** ⚠️ HIGH - Must complete before any SMS functionality works
**Duration:** 24-48 hours (AWS approval time)
**Dependencies:** None

### Step 1.1: Verify Pending Phone Number

Current status: `+447758240770` is Pending

```bash
# You'll receive an SMS with a verification code
# Then run:
aws sns verify-sms-sandbox-phone-number \
  --phone-number "+447758240770" \
  --one-time-password "123456"
```

### Step 1.2: Request Production Access

1. Go to AWS Console → SNS → Mobile → Text messaging (SMS)
2. Click "Request production access" (or "Exit sandbox")
3. Fill out form:

```
Use Case: User authentication and band member invitations
Description:
"BNDY is a platform for UK bands to coordinate schedules and collaborate.
We need SMS for:
1. OTP codes for phone number verification during user registration
2. Magic link invitations for band members to join artists
3. Account security notifications

Expected monthly volume: 100-500 SMS initially, growing to 1000-2000
SMS will only be sent to users who:
- Enter their phone number to sign up
- Are invited by a band admin

Opt-out: Users can reply STOP to opt out. We will honor all opt-out requests."

Expected monthly spend: £20-100

Website: https://bndy.co.uk

Support email: support@bndy.co.uk (or your support email)

Opt-out management: Yes, we handle STOP/UNSUBSCRIBE
```

4. Submit and wait for approval (24-48 hours)

### Step 1.3: Configure After Approval

```bash
# Set monthly spending limit (£50 = ~833 UK SMS)
aws sns set-sms-attributes \
  --attributes MonthlySpendLimit=50

# Set default SMS type to Transactional (higher priority)
aws sns set-sms-attributes \
  --attributes DefaultSMSType=Transactional

# Verify settings
aws sns get-sms-attributes \
  --query "attributes.{Limit:MonthlySpendLimit,Type:DefaultSMSType,Status:*}" \
  --output json
```

### Step 1.4: Test SMS Sending

```bash
# After approval, test sending
aws sns publish \
  --phone-number "+447758240770" \
  --message "Test from BNDY Platform - SMS is now live!"

# Check result
echo "If you received the SMS, production access is active!"
```

### Verification Checklist

- [ ] Pending phone number verified
- [ ] Production access request submitted
- [ ] Approval received (check email)
- [ ] Monthly spend limit set
- [ ] SMS type set to Transactional
- [ ] Test SMS sent successfully
- [ ] Sandbox status = false

---

## Phase 2: DynamoDB Tables

**Priority:** HIGH
**Duration:** 15 minutes
**Dependencies:** None

### 2.1: Create bndy-otp-codes Table

```bash
MSYS_NO_PATHCONV=1 aws dynamodb create-table \
  --table-name bndy-otp-codes \
  --attribute-definitions \
    AttributeName=phone,AttributeType=S \
  --key-schema \
    AttributeName=phone,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --tags Key=Project,Value=BNDY Key=Purpose,Value=PhoneAuth

# Wait for table to be active
MSYS_NO_PATHCONV=1 aws dynamodb wait table-exists --table-name bndy-otp-codes

echo "✓ bndy-otp-codes table created"
```

**Enable TTL for auto-cleanup:**
```bash
MSYS_NO_PATHCONV=1 aws dynamodb update-time-to-live \
  --table-name bndy-otp-codes \
  --time-to-live-specification Enabled=true,AttributeName=expiresAt

echo "✓ TTL enabled - expired OTPs will auto-delete"
```

### 2.2: Create bndy-invites Table

```bash
MSYS_NO_PATHCONV=1 aws dynamodb create-table \
  --table-name bndy-invites \
  --attribute-definitions \
    AttributeName=token,AttributeType=S \
    AttributeName=artistId,AttributeType=S \
    AttributeName=expiresAt,AttributeType=N \
  --key-schema \
    AttributeName=token,KeyType=HASH \
  --global-secondary-indexes \
    '[{
      "IndexName": "artistId-expiresAt-index",
      "KeySchema": [
        {"AttributeName": "artistId", "KeyType": "HASH"},
        {"AttributeName": "expiresAt", "KeyType": "RANGE"}
      ],
      "Projection": {"ProjectionType": "ALL"}
    }]' \
  --billing-mode PAY_PER_REQUEST \
  --tags Key=Project,Value=BNDY Key=Purpose,Value=MagicLinkInvites

# Wait for table to be active
MSYS_NO_PATHCONV=1 aws dynamodb wait table-exists --table-name bndy-invites

echo "✓ bndy-invites table created with GSI"
```

**Enable TTL for auto-cleanup:**
```bash
MSYS_NO_PATHCONV=1 aws dynamodb update-time-to-live \
  --table-name bndy-invites \
  --time-to-live-specification Enabled=true,AttributeName=expiresAt

echo "✓ TTL enabled - expired invites will auto-delete"
```

### 2.3: Update bndy-users Table (Add phone index)

The table already has a `phone` field, but let's add a GSI for lookups by phone:

```bash
MSYS_NO_PATHCONV=1 aws dynamodb update-table \
  --table-name bndy-users \
  --attribute-definitions AttributeName=phone,AttributeType=S \
  --global-secondary-index-updates '[{
    "Create": {
      "IndexName": "phone-index",
      "KeySchema": [{"AttributeName": "phone", "KeyType": "HASH"}],
      "Projection": {"ProjectionType": "ALL"}
    }
  }]'

# Wait for index to be active (takes ~5 minutes)
MSYS_NO_PATHCONV=1 aws dynamodb wait table-exists --table-name bndy-users

echo "✓ phone-index added to bndy-users"
```

### Verification

```bash
# List all tables
MSYS_NO_PATHCONV=1 aws dynamodb list-tables \
  --query "TableNames[?contains(@, 'bndy')]" \
  --output table

# Check bndy-otp-codes
MSYS_NO_PATHCONV=1 aws dynamodb describe-table \
  --table-name bndy-otp-codes \
  --query "Table.{Status:TableStatus,TTL:TimeToLiveDescription}" \
  --output json

# Check bndy-invites
MSYS_NO_PATHCONV=1 aws dynamodb describe-table \
  --table-name bndy-invites \
  --query "Table.{Status:TableStatus,GSI:GlobalSecondaryIndexes[].IndexName,TTL:TimeToLiveDescription}" \
  --output json
```

---

## Phase 3: Invites Lambda Function

**Priority:** MEDIUM
**Duration:** 2-3 hours
**Dependencies:** Phase 2 (DynamoDB tables), Phase 1 (SNS for SMS sending)

### 3.1: Create Lambda Function Code

Create: `C:\VSProjects\bndy-serverless-api\invites-lambda\handler.js`

```javascript
// BNDY Invites Lambda Function - Magic Link Invite Management
// Handles: Invite creation, SMS sending, invite acceptance

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// AWS Services
const dynamodb = new AWS.DynamoDB.DocumentClient();
const sns = new AWS.SNS({ region: 'eu-west-2' });

// Configuration
const INVITES_TABLE = 'bndy-invites';
const ARTISTS_TABLE = 'bndy-artists';
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';
const USERS_TABLE = 'bndy-users';
const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = 'https://backstage.bndy.co.uk';

const INVITE_EXPIRY_DAYS = 7;

// ... (Full implementation in separate file)

// Endpoints:
// POST /api/artists/{artistId}/invites/general
// POST /api/artists/{artistId}/invites/phone
// GET /api/invites/{token}
// POST /api/invites/{token}/accept

exports.handler = async (event, context) => {
  // Implementation
};
```

### 3.2: Key Functions to Implement

**Function: handleCreateGeneralInvite**
```javascript
// POST /api/artists/{artistId}/invites/general
// Creates a general invite link (no specific phone)
// Returns: { inviteLink: "https://backstage.bndy.co.uk/invite/{token}" }
```

**Function: handleCreatePhoneInvite**
```javascript
// POST /api/artists/{artistId}/invites/phone
// Body: { phone: "+447XXX" }
// 1. Verify user is admin/owner of artist
// 2. Create invite in bndy-invites
// 3. Send SMS via SNS
// Returns: { success: true, phone }
```

**Function: handleGetInvite**
```javascript
// GET /api/invites/{token}
// Public endpoint (no auth required)
// Returns invite details: artist name, inviter, expiry
// Returns 404 if expired/invalid
```

**Function: handleAcceptInvite**
```javascript
// POST /api/invites/{token}/accept
// Requires auth (user must be logged in)
// 1. Verify token valid & not expired
// 2. Check user not already member
// 3. Create membership in bndy-artist-memberships
// 4. Mark invite as accepted
// 5. Update artist member_count
// Returns: { membership, artist }
```

**Function: sendInviteSMS**
```javascript
const sendInviteSMS = async (phone, artistName, inviterName, inviteLink) => {
  const message = `${inviterName} invited you to join ${artistName} on bndy!\n\n${inviteLink}\n\n(Link expires in 7 days)`;

  await sns.publish({
    PhoneNumber: phone,
    Message: message,
    MessageAttributes: {
      'AWS.SNS.SMS.SMSType': {
        DataType: 'String',
        StringValue: 'Transactional'
      }
    }
  }).promise();
};
```

### 3.3: Create package.json

Create: `C:\VSProjects\bndy-serverless-api\invites-lambda\package.json`

```json
{
  "name": "bndy-invites-lambda",
  "version": "1.0.0",
  "description": "BNDY Magic Link Invites Lambda",
  "main": "handler.js",
  "dependencies": {
    "aws-sdk": "^2.1000.0",
    "jsonwebtoken": "^9.0.0"
  }
}
```

### 3.4: Deploy Invites Lambda

```bash
cd C:/VSProjects/bndy-serverless-api/invites-lambda

# Install dependencies
npm install

# Create deployment package
zip -r invites-lambda-deploy.zip handler.js node_modules/ package.json package-lock.json

# Create Lambda function
MSYS_NO_PATHCONV=1 aws lambda create-function \
  --function-name bndy-serverless-api-InvitesFunction \
  --runtime nodejs18.x \
  --role arn:aws:iam::771551874768:role/bndy-api-instance-role \
  --handler handler.handler \
  --zip-file fileb://invites-lambda-deploy.zip \
  --timeout 30 \
  --memory-size 512 \
  --environment "Variables={JWT_SECRET=2c7fccb87d98f68d36b19d528aa81a61afacf91058c18ee49738c35b50b81aa5,NODE_ENV=production}" \
  --query '{FunctionArn:FunctionArn,FunctionName:FunctionName}' \
  --output json

echo "✓ Invites Lambda deployed"
```

### Verification

```bash
# Test invoke (without API Gateway)
MSYS_NO_PATHCONV=1 aws lambda invoke \
  --function-name bndy-serverless-api-InvitesFunction \
  --payload '{"requestContext":{"http":{"method":"GET","path":"/api/invites/test-token"}}}' \
  response.json

cat response.json
```

---

## Phase 4: Phone Auth Flow (Auth Lambda)

**Priority:** ⚠️ CRITICAL - Handle with extreme care
**Duration:** 3-4 hours
**Dependencies:** Phase 2 (bndy-otp-codes table)

### ⚠️ Safety Procedures

**BEFORE MAKING ANY CHANGES:**

1. ✅ Backup already created: `handler.PRODUCTION_GOOGLE_OAUTH_ONLY_BACKUP.js`
2. ✅ Rollback procedure documented: `AUTH_ROLLBACK_PROCEDURES.md`
3. ⚠️ Test locally before deploying
4. ⚠️ Deploy during low-traffic hours
5. ⚠️ Monitor CloudWatch logs after deployment

### 4.1: Extend Auth Lambda

Add these new endpoints to `auth-lambda/handler.js` **WITHOUT modifying existing OAuth code**:

**Endpoint 1: Request OTP**
```javascript
// POST /auth/phone/request-otp
// Body: { phone: "+447XXX" }
const handlePhoneRequestOTP = async (event) => {
  const { phone } = JSON.parse(event.body);

  // Validate phone format
  if (!/^\+[1-9]\d{10,14}$/.test(phone)) {
    return createResponse(400, { error: 'Invalid phone number format' });
  }

  // Generate 6-digit OTP
  const otp = crypto.randomInt(100000, 999999).toString();
  const expiresAt = Math.floor(Date.now() / 1000) + 300; // 5 minutes

  // Store OTP in DynamoDB
  await dynamodb.put({
    TableName: 'bndy-otp-codes',
    Item: {
      phone,
      otp,
      expiresAt,
      attempts: 0,
      createdAt: new Date().toISOString(),
      requestId: crypto.randomUUID()
    }
  }).promise();

  // Send SMS via SNS
  await sns.publish({
    PhoneNumber: phone,
    Message: `Your bndy verification code is: ${otp}\n\nValid for 5 minutes.`,
    MessageAttributes: {
      'AWS.SNS.SMS.SMSType': {
        DataType: 'String',
        StringValue: 'Transactional'
      }
    }
  }).promise();

  return createResponse(200, { success: true });
};
```

**Endpoint 2: Verify OTP**
```javascript
// POST /auth/phone/verify-otp
// Body: { phone: "+447XXX", otp: "123456" }
const handlePhoneVerifyOTP = async (event) => {
  const { phone, otp } = JSON.parse(event.body);

  // Get OTP from DynamoDB
  const result = await dynamodb.get({
    TableName: 'bndy-otp-codes',
    Key: { phone }
  }).promise();

  const storedOTP = result.Item;

  if (!storedOTP) {
    return createResponse(400, { error: 'No OTP found for this phone' });
  }

  // Check expiry
  if (Date.now() / 1000 > storedOTP.expiresAt) {
    await dynamodb.delete({ TableName: 'bndy-otp-codes', Key: { phone } }).promise();
    return createResponse(400, { error: 'OTP expired' });
  }

  // Check attempts
  if (storedOTP.attempts >= 3) {
    return createResponse(429, { error: 'Too many attempts' });
  }

  // Verify OTP
  if (storedOTP.otp !== otp) {
    // Increment attempts
    await dynamodb.update({
      TableName: 'bndy-otp-codes',
      Key: { phone },
      UpdateExpression: 'SET attempts = attempts + :inc',
      ExpressionAttributeValues: { ':inc': 1 }
    }).promise();

    return createResponse(400, { error: 'Invalid OTP' });
  }

  // OTP valid - delete it
  await dynamodb.delete({ TableName: 'bndy-otp-codes', Key: { phone } }).promise();

  // Check if user exists by phone
  const userResult = await dynamodb.query({
    TableName: USERS_TABLE,
    IndexName: 'phone-index',
    KeyConditionExpression: 'phone = :phone',
    ExpressionAttributeValues: { ':phone': phone }
  }).promise();

  let user;

  if (userResult.Items.length > 0) {
    // Existing user - update last login
    user = userResult.Items[0];
    await dynamodb.update({
      TableName: USERS_TABLE,
      Key: { cognito_id: user.cognito_id },
      UpdateExpression: 'SET updated_at = :now',
      ExpressionAttributeValues: { ':now': new Date().toISOString() }
    }).promise();
  } else {
    // New user - needs onboarding
    return createResponse(200, {
      needsOnboarding: true,
      phone,
      otpVerified: true
    });
  }

  // Create session
  const sessionData = {
    userId: user.cognito_id,
    username: user.username,
    email: user.email,
    phone: user.phone,
    issuedAt: Date.now()
  };

  const sessionToken = jwt.sign(sessionData, JWT_SECRET, { expiresIn: '7d' });

  const cookieOptions = `bndy_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Max-Age=604800; Path=/; Domain=.bndy.co.uk`;

  return createResponse(200, {
    user: {
      id: user.user_id,
      cognitoId: user.cognito_id,
      phone: user.phone,
      displayName: user.display_name,
      profileCompleted: user.profile_complete
    }
  }, cookieOptions);
};
```

**Endpoint 3: Verify OTP and Onboard**
```javascript
// POST /auth/phone/verify-and-onboard
// Body: { phone, otp, profile: { firstName, lastName, displayName, hometown, instrument } }
const handlePhoneVerifyAndOnboard = async (event) => {
  const { phone, otp, profile } = JSON.parse(event.body);

  // First verify OTP (same logic as above)
  // ... (OTP verification code)

  // Create new user
  const userId = crypto.randomUUID();
  const cognitoId = `phone_${phone.replace(/\+/g, '')}_${crypto.randomBytes(8).toString('hex')}`;

  const newUser = {
    cognito_id: cognitoId,
    user_id: userId,
    phone,
    email: null,
    username: `user_${userId.substring(0, 8)}`,
    first_name: profile.firstName,
    last_name: profile.lastName,
    display_name: profile.displayName,
    hometown: profile.hometown,
    instrument: profile.instrument,
    avatar_url: null,
    oauth_profile_picture: null,
    profile_complete: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  await dynamodb.put({
    TableName: USERS_TABLE,
    Item: newUser
  }).promise();

  // Create session
  const sessionData = {
    userId: cognitoId,
    username: newUser.username,
    phone: newUser.phone,
    issuedAt: Date.now()
  };

  const sessionToken = jwt.sign(sessionData, JWT_SECRET, { expiresIn: '7d' });
  const cookieOptions = `bndy_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Max-Age=604800; Path=/; Domain=.bndy.co.uk`;

  return createResponse(200, {
    user: {
      id: newUser.user_id,
      cognitoId: newUser.cognito_id,
      phone: newUser.phone,
      displayName: newUser.display_name,
      profileCompleted: true
    }
  }, cookieOptions);
};
```

### 4.2: Update Main Handler

Add new routes to the main handler **at the end**, after existing routes:

```javascript
exports.handler = async (event, context) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;
  const routeKey = `${method} ${path}`;

  // ... existing CORS and OAuth routes ...

  // EXISTING ROUTES - DO NOT MODIFY
  if (routeKey === 'GET /auth/google') {
    return handleGoogleAuth(event);
  }
  if (routeKey === 'GET /auth/callback') {
    return await handleOAuthCallback(event);
  }
  if (routeKey === 'GET /api/me') {
    return await handleGetMe(event);
  }
  if (routeKey === 'POST /auth/logout') {
    return handleLogout(event);
  }

  // NEW ROUTES - Phone Auth
  if (routeKey === 'POST /auth/phone/request-otp') {
    return await handlePhoneRequestOTP(event);
  }
  if (routeKey === 'POST /auth/phone/verify-otp') {
    return await handlePhoneVerifyOTP(event);
  }
  if (routeKey === 'POST /auth/phone/verify-and-onboard') {
    return await handlePhoneVerifyAndOnboard(event);
  }

  // Route not found
  return createResponse(404, { error: 'Route not found' });
};
```

### 4.3: Deploy Auth Lambda Update

```bash
cd C:/VSProjects/bndy-serverless-api/auth-lambda

# IMPORTANT: Test locally first if possible

# Install any new dependencies (if needed)
npm install

# Create deployment package
zip -r auth-lambda-phone-auth.zip handler.js node_modules/ package.json package-lock.json

# Deploy to Lambda
MSYS_NO_PATHCONV=1 aws lambda update-function-code \
  --function-name bndy-serverless-api-AuthFunction-gKJksEC1lGjw \
  --zip-file fileb://auth-lambda-phone-auth.zip \
  --query '{SHA:CodeSha256,Size:CodeSize}' \
  --output json

# Wait for deployment
sleep 10

# Verify function is active
MSYS_NO_PATHCONV=1 aws lambda get-function \
  --function-name bndy-serverless-api-AuthFunction-gKJksEC1lGjw \
  --query 'Configuration.{State:State,LastModified:LastModified}' \
  --output json

# Monitor logs for errors
MSYS_NO_PATHCONV=1 aws logs tail \
  /aws/lambda/bndy-serverless-api-AuthFunction-gKJksEC1lGjw \
  --since 1m \
  --follow
```

### 4.4: Test Phone Auth Endpoints

**Test 1: Request OTP**
```bash
curl -X POST https://api.bndy.co.uk/auth/phone/request-otp \
  -H "Content-Type: application/json" \
  -d '{"phone": "+447758240770"}'

# Should return: {"success": true}
# Check phone for SMS
```

**Test 2: Verify OTP (will fail until SMS received)**
```bash
curl -X POST https://api.bndy.co.uk/auth/phone/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"phone": "+447758240770", "otp": "123456"}' \
  -i

# Should return session cookie if OTP valid
```

### Rollback Plan

If anything goes wrong:

```bash
cd C:/VSProjects/bndy-serverless-api/auth-lambda

# Copy backup
cp handler.PRODUCTION_GOOGLE_OAUTH_ONLY_BACKUP.js handler.js

# Redeploy
zip -r auth-lambda-rollback.zip handler.js node_modules/ package.json package-lock.json

MSYS_NO_PATHCONV=1 aws lambda update-function-code \
  --function-name bndy-serverless-api-AuthFunction-gKJksEC1lGjw \
  --zip-file fileb://auth-lambda-rollback.zip
```

See `AUTH_ROLLBACK_PROCEDURES.md` for full rollback instructions.

---

## Phase 5: API Gateway Routes

**Priority:** MEDIUM
**Duration:** 30 minutes
**Dependencies:** Phase 3 (Invites Lambda), Phase 4 (Auth Lambda updates)

### 5.1: Create Invites Lambda Integration

```bash
# Get Invites Lambda ARN
INVITES_ARN=$(MSYS_NO_PATHCONV=1 aws lambda get-function \
  --function-name bndy-serverless-api-InvitesFunction \
  --query 'Configuration.FunctionArn' \
  --output text)

# Create integration in API Gateway
INVITES_INTEGRATION_ID=$(MSYS_NO_PATHCONV=1 aws apigatewayv2 create-integration \
  --api-id qry0k6pmd0 \
  --integration-type AWS_PROXY \
  --integration-uri $INVITES_ARN \
  --payload-format-version 2.0 \
  --query 'IntegrationId' \
  --output text)

echo "Invites Integration ID: $INVITES_INTEGRATION_ID"
```

### 5.2: Create Invite Routes

```bash
# POST /api/artists/{artistId}/invites/general
MSYS_NO_PATHCONV=1 aws apigatewayv2 create-route \
  --api-id qry0k6pmd0 \
  --route-key "POST /api/artists/{artistId}/invites/general" \
  --target "integrations/$INVITES_INTEGRATION_ID" \
  --query 'RouteId' \
  --output text

# POST /api/artists/{artistId}/invites/phone
MSYS_NO_PATHCONV=1 aws apigatewayv2 create-route \
  --api-id qry0k6pmd0 \
  --route-key "POST /api/artists/{artistId}/invites/phone" \
  --target "integrations/$INVITES_INTEGRATION_ID" \
  --query 'RouteId' \
  --output text

# GET /api/invites/{token}
MSYS_NO_PATHCONV=1 aws apigatewayv2 create-route \
  --api-id qry0k6pmd0 \
  --route-key "GET /api/invites/{token}" \
  --target "integrations/$INVITES_INTEGRATION_ID" \
  --query 'RouteId' \
  --output text

# POST /api/invites/{token}/accept
MSYS_NO_PATHCONV=1 aws apigatewayv2 create-route \
  --api-id qry0k6pmd0 \
  --route-key "POST /api/invites/{token}/accept" \
  --target "integrations/$INVITES_INTEGRATION_ID" \
  --query 'RouteId' \
  --output text

echo "✓ Invite routes created"
```

### 5.3: Add Lambda Permissions

```bash
# Allow API Gateway to invoke Invites Lambda
MSYS_NO_PATHCONV=1 aws lambda add-permission \
  --function-name bndy-serverless-api-InvitesFunction \
  --statement-id apigateway-invites-all \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:eu-west-2:771551874768:qry0k6pmd0/*/*"

echo "✓ Invites Lambda permissions added"
```

### 5.4: Create Phone Auth Routes

```bash
# Get Auth Lambda integration ID (already exists)
AUTH_INTEGRATION_ID=$(MSYS_NO_PATHCONV=1 aws apigatewayv2 get-routes \
  --api-id qry0k6pmd0 \
  --query "Items[?RouteKey=='GET /auth/google'].Target" \
  --output text | cut -d'/' -f2)

echo "Auth Integration ID: $AUTH_INTEGRATION_ID"

# POST /auth/phone/request-otp
MSYS_NO_PATHCONV=1 aws apigatewayv2 create-route \
  --api-id qry0k6pmd0 \
  --route-key "POST /auth/phone/request-otp" \
  --target "integrations/$AUTH_INTEGRATION_ID" \
  --query 'RouteId' \
  --output text

# POST /auth/phone/verify-otp
MSYS_NO_PATHCONV=1 aws apigatewayv2 create-route \
  --api-id qry0k6pmd0 \
  --route-key "POST /auth/phone/verify-otp" \
  --target "integrations/$AUTH_INTEGRATION_ID" \
  --query 'RouteId' \
  --output text

# POST /auth/phone/verify-and-onboard
MSYS_NO_PATHCONV=1 aws apigatewayv2 create-route \
  --api-id qry0k6pmd0 \
  --route-key "POST /auth/phone/verify-and-onboard" \
  --target "integrations/$AUTH_INTEGRATION_ID" \
  --query 'RouteId' \
  --output text

echo "✓ Phone auth routes created"
```

### 5.5: Verify All Routes

```bash
# List all routes
MSYS_NO_PATHCONV=1 aws apigatewayv2 get-routes \
  --api-id qry0k6pmd0 \
  --query "Items[?contains(RouteKey, 'invite') || contains(RouteKey, 'phone')].{Route:RouteKey,Integration:Target}" \
  --output table
```

Expected routes:
- POST /api/artists/{artistId}/invites/general
- POST /api/artists/{artistId}/invites/phone
- GET /api/invites/{token}
- POST /api/invites/{token}/accept
- POST /auth/phone/request-otp
- POST /auth/phone/verify-otp
- POST /auth/phone/verify-and-onboard

---

## Phase 6: Frontend Implementation

**Priority:** MEDIUM
**Duration:** 4-6 hours
**Dependencies:** Phase 5 (API routes must be live)

### 6.1: Complete Invite Page

Edit: `C:\VSProjects\bndy-backstage\client\src\pages\invite.tsx`

```typescript
import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import BndyLogo from "@/components/ui/bndy-logo";

export default function Invite() {
  const { token } = useParams();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  // Check if user is logged in
  useEffect(() => {
    const checkAuth = async () => {
      try {
        await apiRequest("GET", "/api/me");
        setIsLoggedIn(true);
      } catch {
        setIsLoggedIn(false);
      }
    };
    checkAuth();
  }, []);

  // Fetch invite details
  const { data: invite, isLoading, error } = useQuery({
    queryKey: ["invites", token],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/invites/${token}`);
      return response.json();
    },
    enabled: !!token
  });

  // Accept invite mutation
  const acceptMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", `/api/invites/${token}/accept`);
    },
    onSuccess: async (response) => {
      const data = await response.json();
      toast({
        title: "Invitation accepted!",
        description: `You've joined ${data.artist.name}`,
      });
      setLocation(`/artists/${data.artist.id}/calendar`);
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to accept invitation",
        variant: "destructive"
      });
    }
  });

  const handleAcceptInvite = () => {
    if (!isLoggedIn) {
      // Redirect to phone auth with return URL
      setLocation(`/auth/phone?returnUrl=/invite/${token}`);
      return;
    }
    acceptMutation.mutate();
  };

  const handleDecline = () => {
    setLocation("/");
  };

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center">
      <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-brand-accent"></div>
    </div>;
  }

  if (error || !invite) {
    return <div className="min-h-screen bg-gradient-subtle p-4 flex items-center justify-center">
      <div className="bg-white/90 backdrop-blur-sm rounded-xl p-6 shadow-lg max-w-md">
        <h1 className="text-2xl font-serif text-red-600 mb-4">Invalid Invite</h1>
        <p className="text-gray-600 mb-6">
          This invitation link is invalid or has expired.
        </p>
        <Button onClick={() => setLocation("/")} className="w-full">
          Go to Home
        </Button>
      </div>
    </div>;
  }

  return (
    <div className="min-h-screen bg-gradient-subtle p-4 flex items-center justify-center">
      <div className="max-w-md w-full text-center">
        <div className="mb-8">
          <div className="w-32 h-32 flex items-center justify-center mx-auto">
            <BndyLogo className="w-24 h-24" holeColor="rgb(51 65 85)" />
          </div>
        </div>

        <div className="bg-white/90 backdrop-blur-sm rounded-xl p-6 shadow-lg">
          <h1 className="text-2xl font-serif text-brand-primary mb-4">
            You've Been Invited!
          </h1>

          <p className="text-gray-600 mb-2">
            <strong>{invite.metadata.inviterName}</strong> invited you to join
          </p>
          <p className="text-xl font-serif text-brand-accent mb-4">
            {invite.metadata.artistName}
          </p>

          <p className="text-sm text-gray-500 mb-6">
            Expires in {Math.ceil((invite.expiresAt * 1000 - Date.now()) / (1000 * 60 * 60 * 24))} days
          </p>

          <div className="space-y-3">
            <Button
              onClick={handleAcceptInvite}
              disabled={acceptMutation.isPending}
              className="w-full bg-brand-accent hover:bg-brand-accent-light text-white py-3"
            >
              {acceptMutation.isPending ? "Accepting..." : "Accept Invitation"}
            </Button>

            <Button
              onClick={handleDecline}
              variant="ghost"
              className="w-full text-gray-600 hover:text-gray-800"
            >
              Not interested
            </Button>
          </div>

          {!isLoggedIn && (
            <div className="mt-4 text-xs text-gray-500 bg-gray-100 rounded p-2">
              You'll need to verify your phone number to join
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

### 6.2: Create Phone Auth Page

Create: `C:\VSProjects\bndy-backstage\client\src\pages\auth\phone.tsx`

```typescript
import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import BndyLogo from "@/components/ui/bndy-logo";

export default function PhoneAuth() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [step, setStep] = useState<"phone" | "otp" | "onboarding">("phone");
  const [phone, setPhone] = useState("+44");
  const [otp, setOtp] = useState("");
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [profile, setProfile] = useState({
    firstName: "",
    lastName: "",
    displayName: "",
    hometown: "",
    instrument: "Guitar"
  });

  // Get return URL from query params
  const returnUrl = new URLSearchParams(window.location.search).get("returnUrl") || "/dashboard";

  // Request OTP
  const requestOTPMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/auth/phone/request-otp", { phone });
    },
    onSuccess: () => {
      setStep("otp");
      toast({
        title: "Code sent!",
        description: `Enter the 6-digit code sent to ${phone}`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to send code",
        variant: "destructive"
      });
    }
  });

  // Verify OTP
  const verifyOTPMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/auth/phone/verify-otp", { phone, otp });
    },
    onSuccess: async (response) => {
      const data = await response.json();

      if (data.needsOnboarding) {
        setNeedsOnboarding(true);
        setStep("onboarding");
      } else {
        toast({ title: "Success!", description: "You're logged in" });
        setLocation(returnUrl);
      }
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Invalid code",
        variant: "destructive"
      });
    }
  });

  // Verify and onboard
  const onboardMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/auth/phone/verify-and-onboard", {
        phone,
        otp,
        profile
      });
    },
    onSuccess: () => {
      toast({ title: "Welcome!", description: "Your account is ready" });
      setLocation(returnUrl);
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to create account",
        variant: "destructive"
      });
    }
  });

  return (
    <div className="min-h-screen bg-gradient-subtle p-4 flex items-center justify-center">
      <div className="max-w-md w-full">
        <div className="mb-8 text-center">
          <div className="w-32 h-32 flex items-center justify-center mx-auto">
            <BndyLogo className="w-24 h-24" holeColor="rgb(51 65 85)" />
          </div>
        </div>

        <div className="bg-white/90 backdrop-blur-sm rounded-xl p-6 shadow-lg">
          {step === "phone" && (
            <>
              <h1 className="text-2xl font-serif text-brand-primary mb-4">
                Continue with Phone
              </h1>
              <p className="text-gray-600 mb-6">
                Enter your phone number to receive a verification code
              </p>
              <Input
                type="tel"
                placeholder="+44 7XXX XXX XXX"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="mb-4"
              />
              <Button
                onClick={() => requestOTPMutation.mutate()}
                disabled={requestOTPMutation.isPending || phone.length < 10}
                className="w-full"
              >
                {requestOTPMutation.isPending ? "Sending..." : "Send Code"}
              </Button>
            </>
          )}

          {step === "otp" && (
            <>
              <h1 className="text-2xl font-serif text-brand-primary mb-4">
                Enter Code
              </h1>
              <p className="text-gray-600 mb-6">
                We sent a 6-digit code to {phone}
              </p>
              <InputOTP
                maxLength={6}
                value={otp}
                onChange={setOtp}
                className="mb-4"
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
              <Button
                onClick={() => verifyOTPMutation.mutate()}
                disabled={verifyOTPMutation.isPending || otp.length !== 6}
                className="w-full"
              >
                {verifyOTPMutation.isPending ? "Verifying..." : "Verify"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setStep("phone")}
                className="w-full mt-2"
              >
                Change number
              </Button>
            </>
          )}

          {step === "onboarding" && (
            <>
              <h1 className="text-2xl font-serif text-brand-primary mb-4">
                Complete Your Profile
              </h1>
              <div className="space-y-4">
                <Input
                  placeholder="First Name"
                  value={profile.firstName}
                  onChange={(e) => setProfile({...profile, firstName: e.target.value})}
                />
                <Input
                  placeholder="Last Name"
                  value={profile.lastName}
                  onChange={(e) => setProfile({...profile, lastName: e.target.value})}
                />
                <Input
                  placeholder="Display Name"
                  value={profile.displayName}
                  onChange={(e) => setProfile({...profile, displayName: e.target.value})}
                />
                <Input
                  placeholder="Hometown"
                  value={profile.hometown}
                  onChange={(e) => setProfile({...profile, hometown: e.target.value})}
                />
                <select
                  value={profile.instrument}
                  onChange={(e) => setProfile({...profile, instrument: e.target.value})}
                  className="w-full p-2 border rounded"
                >
                  <option>Guitar</option>
                  <option>Bass</option>
                  <option>Drums</option>
                  <option>Vocals</option>
                  <option>Keyboard</option>
                  <option>Other</option>
                </select>
                <Button
                  onClick={() => onboardMutation.mutate()}
                  disabled={onboardMutation.isPending || !profile.firstName || !profile.displayName}
                  className="w-full"
                >
                  {onboardMutation.isPending ? "Creating..." : "Complete"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

### 6.3: Update App Routing

Edit: `C:\VSProjects\bndy-backstage\client\src\App.tsx`

Add the phone auth route:

```typescript
import PhoneAuth from "@/pages/auth/phone";

// In the router:
<Route path="/auth/phone" component={PhoneAuth} />
```

### 6.4: Update Login Page

Edit: `C:\VSProjects\bndy-backstage\client\src\pages\auth\login.tsx`

Add phone auth option alongside Google OAuth:

```typescript
<Button
  onClick={() => setLocation("/auth/phone")}
  variant="outline"
  className="w-full"
>
  <i className="fas fa-mobile-alt mr-2"></i>
  Continue with Phone
</Button>
```

---

## Phase 7: Testing & Validation

**Priority:** HIGH
**Duration:** 2-3 hours
**Dependencies:** All previous phases

### 7.1: Test Phone Authentication

**Test Case 1: New User Registration**
1. Open: https://backstage.bndy.co.uk/login
2. Click "Continue with Phone"
3. Enter phone: +447758240770
4. Click "Send Code"
5. Check SMS received
6. Enter 6-digit OTP
7. Complete profile form
8. Verify redirect to dashboard
9. Check session cookie set
10. Refresh page - should stay logged in

**Test Case 2: Existing User Login**
1. Logout
2. Go to /login
3. Click "Continue with Phone"
4. Enter same phone as registered
5. Enter OTP
6. Should redirect to dashboard immediately (no onboarding)

**Test Case 3: Invalid OTP**
1. Request OTP
2. Enter wrong code
3. Should show error
4. Try 3 times
5. Should be rate limited

**Test Case 4: Expired OTP**
1. Request OTP
2. Wait 6 minutes
3. Enter code
4. Should show "OTP expired"

### 7.2: Test Magic Link Invites

**Test Case 1: Phone-Specific Invite**
1. Login as band admin
2. Go to /admin (band settings)
3. Navigate to "Team Members" tab
4. Enter phone number: +447758240771
5. Click "Send Invite"
6. Check SMS received on that phone
7. Click link on phone
8. Should show invite page with band name
9. If not logged in, should prompt for phone verification
10. After verification, should auto-join band
11. Verify membership created in /admin

**Test Case 2: General Invite Link**
1. Login as band admin
2. Go to /admin → Team Members
3. Click "Generate Link"
4. Copy link
5. Share link (e.g., send to yourself)
6. Open link in incognito window
7. Should show invite page
8. Complete phone auth
9. Should join band automatically

**Test Case 3: Expired Invite**
1. Create invite
2. Manually update expiresAt in DynamoDB to past date
3. Try to access invite link
4. Should show "Invite expired" error

**Test Case 4: Already Member**
1. Create invite for band
2. Accept invite and join
3. Try to accept same invite again
4. Should show "Already a member" error

### 7.3: Test Google OAuth Still Works

**CRITICAL: Ensure existing auth not broken**

1. Logout completely
2. Clear all cookies
3. Go to /login
4. Click "Continue with Google"
5. Should redirect to Google
6. Complete Google OAuth
7. Should redirect to dashboard
8. Verify session cookie set
9. Refresh page - should stay logged in
10. Go to /profile - should show user data
11. Test all authenticated routes work

### 7.4: Test Edge Cases

**Test Case: Phone Format Validation**
- Try: "07758240770" (missing +44) → Should reject
- Try: "+447758240770" → Should accept
- Try: "+1234" (too short) → Should reject

**Test Case: Concurrent OTP Requests**
- Request OTP
- Immediately request another OTP
- Only latest OTP should work

**Test Case: Session Expiry**
- Login
- Manually expire JWT (change secret temporarily)
- Try to access /api/me
- Should get 401

---

## Phase 8: Security & Polish

**Priority:** MEDIUM
**Duration:** 2-3 hours
**Dependencies:** Phase 7 (testing complete)

### 8.1: Rate Limiting

**Implement in Auth Lambda:**

```javascript
// Rate limit OTP requests per phone
const RATE_LIMIT_TABLE = 'bndy-rate-limits';

const checkRateLimit = async (phone) => {
  const now = Date.now();
  const windowStart = now - (5 * 60 * 1000); // 5 minutes

  const result = await dynamodb.get({
    TableName: RATE_LIMIT_TABLE,
    Key: { identifier: `otp_${phone}` }
  }).promise();

  const limit = result.Item;

  if (limit && limit.count >= 3 && limit.windowStart > windowStart) {
    throw new Error('Too many requests. Try again in 5 minutes.');
  }

  // Update or create rate limit
  await dynamodb.put({
    TableName: RATE_LIMIT_TABLE,
    Item: {
      identifier: `otp_${phone}`,
      count: limit ? limit.count + 1 : 1,
      windowStart: limit?.windowStart || now,
      expiresAt: Math.floor(now / 1000) + 300 // TTL: 5 minutes
    }
  }).promise();
};
```

### 8.2: SMS Cost Monitoring

**Create CloudWatch Alarm:**

```bash
MSYS_NO_PATHCONV=1 aws cloudwatch put-metric-alarm \
  --alarm-name bndy-sns-high-spend \
  --alarm-description "Alert if SNS SMS spend exceeds £20" \
  --metric-name MonthToDateSpend \
  --namespace AWS/SNS \
  --statistic Maximum \
  --period 86400 \
  --evaluation-periods 1 \
  --threshold 20 \
  --comparison-operator GreaterThanThreshold \
  --alarm-actions arn:aws:sns:eu-west-2:771551874768:bndy-alerts
```

### 8.3: Audit Logging

**Log all invite events:**

```javascript
const logInviteEvent = async (eventType, inviteToken, userId, metadata) => {
  await dynamodb.put({
    TableName: 'bndy-audit-log',
    Item: {
      eventId: crypto.randomUUID(),
      eventType, // 'invite_created', 'invite_sent', 'invite_accepted'
      resourceType: 'invite',
      resourceId: inviteToken,
      userId,
      timestamp: new Date().toISOString(),
      metadata
    }
  }).promise();
};
```

### 8.4: Cleanup Lambda (Optional)

**Create Lambda to delete expired invites:**

```javascript
// Run daily via EventBridge schedule
exports.handler = async () => {
  const now = Math.floor(Date.now() / 1000);

  // Scan for expired invites
  const result = await dynamodb.scan({
    TableName: 'bndy-invites',
    FilterExpression: 'expiresAt < :now AND #status = :pending',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':now': now,
      ':pending': 'pending'
    }
  }).promise();

  // Mark as expired
  for (const invite of result.Items) {
    await dynamodb.update({
      TableName: 'bndy-invites',
      Key: { token: invite.token },
      UpdateExpression: 'SET #status = :expired',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':expired': 'expired' }
    }).promise();
  }

  console.log(`Marked ${result.Items.length} invites as expired`);
};
```

---

## Rollback Strategy

### If Phone Auth Breaks

**See: `AUTH_ROLLBACK_PROCEDURES.md`**

Quick rollback:
```bash
cd C:/VSProjects/bndy-serverless-api/auth-lambda
cp handler.PRODUCTION_GOOGLE_OAUTH_ONLY_BACKUP.js handler.js
zip -r rollback.zip handler.js node_modules/ package.json
MSYS_NO_PATHCONV=1 aws lambda update-function-code \
  --function-name bndy-serverless-api-AuthFunction-gKJksEC1lGjw \
  --zip-file fileb://rollback.zip
```

### If Invites Break

Delete problematic routes:
```bash
# List all invite routes
MSYS_NO_PATHCONV=1 aws apigatewayv2 get-routes \
  --api-id qry0k6pmd0 \
  --query "Items[?contains(RouteKey, 'invite')].{RouteId:RouteId,Route:RouteKey}" \
  --output json

# Delete specific route
MSYS_NO_PATHCONV=1 aws apigatewayv2 delete-route \
  --api-id qry0k6pmd0 \
  --route-id <route-id>
```

---

## Cost Estimates

### Monthly Costs (100 invites/month)

| Service | Usage | Cost |
|---------|-------|------|
| SNS SMS (UK) | 100 SMS @ £0.06 | £6.00 |
| Lambda (Auth) | 200 invocations, 128MB | £0.00 (free tier) |
| Lambda (Invites) | 100 invocations, 512MB | £0.00 (free tier) |
| DynamoDB (invites) | 100 writes, 100 reads | £0.00 (free tier) |
| DynamoDB (otp-codes) | 200 writes, 200 reads | £0.00 (free tier) |
| API Gateway | 400 requests | £0.00 (free tier) |
| **Total** | | **~£6-8/month** |

### Scaling (1000 invites/month)

| Service | Usage | Cost |
|---------|-------|------|
| SNS SMS | 1000 SMS @ £0.06 | £60.00 |
| Lambda | ~2500 invocations | £0.50 |
| DynamoDB | ~3000 ops | £0.75 |
| API Gateway | ~4000 requests | £0.15 |
| **Total** | | **~£61-65/month** |

---

## Success Criteria

✅ Implementation is successful when:

1. **Phone Auth Works**
   - Users can sign up with phone number
   - OTP codes sent via SMS within 10 seconds
   - OTP validation works correctly
   - Session cookies set properly
   - Users can login on subsequent visits

2. **Magic Links Work**
   - Admins can generate general invite links
   - Admins can send phone-specific invites
   - SMS messages received within 10 seconds
   - Invite links work on mobile and desktop
   - Accepting invite auto-joins user to band

3. **Google OAuth Still Works**
   - Existing Google login flow unaffected
   - No regressions in session management
   - All authenticated routes work

4. **Security**
   - Rate limiting prevents abuse
   - Invites expire after 7 days
   - OTP codes expire after 5 minutes
   - Max 3 OTP attempts per request

5. **User Experience**
   - SMS messages clear and well-formatted
   - Error messages helpful
   - Loading states visible
   - Mobile-friendly UI

---

## Deployment Checklist

### Pre-Deployment

- [ ] Auth Lambda backup created
- [ ] Rollback procedures documented
- [ ] All code reviewed
- [ ] Local testing complete (if possible)
- [ ] AWS SNS sandbox exited (CRITICAL)

### Phase 1: Infrastructure

- [ ] bndy-otp-codes table created
- [ ] bndy-invites table created
- [ ] phone-index added to bndy-users
- [ ] TTL enabled on tables

### Phase 2: Lambda Functions

- [ ] Invites Lambda deployed
- [ ] Auth Lambda updated with phone auth
- [ ] Both functions tested via console

### Phase 3: API Gateway

- [ ] Invite routes created
- [ ] Phone auth routes created
- [ ] Lambda permissions added
- [ ] Routes verified with curl

### Phase 4: Frontend

- [ ] Invite page completed
- [ ] Phone auth page created
- [ ] Login page updated
- [ ] All code committed to git

### Phase 5: Testing

- [ ] Phone auth tested (new user)
- [ ] Phone auth tested (existing user)
- [ ] Phone invite tested
- [ ] General invite tested
- [ ] Google OAuth verified still works
- [ ] Edge cases tested

### Phase 6: Monitoring

- [ ] CloudWatch alarms set up
- [ ] SMS cost monitoring enabled
- [ ] Audit logging implemented

### Post-Deployment

- [ ] Monitor CloudWatch logs for 24 hours
- [ ] Check SNS delivery reports
- [ ] Verify no spike in errors
- [ ] User feedback collected

---

## Emergency Contacts

**If critical issues arise:**

1. **Check CloudWatch Logs:**
   - /aws/lambda/bndy-serverless-api-AuthFunction-gKJksEC1lGjw
   - /aws/lambda/bndy-serverless-api-InvitesFunction

2. **Check SNS Delivery:**
   ```bash
   aws sns get-sms-attributes
   aws cloudwatch get-metric-statistics \
     --namespace AWS/SNS \
     --metric-name SMSSuccessRate \
     --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
     --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
     --period 3600 \
     --statistics Average
   ```

3. **Rollback if needed:**
   - See: AUTH_ROLLBACK_PROCEDURES.md

---

**Document Version:** 1.0
**Created:** 2025-10-11
**Last Updated:** 2025-10-11
**Status:** Ready for implementation

---

## Notes

- This is a comprehensive plan - implementation will take 15-20 hours total
- Phases can be done incrementally over several days
- Test thoroughly at each phase before proceeding
- Monitor closely after deployment
- Keep this document updated as implementation progresses
