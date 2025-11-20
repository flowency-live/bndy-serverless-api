# Venue Enrichment Script

This script enriches all venues in `bndy-venues` DynamoDB table with data from Google Places API.

## What It Does

For each venue with a `google_place_id`, the script:
1. Fetches place details from Google Places API
2. Extracts:
   - **City** (postal_town → locality → administrative_area_level_2)
   - **Phone** (formatted_phone_number)
   - **Website** (website URL)
3. Updates the venue in DynamoDB

## Features

✅ **Batched Processing**: Processes 50 venues per batch
✅ **Rate Limited**: 5 requests/second (respects Google's 10/sec limit)
✅ **Smart Skipping**: Skips venues that already have all data
✅ **Error Handling**: Continues on errors, reports at end
✅ **Progress Tracking**: Real-time progress updates
✅ **Cost Efficient**: Only fetches fields we need (`address_components`, `formatted_phone_number`, `website`)

## Requirements

- AWS credentials configured (for DynamoDB access)
- Node.js 18+
- Internet connection (for Google Places API)

## Cost Estimate

- **API**: Place Details API = $0.017 per call
- **Estimated venues**: ~367 with Google Place IDs
- **Estimated cost**: ~$6.24
- **Actual cost**: Lower (script skips venues that already have all data)

## Usage

```bash
# Navigate to scripts directory
cd /c/VSProjects/bndy-serverless-api/scripts

# Run the enrichment script
node enrich-venues-from-google.js
```

## What to Expect

```
============================================
BNDY Venues Enrichment from Google Places
============================================

Batch size: 50 venues
Rate limit: 5 requests/second
Delay between batches: 5000ms

Fetching all venues from DynamoDB...

Found 367 venues with Google Place IDs

Starting enrichment...

========== BATCH 1/8 (50 venues) ==========

[1] Processing: Queens Hotel (abc123)
  ✅ Enriched: city, phone, website

[2] Processing: Prince of Wales (def456)
  ✅ Enriched: city, phone

[3] Processing: Murphys Pub & Kitchen (ghi789)
  ⏭️  Skipped: Already has city, phone, and website

...

⏸️  Waiting 5000ms before next batch...

========== BATCH 2/8 (50 venues) ==========

...

============================================
ENRICHMENT COMPLETE
============================================

Total venues processed: 367
✅ Successfully enriched: 340
⏭️  Skipped: 20
❌ Failed: 7

Errors:
  1. Old Closed Pub (xyz789): Place not found

============================================
```

## Time Estimate

- **367 venues** × **200ms** = ~73 seconds for API calls
- **7 batches** × **5 seconds** = 35 seconds between batches
- **Total time**: ~2 minutes

## Safety Features

1. **No overwrites**: Only updates missing fields
2. **Rate limiting**: Stays well under Google's limits
3. **Error recovery**: Continues even if some venues fail
4. **Dry-run ready**: Easy to add `--dry-run` flag if needed

## After Running

New venues created via Google Places will automatically get city/phone/website.
This script is only needed once to backfill existing venues.

## Troubleshooting

**"Rate limit exceeded"**
- Increase `DELAY_BETWEEN_REQUESTS` to 500ms (2 requests/sec)

**"Place not found"**
- Normal for old/closed venues
- These will be logged but script continues

**"AWS credentials not found"**
- Run `aws configure` or set AWS environment variables