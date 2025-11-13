// TypeScript-style JSDoc type definitions for notifications-lambda
// Following BNDY standards: NO push support in Phase 1

/**
 * Notification types supported by the system
 * @typedef {'song_added' | 'song_ready' | 'gig_added' | 'gig_removed' | 'rehearsal_added' | 'rehearsal_removed'} NotificationType
 */

/**
 * DynamoDB notification record
 * @typedef {Object} Notification
 * @property {string} id - UUID primary key
 * @property {string} user_id - Cognito ID (GSI partition key)
 * @property {string} artist_id - Artist UUID (GSI partition key)
 * @property {NotificationType} type - Notification type
 * @property {string} message - Human-readable message
 * @property {string} metadata - JSON string with additional data
 * @property {boolean} read - Read status
 * @property {boolean} dismissed - UI dismissal status
 * @property {string} created_at - ISO-8601 timestamp (GSI sort key)
 * @property {number} expires_at - Unix seconds for TTL (30 days)
 */

/**
 * Parsed metadata structure (stored as JSON string in DynamoDB)
 * @typedef {Object} NotificationMetadata
 * @property {string} [songId] - For song_added, song_ready
 * @property {string} [songTitle] - For song_added, song_ready
 * @property {string} [songArtist] - For song_added
 * @property {string} [eventId] - For gig_added, gig_removed, rehearsal_added, rehearsal_removed
 * @property {string} [venueName] - For gig_added, gig_removed
 * @property {string} [eventDate] - For gig_added, gig_removed, rehearsal_added, rehearsal_removed
 * @property {string} [startTime] - For rehearsal_added
 * @property {string} [performedByUserId] - User who triggered the notification
 * @property {string} [performedByName] - Display name of performer
 * @property {number} [count] - For grouped notifications (song_added)
 * @property {number} [voteCount] - For song_ready
 */

/**
 * Internal Lambda invocation payload (from events-lambda, songs-lambda)
 * @typedef {Object} CreateNotificationPayload
 * @property {'create'} action - Action type (always 'create')
 * @property {NotificationType} type - Notification type
 * @property {string} artistId - Artist UUID
 * @property {string} performedByUserId - User who performed the action
 * @property {string} performedByName - Display name of performer
 * @property {NotificationMetadata} metadata - Additional data
 */

/**
 * HTTP API Gateway v2 event structure
 * @typedef {Object} APIGatewayEvent
 * @property {Object} requestContext - Request context
 * @property {Object} requestContext.http - HTTP details
 * @property {string} requestContext.http.method - HTTP method
 * @property {string} requestContext.http.path - Request path
 * @property {Object} [headers] - HTTP headers
 * @property {string[]} [cookies] - HTTP cookies (v2 format)
 * @property {Object} [pathParameters] - Path parameters
 * @property {Object} [queryStringParameters] - Query string parameters
 * @property {string} [body] - Request body (JSON string)
 */

/**
 * JWT payload structure (after validation)
 * @typedef {Object} JWTPayload
 * @property {string} userId - Cognito user ID
 * @property {string} username - Username
 * @property {string} [email] - Email address
 * @property {number} issuedAt - Unix timestamp
 */

/**
 * HTTP response structure
 * @typedef {Object} HTTPResponse
 * @property {number} statusCode - HTTP status code
 * @property {Object} headers - Response headers
 * @property {string} body - Response body (JSON string)
 */

/**
 * GET /api/notifications query parameters
 * @typedef {Object} GetNotificationsQuery
 * @property {string} [artistId] - Filter by artist ID
 * @property {number} [limit] - Max records to return (default 50)
 * @property {string} [lastEvaluatedKey] - Pagination token
 */

/**
 * GET /api/notifications response
 * @typedef {Object} GetNotificationsResponse
 * @property {Notification[]} notifications - Array of notifications
 * @property {string} [lastEvaluatedKey] - Pagination token for next page
 * @property {number} count - Number of notifications returned
 */

/**
 * POST /api/notifications/mark-all-read response
 * @typedef {Object} MarkAllReadResponse
 * @property {number} count - Number of notifications marked as read
 */

/**
 * Error response structure
 * @typedef {Object} ErrorResponse
 * @property {string} error - Error message
 */

module.exports = {};
