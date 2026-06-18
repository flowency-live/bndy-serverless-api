/**
 * Notification Utilities for Events Lambda
 *
 * Handles triggering notifications to artist members via Lambda.
 * Dependencies injected via deps object for testability.
 */

// Configuration
const USERS_TABLE = 'bndy-users';
const MEMBERSHIPS_TABLE = 'bndy-artist-memberships';

/**
 * Trigger notification via NotificationsFunction
 * Sends notifications to all artist members except the performer.
 *
 * @param {Object} deps - Dependencies { dynamodb, lambda }
 * @param {string} type - Notification type (e.g., 'event_created', 'event_updated')
 * @param {string} artistId - Artist ID
 * @param {string} userId - User ID who performed the action
 * @param {Object} metadata - Additional notification metadata
 * @returns {Promise<void>}
 */
async function triggerNotification(deps, type, artistId, userId, metadata) {
  const { dynamodb, lambda } = deps;
  const notificationsFunctionName = process.env.NOTIFICATIONS_FUNCTION_NAME;

  if (!notificationsFunctionName) {
    console.log('[NOTIFICATION] NOTIFICATIONS_FUNCTION_NAME not configured, skipping notification');
    return;
  }

  try {
    // Get performer name
    const userResult = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { cognito_id: userId }
    }).promise();

    const performedByName = userResult.Item?.display_name ||
                           userResult.Item?.first_name ||
                           'Unknown User';

    // Query all artist members
    const membershipsResult = await dynamodb.query({
      TableName: MEMBERSHIPS_TABLE,
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      ExpressionAttributeValues: {
        ':artistId': artistId
      }
    }).promise();

    // Filter out the performer - they shouldn't get notified about their own action
    const recipients = (membershipsResult.Items || [])
      .filter(member => member.user_id !== userId)
      .map(member => member.user_id);

    console.log('[NOTIFICATION] Triggering notification:', {
      type,
      artistId: artistId.substring(0, 8) + '...',
      recipientCount: recipients.length
    });

    // Create notification for each recipient
    for (const recipientUserId of recipients) {
      const payload = {
        action: 'create',
        type: type,
        priority: 'normal',
        artistId: artistId,
        performedByUserId: userId,
        performedByName: performedByName,
        recipientUserId: recipientUserId,
        metadata: metadata
      };

      await lambda.invoke({
        FunctionName: notificationsFunctionName,
        InvocationType: 'Event',
        Payload: JSON.stringify(payload)
      }).promise();
    }

    console.log('[NOTIFICATION] Notifications triggered successfully for', recipients.length, 'recipients');
  } catch (error) {
    console.error('[NOTIFICATION] Failed to trigger notification (non-blocking):', error.message);
  }
}

module.exports = {
  triggerNotification,
  USERS_TABLE,
  MEMBERSHIPS_TABLE
};
