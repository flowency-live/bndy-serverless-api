# WAF Configuration for Community Wizard Routes

## Overview

Rate-based WAF rules protect the unauthenticated community wizard endpoints from abuse.
The `/api/community/*` namespace is the single explicit unauthenticated surface (SEC-COMMUNITY).

## Protected Routes

### Community Namespace (SEC-COMMUNITY)

| Route | Method | Lambda | Purpose | Rate Limit |
|-------|--------|--------|---------|------------|
| `/api/community/artists/find-or-create` | POST | ArtistsFunction | Artist resolution | 5/min, 50/day |
| `/api/community/venues/find-or-create` | POST | VenuesFunction | Venue resolution | 5/min, 50/day |
| `/api/community/events` | POST | EventsFunction | Create community event | 5/min, 50/day |
| `/api/community/places/autocomplete` | GET | VenuesFunction | Places proxy | 60/min |
| `/api/community/places/details` | GET | VenuesFunction | Places proxy | 60/min |

### Legacy Routes (backwards compatibility)

| Route | Method | Lambda | Purpose | Rate Limit |
|-------|--------|--------|---------|------------|
| `/api/places/suggest` | GET | VenuesFunction | Google Places autocomplete proxy | 60/min |
| `/api/places/details` | GET | VenuesFunction | Google Places details proxy | 60/min |
| `/api/artists/find-or-create` | POST | ArtistsFunction | Artist resolution | 5/min, 50/day |
| `/api/artists/community` | POST | ArtistsFunction | Create community artist | 5/min, 50/day |
| `/api/venues/find-or-create` | POST | VenuesFunction | Venue resolution | 5/min, 50/day |
| `/api/events/community` | POST | EventsFunction | Create community event | 5/min, 50/day |

## Rate Limit Strategy (CTO-approved)

Split reads from writes to not strangle the UX:

| Category | Limit | Rationale |
|----------|-------|-----------|
| Mutations (POSTs) | 5/min + 50/day per IP | No human lists > 5 gigs/min; band tour stays comfortable |
| Places proxy (GETs) | 60/min per IP | Autocomplete fires on keystrokes |
| Blanket (all) | 100 req/5min per IP | Outer wall, existing WebACL |

## Required WAF Rules

### Rule 1: Community Mutations Rate Limit (5/min)

```yaml
Name: CommunityMutationRateLimit
Priority: 1
Statement:
  RateBasedStatement:
    Limit: 300  # 5 per minute = 300 per 5-minute window
    AggregateKeyType: IP
    ScopeDownStatement:
      OrStatement:
        Statements:
          # Community namespace
          - ByteMatch: /api/community/artists/find-or-create (POST)
          - ByteMatch: /api/community/venues/find-or-create (POST)
          - ByteMatch: /api/community/events (POST)
          # Legacy routes
          - ByteMatch: /api/artists/find-or-create (POST)
          - ByteMatch: /api/artists/community (POST)
          - ByteMatch: /api/venues/find-or-create (POST)
          - ByteMatch: /api/events/community (POST)
Action: Block
```

### Rule 2: Places Proxy Rate Limit (60/min)

```yaml
Name: PlacesProxyRateLimit
Priority: 2
Statement:
  RateBasedStatement:
    Limit: 300  # 60 per minute = 300 per 5-minute window
    AggregateKeyType: IP
    ScopeDownStatement:
      OrStatement:
        Statements:
          - ByteMatch: /api/community/places/ (STARTS_WITH)
          - ByteMatch: /api/places/ (STARTS_WITH)
Action: Block
```

### Rule 3: Blanket Rate Limit (existing)

```yaml
Name: BlanketRateLimit
Priority: 3
Statement:
  RateBasedStatement:
    Limit: 100  # 100 per 5 minutes
    AggregateKeyType: IP
Action: Block
```

## AWS CLI Setup Commands

