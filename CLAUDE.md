# BNDY Serverless API

BNDY backend - 16 Lambda functions serving 115+ API routes.

## Quick Links

- [Deployment Guide](docs/deployment.md) - Lambda function mapping and deployment commands
- [Deployment Guardrails](docs/DEPLOYMENT-GUARDRAILS.md) - **MUST READ before any deployment**
- [Post-Mortem](docs/2026-05-01-production-incident-postmortem.md) - Learn from the 2026-05-01 disaster
- [Agent Charter](.claude/agent-charter.yaml) - Agent boundaries
- [Global Protocols](C:\VSProjects\CLAUDE.md) - TDD and development rules

---

## DEPLOYMENT RULES (NON-NEGOTIABLE)

> After the 2026-05-01 incident that broke production for 6-8 hours, these rules are MANDATORY.

### Before ANY Deployment

```bash
# ALWAYS run these before deploying
node scripts/validate-deployment.js
node scripts/verify-routes.js
```

### The 5 Deployment Rules

1. **NEVER deploy without validation** - Run `npm run validate` first
2. **NEVER rely on Lambda layers for dependencies** - All runtime deps in package.json
3. **NEVER exceed 25 routes per Lambda** - Split if necessary
4. **NEVER leave backup files in Lambda folders** - Use `.samignore`
5. **NEVER add routes without verifying handler exists**

### Size Limits

| Resource | Limit | Action if Exceeded |
|----------|-------|-------------------|
| Lambda unzipped | 262 MB | Clean backup files, check node_modules |
| Lambda policy | 20 KB | Split Lambda (max ~25 routes each) |
| Safe Lambda size | 250 MB | Warning threshold |

### Route-to-Lambda Mapping

Routes MUST point to correct Lambda:
- `/api/artists/{id}/members` → MembershipsFunction
- `/api/artists/{id}/crm/*` → VenueCRMFunction
- `/api/calendar/*` → CalendarFunction
- `/api/events/*` → EventsFunction

---

## Key Architecture

- **API Gateway**: `qry0k6pmd0` (SAM-managed)
- **Custom Domain**: `api.bndy.co.uk`
- **Lambda Pattern**: `bndy-serverless-api-{Service}Function-{hash}`

## MCP Integration

Unauthenticated `/mcp` routes for BNDY MCP Server:
- `PUT /api/artists/{id}/mcp`
- `PUT /api/events/{id}/mcp`
- `GET /api/*/by-external-id`
