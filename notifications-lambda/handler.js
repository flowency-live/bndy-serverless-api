const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const dynamodb = new AWS.DynamoDB.DocumentClient();
const TABLE_NAME = process.env.NOTIFICATIONS_TABLE || 'bndy-notifications';
const JWT_SECRET = process.env.JWT_SECRET;
const GROUPING_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const TTL_DAYS = 30;

function buildResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true,
    },
    body: JSON.stringify(body),
  };
}

function extractJWT(event) {
  const cookies = event.cookies || [];
  const authCookie = cookies.find(c => c.startsWith('bndy_session=') || c.startsWith('session='));
  if (!authCookie) return null;
  return authCookie.split('=')[1];
}

function requireAuth(event) {
  const token = extractJWT(event);
  if (!token) {
    throw new Error('No authorization token provided');
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded;
  } catch (error) {
    throw new Error('Invalid token: ' + error.message);
  }
}

async function getNotifications(event, user) {
  const artistId = event.queryStringParameters?.artistId;
  const limit = parseInt(event.queryStringParameters?.limit || '50', 10);

  const params = {
    TableName: TABLE_NAME,
    IndexName: 'user_id-index',
    KeyConditionExpression: 'user_id = :userId',
    ExpressionAttributeValues: {
      ':userId': user.userId,
    },
    Limit: limit,
    ScanIndexForward: false,
  };

  if (artistId) {
    params.FilterExpression = 'artist_id = :artistId';
    params.ExpressionAttributeValues[':artistId'] = artistId;
  }

  const result = await dynamodb.query(params).promise();

  return buildResponse(200, {
    notifications: result.Items || [],
    count: result.Items?.length || 0,
    lastEvaluatedKey: result.LastEvaluatedKey,
  });
}

async function markAsRead(event, user) {
  const notificationId = event.pathParameters?.id;

  const getParams = {
    TableName: TABLE_NAME,
    Key: { id: notificationId },
  };

  const existing = await dynamodb.get(getParams).promise();
  if (!existing.Item) {
    return buildResponse(404, { error: 'Notification not found' });
  }

  if (existing.Item.user_id !== user.userId) {
    return buildResponse(403, { error: 'Forbidden' });
  }

  const updateParams = {
    TableName: TABLE_NAME,
    Key: { id: notificationId },
    UpdateExpression: 'SET #read = :read, updated_at = :now',
    ExpressionAttributeNames: {
      '#read': 'read',
    },
    ExpressionAttributeValues: {
      ':read': true,
      ':now': new Date().toISOString(),
    },
    ReturnValues: 'ALL_NEW',
  };

  const result = await dynamodb.update(updateParams).promise();
  return buildResponse(200, result.Attributes);
}

async function deleteNotification(event, user) {
  const notificationId = event.pathParameters?.id;

  const getParams = {
    TableName: TABLE_NAME,
    Key: { id: notificationId },
  };

  const existing = await dynamodb.get(getParams).promise();
  if (!existing.Item) {
    return buildResponse(404, { error: 'Notification not found' });
  }

  if (existing.Item.user_id !== user.userId) {
    return buildResponse(403, { error: 'Forbidden' });
  }

  await dynamodb.delete({ TableName: TABLE_NAME, Key: { id: notificationId } }).promise();
  return buildResponse(204, {});
}

async function markAllAsRead(event, user) {
  const artistId = event.queryStringParameters?.artistId;

  const queryParams = {
    TableName: TABLE_NAME,
    IndexName: 'user_id-index',
    KeyConditionExpression: 'user_id = :userId',
    FilterExpression: '#read = :false',
    ExpressionAttributeNames: {
      '#read': 'read',
    },
    ExpressionAttributeValues: {
      ':userId': user.userId,
      ':false': false,
    },
  };

  if (artistId) {
    queryParams.FilterExpression += ' AND artist_id = :artistId';
    queryParams.ExpressionAttributeValues[':artistId'] = artistId;
  }

  const result = await dynamodb.query(queryParams).promise();
  const unreadNotifications = result.Items || [];

  let updateCount = 0;
  const now = new Date().toISOString();

  for (const notification of unreadNotifications) {
    await dynamodb.update({
      TableName: TABLE_NAME,
      Key: { id: notification.id },
      UpdateExpression: 'SET #read = :true, updated_at = :now',
      ExpressionAttributeNames: { '#read': 'read' },
      ExpressionAttributeValues: { ':true': true, ':now': now },
    }).promise();
    updateCount++;
  }

  return buildResponse(200, { count: updateCount });
}

async function dismissNotification(event, user) {
  const notificationId = event.pathParameters?.id;

  const getParams = {
    TableName: TABLE_NAME,
    Key: { id: notificationId },
  };

  const existing = await dynamodb.get(getParams).promise();
  if (!existing.Item) {
    return buildResponse(404, { error: 'Notification not found' });
  }

  if (existing.Item.user_id !== user.userId) {
    return buildResponse(403, { error: 'Forbidden' });
  }

  const updateParams = {
    TableName: TABLE_NAME,
    Key: { id: notificationId },
    UpdateExpression: 'SET dismissed = :dismissed, updated_at = :now',
    ExpressionAttributeValues: {
      ':dismissed': true,
      ':now': new Date().toISOString(),
    },
    ReturnValues: 'ALL_NEW',
  };

  const result = await dynamodb.update(updateParams).promise();
  return buildResponse(200, result.Attributes);
}