```bash
# 1. Create WebACL with rate-based rules
aws wafv2 create-web-acl \
  --name bndy-community-wizard-waf \
  --scope REGIONAL \
  --default-action Allow={} \
  --rules '[
    {
      "Name": "CommunityMutationRateLimit",
      "Priority": 1,
      "Statement": {
        "RateBasedStatement": {
          "Limit": 300,
          "AggregateKeyType": "IP",
          "ScopeDownStatement": {
            "OrStatement": {
              "Statements": [
                {"ByteMatchStatement": {"SearchString": "/api/community/artists/find-or-create", "FieldToMatch": {"UriPath": {}}, "TextTransformations": [{"Priority": 0, "Type": "NONE"}], "PositionalConstraint": "EXACTLY"}},
                {"ByteMatchStatement": {"SearchString": "/api/community/venues/find-or-create", "FieldToMatch": {"UriPath": {}}, "TextTransformations": [{"Priority": 0, "Type": "NONE"}], "PositionalConstraint": "EXACTLY"}},
                {"ByteMatchStatement": {"SearchString": "/api/community/events", "FieldToMatch": {"UriPath": {}}, "TextTransformations": [{"Priority": 0, "Type": "NONE"}], "PositionalConstraint": "EXACTLY"}},
                {"ByteMatchStatement": {"SearchString": "/api/artists/find-or-create", "FieldToMatch": {"UriPath": {}}, "TextTransformations": [{"Priority": 0, "Type": "NONE"}], "PositionalConstraint": "EXACTLY"}},
                {"ByteMatchStatement": {"SearchString": "/api/artists/community", "FieldToMatch": {"UriPath": {}}, "TextTransformations": [{"Priority": 0, "Type": "NONE"}], "PositionalConstraint": "EXACTLY"}},
                {"ByteMatchStatement": {"SearchString": "/api/venues/find-or-create", "FieldToMatch": {"UriPath": {}}, "TextTransformations": [{"Priority": 0, "Type": "NONE"}], "PositionalConstraint": "EXACTLY"}},
                {"ByteMatchStatement": {"SearchString": "/api/events/community", "FieldToMatch": {"UriPath": {}}, "TextTransformations": [{"Priority": 0, "Type": "NONE"}], "PositionalConstraint": "EXACTLY"}}
              ]
            }
          }
        }
      },
      "Action": {"Block": {}},
      "VisibilityConfig": {"SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "CommunityMutationRateLimit"}
    },
    {
      "Name": "PlacesProxyRateLimit",
      "Priority": 2,
      "Statement": {
        "RateBasedStatement": {
          "Limit": 300,
          "AggregateKeyType": "IP",
          "ScopeDownStatement": {
            "OrStatement": {
              "Statements": [
                {"ByteMatchStatement": {"SearchString": "/api/community/places/", "FieldToMatch": {"UriPath": {}}, "TextTransformations": [{"Priority": 0, "Type": "NONE"}], "PositionalConstraint": "STARTS_WITH"}},
                {"ByteMatchStatement": {"SearchString": "/api/places/", "FieldToMatch": {"UriPath": {}}, "TextTransformations": [{"Priority": 0, "Type": "NONE"}], "PositionalConstraint": "STARTS_WITH"}}
              ]
            }
          }
        }
      },
      "Action": {"Block": {}},
      "VisibilityConfig": {"SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "PlacesProxyRateLimit"}
    },
    {
      "Name": "BlanketRateLimit",
      "Priority": 3,
      "Statement": {
        "RateBasedStatement": {
          "Limit": 100,
          "AggregateKeyType": "IP"
        }
      },
      "Action": {"Block": {}},
      "VisibilityConfig": {"SampledRequestsEnabled": true, "CloudWatchMetricsEnabled": true, "MetricName": "BlanketRateLimit"}
    }
  ]' \
  --visibility-config SampledRequestsEnabled=true,CloudWatchMetricsEnabled=true,MetricName=BndyCommunityWizardWAF \
  --region eu-west-2

# 2. Associate WebACL with API Gateway
aws wafv2 associate-web-acl \
  --web-acl-arn {WebACL-ARN-from-step-1} \
  --resource-arn arn:aws:apigateway:eu-west-2::/apis/{BndyHttpApi-id}/stages/$default \
  --region eu-west-2
```

## Daily Limit Implementation Note

WAF rate-based rules only support 5-minute windows (minimum). The 50/day per IP limit for mutations requires either:

1. **CloudFront + Lambda@Edge** - Count mutations per IP in DynamoDB, reject if > 50
2. **Application-level check** - Query DynamoDB for daily mutation count per IP before processing
3. **Accept the 5/min limit alone** - For day one, the 5/min limit (300/5min) provides meaningful protection

**CTO Decision:** Start with 5/min WAF rule. Add daily limit if abuse appears in review queue.

## Recording the WebACL ARN

After creation, record the WebACL ARN here:

```
WebACL ARN: [TO BE FILLED AFTER DEPLOYMENT]
Created: [DATE]
Associated API: BndyHttpApi
```

## Anti-Bot Controls (Application-Level)

In addition to WAF, the `/api/community/events` endpoint has:

- **Honeypot field (`hp`)** - Hidden field, bots fill it, silent reject
- **Time-trap (`startedAt`)** - Form submitted < 3s after step 1 = silent reject
- **Turnstile (escalation)** - Pre-approved if abuse appears, invisible mode

## Monitoring

- CloudWatch metrics: `BndyCommunityWizardWAF` namespace
- Metrics: `CommunityMutationRateLimit`, `PlacesProxyRateLimit`, `BlanketRateLimit`
- Alert threshold: Consider alerting if block rate > 50/hour

## References

- CTO ruling on rate limits (2026-08-07)
- SEC-COMMUNITY namespace decision
