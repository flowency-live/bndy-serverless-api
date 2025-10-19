# BNDY Agentic Event Ingestion - Week 1 POC

This is the **Proof of Concept** for the agentic event ingestion system.

## Goal

Prove that the deterministic scoring function works with real data before deploying to Lambda.

**Success Criteria:**
- 8/10 venues match correctly (80% accuracy)
- 0 false positives (no incorrect matches)

## Setup

1. **Install dependencies:**
```bash
npm install
```

2. **Configure environment variables:**

Copy `.env.example` to `.env` and add your API keys:
```bash
cp .env.example .env
```

Then edit `.env`:
```
OPENAI_API_KEY=sk-proj-...
GOOGLE_PLACES_API_KEY=AIza...
BNDY_API_BASE=https://api.bndy.co.uk
```

3. **Get API Keys:**

- **OpenAI:** https://platform.openai.com/api-keys
- **Google Places:** https://console.cloud.google.com/apis/credentials

## Run the POC

```bash
npm test
```

Or directly with node:
```bash
node --loader ts-node/esm extract-and-resolve.ts
```

## What It Does

1. Fetches HTML from `https://www.gigs-news.uk/stockport`
2. Extracts events using OpenAI (gpt-4o-mini)
3. Resolves first 10 venues using:
   - Google Places API lookup
   - BNDY database search
   - Deterministic scoring function
4. Outputs results to `poc-results.json`

## Expected Output

```
=== BNDY AGENTIC INGESTION POC ===

Fetching HTML from: https://www.gigs-news.uk/stockport
Fetched 45231 characters of HTML

=== STEP 1: LLM EXTRACTION ===
Extracted 25 events

First 5 extracted events:
1. The Smiths @ Queens Hotel Macclesfield on 2025-11-15
2. Oasis @ The Albert Halls on 2025-11-20
...

=== STEP 2: VENUE RESOLUTION ===
Testing with first 10 events...

[1/10] Processing: Queens Hotel Macclesfield
Result: MATCH_EXISTING (confidence: 0.95)

...

=== SUMMARY ===
Total tested: 10
MATCH_EXISTING: 7 (70%)
CREATE_NEW: 2 (20%)
REVIEW: 1 (10%)

Auto-approval rate: 7/10 (70%)
```

## Review Results

After the POC runs, review `poc-results.json` to verify:
- Did venues match correctly?
- Any false positives?
- Confidence scores reasonable?

## Architecture

- `schemas.ts` - Zod validation schemas and TypeScript types
- `llm-extraction.ts` - OpenAI extraction (LLM only for unstructured → structured)
- `venue-resolution.ts` - Deterministic scoring and matching (NO LLM)
- `extract-and-resolve.ts` - Main POC script

## Next Steps

If POC succeeds:
- Week 2: Deploy to Lambda
- Week 3: Build HITL review UI in Godmode
- Week 4: Production hardening + artist resolution
