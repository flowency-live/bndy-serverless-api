const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, PutCommand, UpdateCommand, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const client = new DynamoDBClient({ region: 'eu-west-2' });
const dynamodb = DynamoDBDocumentClient.from(client);

const JWT_SECRET = process.env.JWT_SECRET;
const QUEUE_TABLE = 'bndy-ingest-queue';
const EVENTS_TABLE = 'bndy-events';
const VENUES_TABLE = 'bndy-venues';
const ARTISTS_TABLE = 'bndy-artists';

function createResponse(statusCode, body, additionalHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      ...additionalHeaders
    },
    body: JSON.stringify(body)
  };
}

function requireAuth(event) {
  try {
    let cookieHeader = event.headers?.Cookie || event.headers?.cookie;
    if (!cookieHeader && event.cookies && event.cookies.length > 0) {
      cookieHeader = event.cookies.join('; ');
    }

    if (!cookieHeader) {
      return { error: 'No cookies present' };
    }

    const cookies = {};
    cookieHeader.split(';').forEach(cookie => {
      const [key, value] = cookie.trim().split('=');
      if (key && value) cookies[key] = value;
    });

    const sessionToken = cookies['bndy_session'];
    if (!sessionToken) {
      return { error: 'No session token' };
    }

    const decoded = jwt.verify(sessionToken, JWT_SECRET);
    return { user: decoded };
  } catch (error) {
    console.error('Auth error:', error.message);
    return { error: 'Invalid session' };
  }
}

async function getEventQueue(event) {
  const authResult = requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  try {
    const result = await dynamodb.send(new ScanCommand({
      TableName: QUEUE_TABLE,
      FilterExpression: '#status = :pending',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':pending': 'pending'
      }
    }));

    const items = result.Items || [];
    items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return createResponse(200, items);
  } catch (error) {
    console.error('Error fetching queue:', error);
    return createResponse(500, { error: 'Failed to fetch queue' });
  }
}

async function approveQueueItem(event) {
  const authResult = requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const queueId = event.pathParameters?.id;
  if (!queueId) {
    return createResponse(400, { error: 'Missing queue ID' });
  }

  try {
    const queueResult = await dynamodb.send(new GetCommand({
      TableName: QUEUE_TABLE,
      Key: { queue_id: queueId }
    }));

    const queueItem = queueResult.Item;
    if (!queueItem) {
      return createResponse(404, { error: 'Queue item not found' });
    }

    if (queueItem.status !== 'pending') {
      return createResponse(400, { error: 'Queue item already processed' });
    }

    let venueId = queueItem.venueResolution.venue_id;
    let artistId = queueItem.artistResolution.artist_id;

    if (queueItem.venueResolution.action === 'CREATE_NEW') {
      venueId = uuidv4();
      const venueData = {
        id: venueId,
        name: queueItem.venueName,
        validated: false,
        source: 'agentic_ingest',
        createdAt: new Date().toISOString(),
        ...queueItem.venueResolution.enrichments,
        latitude: queueItem.venueResolution.location?.lat || 0,
        longitude: queueItem.venueResolution.location?.lng || 0,
        location: {
          lat: queueItem.venueResolution.location?.lat || 0,
          lng: queueItem.venueResolution.location?.lng || 0
        }
      };

      await dynamodb.send(new PutCommand({
        TableName: VENUES_TABLE,
        Item: venueData
      }));

      console.log('Created new venue:', venueId);
    }

    if (queueItem.artistResolution.action === 'CREATE_NEW') {
      artistId = uuidv4();
      const artistData = {
        id: artistId,
        name: queueItem.artistName,
        artist_type: 'band',
        isVerified: false,
        source: 'agentic_ingest',
        createdAt: new Date().toISOString(),
        location: queueItem.artistResolution.artist_data?.location || null
      };

      await dynamodb.send(new PutCommand({
        TableName: ARTISTS_TABLE,
        Item: artistData
      }));

      console.log('Created new artist:', artistId);
    }

    const eventId = uuidv4();
    const eventDate = queueItem.date;
    const eventTime = queueItem.time || '20:00';

    const naturalKey = generateNaturalKey(venueId, artistId, eventDate);

    const eventData = {
      id: eventId,
      naturalKey,
      venueId,
      artistId,
      date: eventDate,
      startTime: eventTime,
      endTime: '23:00',
      title: `${queueItem.artistName} @ ${queueItem.venueName}`,
      type: 'gig',
      isPublic: true,
      source: 'agentic_ingest',
      geoLat: queueItem.venueResolution.location?.lat || 0,
      geoLng: queueItem.venueResolution.location?.lng || 0,
      facebookUrl: queueItem.facebookUrl || null,
      notes: queueItem.notes || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await dynamodb.send(new PutCommand({
      TableName: EVENTS_TABLE,
      Item: eventData
    }));

    console.log('Created event:', eventId);

    await dynamodb.send(new UpdateCommand({
      TableName: QUEUE_TABLE,
      Key: { queue_id: queueId },
      UpdateExpression: 'SET #status = :approved, approvedAt = :now, approvedBy = :userId, eventId = :eventId',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':approved': 'approved',
        ':now': new Date().toISOString(),
        ':userId': authResult.user.userId,
        ':eventId': eventId
      }
    }));

    return createResponse(200, {
      success: true,
      eventId,
      venueId,
      artistId,
      venueCreated: queueItem.venueResolution.action === 'CREATE_NEW',
      artistCreated: queueItem.artistResolution.action === 'CREATE_NEW'
    });

  } catch (error) {
    console.error('Error approving queue item:', error);
    return createResponse(500, { error: 'Failed to approve queue item' });
  }
}

