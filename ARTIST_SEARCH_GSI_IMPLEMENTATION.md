# Artist Search GSI Implementation Plan

## Problem
Artist search uses `dynamodb.scan()` which reads ALL artists from the table on every search. With 200 artists this takes 2-3 seconds. Will scale poorly.

## Solution
Replace Scan with Query using a Global Secondary Index (GSI).

## Implementation Steps

### 1. Create GSI (AWS Console or CLI)
```bash
# Run from serverless-api root
bash scripts/create-artist-search-gsi.sh
```

Or manually via AWS Console:
- Table: `bndy-artists`
- Index name: `name-search-index`
- Partition key: `name_prefix` (String) - first 2 letters of lowercase name
- Sort key: `name_lower` (String) - full lowercase name
- Projection: ALL
- Billing: PAY_PER_REQUEST

### 2. Update Lambda to Populate GSI Fields

Add helper function to `handler.js`:
```javascript
// Generate GSI fields for fast name search
function generateNameSearchFields(name) {
  const nameLower = name.toLowerCase().trim();
  const namePrefix = nameLower.substring(0, 2);
  return { name_lower: nameLower, name_prefix: namePrefix };
}
```

Update `handleCreateArtist` (line ~420):
```javascript
const artist = {
  id: artistId,
  name: artistData.name,
  ...generateNameSearchFields(artistData.name),  // ADD THIS LINE
  bio: artistData.bio || '',
  // ... rest of fields
};
```

Update `handleCreateCommunityArtist` (line ~1040):
```javascript
const newArtist = {
  id: artistId,
  name: name.trim(),
  ...generateNameSearchFields(name.trim()),  // ADD THIS LINE
  location: location.trim(),
  // ... rest of fields
};
```

Update `handleUpdateArtist` (line ~546):
```javascript
if (artistData.name !== undefined) {
  const searchFields = generateNameSearchFields(artistData.name);
  updateParts.push('#name = :name', 'name_lower = :name_lower', 'name_prefix = :name_prefix');
  expressionAttributeValues[':name'] = artistData.name;
  expressionAttributeValues[':name_lower'] = searchFields.name_lower;
  expressionAttributeValues[':name_prefix'] = searchFields.name_prefix;
}
```

### 3. Update Search Function (ALREADY DONE)
`handleSearchArtists` (line 918) has been updated to use GSI Query instead of Scan.

### 4. Backfill Existing Artists

Run this script AFTER GSI is created and Lambda is deployed:
```javascript
// scripts/backfill-artist-search-fields.js
const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

async function backfillSearchFields() {
  console.log('Fetching all artists...');
  const result = await dynamodb.scan({ TableName: 'bndy-artists' }).promise();

  console.log(`Updating ${result.Items.length} artists with search fields...`);

  for (const artist of result.Items) {
    const nameLower = artist.name.toLowerCase().trim();
    const namePrefix = nameLower.substring(0, 2);

    await dynamodb.update({
      TableName: 'bndy-artists',
      Key: { id: artist.id },
      UpdateExpression: 'SET name_lower = :name_lower, name_prefix = :name_prefix',
      ExpressionAttributeValues: {
        ':name_lower': nameLower,
        ':name_prefix': namePrefix
      }
    }).promise();

    console.log(`Updated: ${artist.name}`);
  }

  console.log('Backfill complete!');
}

backfillSearchFields().catch(console.error);
```

## Performance Impact

### Before (Scan):
- Reads: ALL items in table (~200 RCU for 200 artists)
- Latency: 2-3 seconds
- Cost: Scales linearly with table size
- Scalability: Poor (10x artists = 10x cost & latency)

### After (GSI Query):
- Reads: ~10-20 items per search
- Latency: 100-200ms
- Cost: Fixed per search regardless of table size
- Scalability: Excellent (10x artists = same cost & latency)

## Testing

1. Create GSI (wait 5-10 min for ACTIVE status)
2. Deploy updated Lambda
3. Run backfill script
4. Test search: `curl "https://api.bndy.co.uk/api/artists/search?name=the"`
5. Check CloudWatch logs for "using GSI Query" message

## Rollback Plan

If GSI causes issues:
1. Revert `handleSearchArtists` to use Scan (git revert)
2. Delete GSI via AWS Console (won't affect existing data)
3. No data loss - `name_lower` and `name_prefix` fields harmless

## Future Enhancements

When artist count exceeds 5000, consider:
- Amazon OpenSearch for full-text fuzzy search
- Algolia for advanced search features
- DynamoDB Streams + Lambda to keep search index synced