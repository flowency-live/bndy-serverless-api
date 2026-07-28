# Venue Enrichment Lambda

Simple AI-based venue social media enrichment using Claude API.

## Purpose

This Lambda replaces ~1,430 lines of complex programmatic scraping/parsing code with a simple approach: **Ask Claude to find the venue's social media**.

## How It Works

1. Receives a `venueId` in the request body
2. Fetches venue data from DynamoDB
3. Asks Claude API: "Find the Facebook page and website for this venue"
4. Updates venue in DynamoDB if Claude is confident (HIGH confidence only)

## Cost

- ~$0.01-0.03 per venue
- Much cheaper than building/maintaining complex scraping infrastructure
- More reliable than programmatic matching

## API

**Request:**
```json
POST /api/admin/venues/enrich
{
  "venueId": "some-uuid"
}
```

**Response:**
```json
{
  "success": true,
  "venueId": "some-uuid",
  "enrichmentData": {
    "facebook": "https://facebook.com/venue",
    "website": "https://venue.com",
    "confidence": "HIGH",
    "notes": "Found official Facebook page and website"
  },
  "updated": true
}
```

## Environment Variables

- `ANTHROPIC_API_KEY` - Claude API key

## Deployment

```bash
cd venue-enrichment-lambda
npm install
zip -r function.zip .
aws lambda update-function-code \
  --function-name venue-enrichment-lambda \
  --zip-file fileb://function.zip \
  --region eu-west-2
```

## Integration Points

Can be triggered from:
- Godmode "Enrich" button
- Background job after venue creation
- Manual batch enrichment script

## Why This Approach?

Previous attempts used complex programmatic logic:
- Web scraping
- HTML parsing
- Fuzzy matching algorithms
- Confidence scoring systems

All of these were **solving the wrong problem**. We don't need code to determine if a Facebook page matches a venue - we need AI to make that judgment.

The simple solution: Let Claude do what Claude is good at.