async function rejectQueueItem(event) {
  const authResult = requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const queueId = event.pathParameters?.id;
  if (!queueId) {
    return createResponse(400, { error: 'Missing queue ID' });
  }

  try {
    await dynamodb.send(new UpdateCommand({
      TableName: QUEUE_TABLE,
      Key: { queue_id: queueId },
      UpdateExpression: 'SET #status = :rejected, rejectedAt = :now, rejectedBy = :userId',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':rejected': 'rejected',
        ':now': new Date().toISOString(),
        ':userId': authResult.user.userId
      }
    }));

    return createResponse(200, { success: true });
  } catch (error) {
    console.error('Error rejecting queue item:', error);
    return createResponse(500, { error: 'Failed to reject queue item' });
  }
}

async function loadPOCResults(event) {
  const authResult = requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  try {
    let pocData;

    // Try to get data from request body first
    const body = event.body ? JSON.parse(event.body) : null;

    if (body && body.results && Array.isArray(body.results)) {
      pocData = body.results;
      console.log('Using POC results from request body');
    } else {
      // Fallback to local file (development only)
      const pocResultsPath = path.join(__dirname, 'poc-results.json');

      if (!fs.existsSync(pocResultsPath)) {
        return createResponse(400, {
          error: 'POC results must be provided in request body',
          format: '{ "results": [ {...extracted events...} ] }',
          hint: 'Copy the contents of poc-results.json and send as POST body'
        });
      }

      pocData = JSON.parse(fs.readFileSync(pocResultsPath, 'utf8'));
      console.log('Using POC results from deployed file');
    }

    let loadedCount = 0;

    for (const result of pocData) {
      if (result.error) {
        continue;
      }

      const queueId = uuidv4();
      const queueItem = {
        queue_id: queueId,
        venueName: result.extracted.venueName,
        artistName: result.extracted.artistName,
        date: result.extracted.date,
        time: result.extracted.time,
        notes: result.extracted.notes,
        facebookUrl: result.extracted.facebookUrl,
        venueResolution: result.venueResolution,
        artistResolution: result.artistResolution,
        status: 'pending',
        source: 'poc_load',
        created_at: new Date().toISOString()
      };

      await dynamodb.send(new PutCommand({
        TableName: QUEUE_TABLE,
        Item: queueItem
      }));

      loadedCount++;
    }

    console.log(`Loaded ${loadedCount} POC results into queue`);

    return createResponse(200, {
      success: true,
      loaded: loadedCount,
      total: pocData.length
    });

  } catch (error) {
    console.error('Error loading POC results:', error);
    return createResponse(500, { error: 'Failed to load POC results: ' + error.message });
  }
}

function generateNaturalKey(venueId, artistId, date) {
  const crypto = require('crypto');
  const raw = `${venueId}|${artistId}|${date}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

exports.handler = async (event) => {
  console.log('EventsAgent Lambda invoked:', JSON.stringify(event, null, 2));

  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;
  const routeKey = `${method} ${path}`;

  console.log('Route key:', routeKey);

  try {
    if (routeKey === 'GET /api/ingest/queue') {
      return await getEventQueue(event);
    }

    if (routeKey.match(/^POST \/api\/ingest\/queue\/[^\/]+\/approve$/)) {
      return await approveQueueItem(event);
    }

    if (routeKey.match(/^POST \/api\/ingest\/queue\/[^\/]+\/reject$/)) {
      return await rejectQueueItem(event);
    }

    if (routeKey === 'POST /api/ingest/load-poc') {
      return await loadPOCResults(event);
    }

    return createResponse(404, { error: 'Route not found' });

  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};