async function createNotification(payload) {
  const { type, artistId, performedByUserId, performedByName, metadata } = payload;

  if (!type || !artistId || !performedByUserId || !performedByName) {
    return buildResponse(400, { error: 'Missing required fields' });
  }

  const validTypes = ['song_added', 'song_ready', 'gig_added', 'gig_removed', 'rehearsal_added', 'rehearsal_removed', 'vote_reminder'];
  if (!validTypes.includes(type)) {
    return buildResponse(400, { error: 'Invalid notification type' });
  }

  // Set priority: 'high' for vote_reminder, 'normal' for all others
  const priority = payload.priority || (type === 'vote_reminder' ? 'high' : 'normal');

  const now = new Date();

  // Only check for grouping if type is song_added
  if (type === 'song_added') {
    const queryParams = {
      TableName: TABLE_NAME,
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      FilterExpression: '#type = :type',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':type': type,
      },
      ScanIndexForward: false,
      Limit: 1,
    };

    const existingNotifications = await dynamodb.query(queryParams).promise();

    if (existingNotifications.Items?.length > 0) {
      const lastNotification = existingNotifications.Items[0];
      const lastCreatedAt = new Date(lastNotification.created_at);
      const timeDiff = now - lastCreatedAt;

      if (timeDiff <= GROUPING_WINDOW_MS) {
        const lastMetadata = JSON.parse(lastNotification.metadata);
        const newCount = (lastMetadata.count || 1) + 1;

        await dynamodb.update({
          TableName: TABLE_NAME,
          Key: { id: lastNotification.id },
          UpdateExpression: 'SET metadata = :metadata, updated_at = :now',
          ExpressionAttributeValues: {
            ':metadata': JSON.stringify({ ...lastMetadata, count: newCount }),
            ':now': now.toISOString(),
          },
        }).promise();

        return buildResponse(200, { grouped: true, notificationId: lastNotification.id });
      }
    }
  }

  const notificationId = uuidv4();
  const expiresAt = Math.floor(now.getTime() / 1000) + (TTL_DAYS * 24 * 60 * 60);

  const newNotification = {
    id: notificationId,
    user_id: performedByUserId,
    artist_id: artistId,
    type,
    priority,
    message: buildMessage(type, performedByName, metadata),
    metadata: JSON.stringify({ ...metadata, performedByUserId, performedByName }),
    read: false,
    dismissed: false,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: expiresAt,
  };

  await dynamodb.put({ TableName: TABLE_NAME, Item: newNotification }).promise();
  return buildResponse(200, newNotification);
}

function buildMessage(type, performedByName, metadata) {
  switch (type) {
    case 'song_added':
      return `${performedByName} suggested "${metadata.songTitle}" by ${metadata.songArtist}`;
    case 'song_ready':
      return `"${metadata.songTitle}" is ready to perform (${metadata.voteCount} votes)`;
    case 'gig_added':
      return `${performedByName} added a gig at ${metadata.venueName} on ${metadata.eventDate}`;
    case 'gig_removed':
      return `${performedByName} removed the gig at ${metadata.venueName} on ${metadata.eventDate}`;
    case 'rehearsal_added':
      return `${performedByName} added a rehearsal on ${metadata.eventDate}`;
    case 'rehearsal_removed':
      return `${performedByName} removed the rehearsal on ${metadata.eventDate}`;
    case 'vote_reminder':
      const count = metadata.count || 0;
      return `There ${count === 1 ? 'is' : 'are'} ${count} song suggestion${count === 1 ? '' : 's'} that need${count === 1 ? 's' : ''} your vote!`;
    default:
      return 'New notification';
  }
}

exports.handler = async (event) => {
  try {
    if (event.action === 'create') {
      return await createNotification(event);
    }

    const method = event.requestContext?.http?.method;
    const path = event.requestContext?.http?.path;

    let user;
    try {
      user = requireAuth(event);
    } catch (error) {
      return buildResponse(401, { error: error.message });
    }

    if (method === 'GET' && path === '/api/notifications') {
      return await getNotifications(event, user);
    }

    if (method === 'PUT' && path.startsWith('/api/notifications/') && path.endsWith('/read')) {
      return await markAsRead(event, user);
    }

    if (method === 'DELETE' && path.startsWith('/api/notifications/')) {
      return await deleteNotification(event, user);
    }

    if (method === 'POST' && path === '/api/notifications/mark-all-read') {
      return await markAllAsRead(event, user);
    }

    if (method === 'PUT' && path.startsWith('/api/notifications/') && path.endsWith('/dismiss')) {
      return await dismissNotification(event, user);
    }

    return buildResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Error:', error);
    return buildResponse(500, { error: error.message });
  }
};
