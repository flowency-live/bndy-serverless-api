# DynamoDB Schema for bndy-notifications

## Table: bndy-notifications

### Primary Key
- **Partition Key**: `id` (String) - UUID

### Global Secondary Indexes (GSI)

#### 1. user_id-index
- **Partition Key**: `user_id` (String) - Cognito user ID
- **Sort Key**: `created_at` (String) - ISO-8601 timestamp
- **Purpose**: Query all notifications for a user, sorted by creation time
- **Projection**: ALL

#### 2. artist_id-index
- **Partition Key**: `artist_id` (String) - Artist UUID
- **Sort Key**: `created_at` (String) - ISO-8601 timestamp
- **Purpose**: Query notifications by artist for grouping logic
- **Projection**: ALL

### Attributes

| Attribute | Type | Required | Description |
|-----------|------|----------|-------------|
| id | String | Yes | Primary key (UUID) |
| user_id | String | Yes | Cognito user ID (GSI partition key) |
| artist_id | String | Yes | Artist UUID (GSI partition key) |
| type | String | Yes | Notification type (song_added, song_ready, gig_added, etc.) |
| message | String | Yes | Human-readable notification message |
| metadata | String | Yes | JSON string with additional data |
| read | Boolean | Yes | Read status (false by default) |
| dismissed | Boolean | Yes | UI dismissal status (false by default) |
| created_at | String | Yes | ISO-8601 timestamp (GSI sort key) |
| updated_at | String | Yes | ISO-8601 timestamp |
| expires_at | Number | Yes | Unix seconds for TTL (30 days from creation) |

### TTL Configuration
- **Attribute**: `expires_at`
- **Duration**: 30 days from creation
- **Purpose**: Automatic deletion of old notifications

### AWS CLI Commands

#### Create Table
```bash
aws dynamodb create-table \
  --table-name bndy-notifications \
  --attribute-definitions \
    AttributeName=id,AttributeType=S \
    AttributeName=user_id,AttributeType=S \
    AttributeName=artist_id,AttributeType=S \
    AttributeName=created_at,AttributeType=S \
  --key-schema \
    AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region eu-west-2
```

#### Create user_id-index GSI
```bash
aws dynamodb update-table \
  --table-name bndy-notifications \
  --attribute-definitions \
    AttributeName=user_id,AttributeType=S \
    AttributeName=created_at,AttributeType=S \
  --global-secondary-index-updates \
    "[{
      \"Create\": {
        \"IndexName\": \"user_id-index\",
        \"KeySchema\": [
          {\"AttributeName\": \"user_id\", \"KeyType\": \"HASH\"},
          {\"AttributeName\": \"created_at\", \"KeyType\": \"RANGE\"}
        ],
        \"Projection\": {\"ProjectionType\": \"ALL\"}
      }
    }]" \
  --region eu-west-2
```

#### Create artist_id-index GSI
```bash
aws dynamodb update-table \
  --table-name bndy-notifications \
  --attribute-definitions \
    AttributeName=artist_id,AttributeType=S \
    AttributeName=created_at,AttributeType=S \
  --global-secondary-index-updates \
    "[{
      \"Create\": {
        \"IndexName\": \"artist_id-index\",
        \"KeySchema\": [
          {\"AttributeName\": \"artist_id\", \"KeyType\": \"HASH\"},
          {\"AttributeName\": \"created_at\", \"KeyType\": \"RANGE\"}
        ],
        \"Projection\": {\"ProjectionType\": \"ALL\"}
      }
    }]" \
  --region eu-west-2
```

#### Enable TTL
```bash
aws dynamodb update-time-to-live \
  --table-name bndy-notifications \
  --time-to-live-specification \
    "Enabled=true,AttributeName=expires_at" \
  --region eu-west-2
```

### Sample Item

```json
{
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "user_id": "us-east-1:12345678-1234-1234-1234-123456789abc",
  "artist_id": "a1b2c3d4-5678-90ab-cdef-1234567890ab",
  "type": "song_added",
  "message": "John Doe added \"Wonderwall\" to the setlist",
  "metadata": "{\"songId\":\"s123\",\"songTitle\":\"Wonderwall\",\"performedByUserId\":\"user-456\",\"performedByName\":\"John Doe\"}",
  "read": false,
  "dismissed": false,
  "created_at": "2025-11-12T21:00:00.000Z",
  "updated_at": "2025-11-12T21:00:00.000Z",
  "expires_at": 1734134400
}
```

### Notification Types

| Type | Description | Grouping |
|------|-------------|----------|
| song_added | Song added to setlist | Yes (5-minute window) |
| song_ready | Song ready to perform (vote threshold met) | No |
| gig_added | Gig added to calendar | No |
| gig_removed | Gig removed from calendar | No |
| rehearsal_added | Rehearsal added to calendar | No |
| rehearsal_removed | Rehearsal removed from calendar | No |

### Access Patterns

1. **Get all notifications for user** (sorted by newest first)
   - Query: `user_id-index` with `user_id = :userId`
   - Sort: Descending by `created_at`

2. **Get notifications for user filtered by artist**
   - Query: `user_id-index` with `user_id = :userId`
   - Filter: `artist_id = :artistId`

3. **Check for recent song_added notifications (grouping)**
   - Query: `artist_id-index` with `artist_id = :artistId` and `type = song_added`
   - Limit: 1 (most recent)
   - Check if `created_at` is within 5 minutes

4. **Mark notification as read**
   - Update: `id` with `read = true`

5. **Delete notification**
   - Delete: `id`

6. **Mark all unread as read**
   - Query: `user_id-index` with `user_id = :userId` and `read = false`
   - Update: Each item with `read = true`
