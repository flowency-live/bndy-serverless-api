const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

// Helper function to parse JSON body
function parseBody(event) {
  try {
    return typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (error) {
    console.error('Failed to parse body:', error);
    return null;
  }
}

// Helper function to create response
function createResponse(statusCode, body) {
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

// Helper function to enrich setlist songs with tuning data
async function enrichSetlistWithTuning(setlist) {
  if (!setlist.sets || setlist.sets.length === 0) {
    return setlist;
  }

  // Get all unique song_ids from all sets
  const songIds = new Set();
  setlist.sets.forEach(set => {
    if (set.songs) {
      set.songs.forEach(song => {
        if (song.song_id) {
          songIds.add(song.song_id);
        }
      });
    }
  });

  // Fetch tuning data for each song_id from artist-songs table
  const tuningMap = {};
  const artistId = setlist.artist_id;

  for (const songId of songIds) {
    try {
      const result = await dynamodb.query({
        TableName: 'bndy-artist-songs',
        IndexName: 'artist_id-song_id-index',
        KeyConditionExpression: 'artist_id = :artistId AND song_id = :songId',
        ExpressionAttributeValues: {
          ':artistId': artistId,
          ':songId': songId,
        },
      }).promise();

      if (result.Items && result.Items.length > 0) {
        tuningMap[songId] = result.Items[0].tuning || 'standard';
      }
    } catch (error) {
      console.error(`Error fetching tuning for song ${songId}:`, error);
    }
  }

  // Enrich songs with tuning data
  const enrichedSets = setlist.sets.map(set => ({
    ...set,
    songs: set.songs.map(song => ({
      ...song,
      tuning: tuningMap[song.song_id] || 'standard',
    })),
  }));

  return {
    ...setlist,
    sets: enrichedSets,
  };
}

exports.handler = async (event) => {
  console.log('Setlists Lambda Event:', JSON.stringify(event, null, 2));

  const path = event.requestContext?.http?.path || event.path || '';
  const method = event.requestContext?.http?.method || event.httpMethod || '';

  try {
    // GET /api/artists/{artistId}/setlists - List all setlists for an artist
    if (method === 'GET' && path.match(/\/api\/artists\/[^/]+\/setlists$/)) {
      const artistId = event.pathParameters?.artistId;

      if (!artistId) {
        return createResponse(400, { error: 'Artist ID is required' });
      }

      const result = await dynamodb.query({
        TableName: 'bndy-setlists',
        IndexName: 'artist_id-created_at-index',
        KeyConditionExpression: 'artist_id = :artistId',
        ExpressionAttributeValues: {
          ':artistId': artistId,
        },
        ScanIndexForward: false, // Most recent first
      }).promise();

      return createResponse(200, result.Items || []);
    }

    // GET /api/artists/{artistId}/setlists/{setlistId} - Get single setlist
    if (method === 'GET' && path.match(/\/api\/artists\/[^/]+\/setlists\/[^/]+$/)) {
      const setlistId = event.pathParameters?.setlistId;

      if (!setlistId) {
        return createResponse(400, { error: 'Setlist ID is required' });
      }

      const result = await dynamodb.get({
        TableName: 'bndy-setlists',
        Key: { id: setlistId },
      }).promise();

      if (!result.Item) {
        return createResponse(404, { error: 'Setlist not found' });
      }

      // Enrich songs with tuning data from artist-songs
      const enrichedSetlist = await enrichSetlistWithTuning(result.Item);

      return createResponse(200, enrichedSetlist);
    }

    // POST /api/artists/{artistId}/setlists - Create new setlist
    if (method === 'POST' && path.match(/\/api\/artists\/[^/]+\/setlists$/)) {
      const artistId = event.pathParameters?.artistId;
      const body = parseBody(event);

      if (!artistId || !body) {
        return createResponse(400, { error: 'Artist ID and body are required' });
      }

      const { name, sets, created_by_membership_id } = body;

      if (!name) {
        return createResponse(400, { error: 'Setlist name is required' });
      }

      const now = new Date().toISOString();
      const setlistId = uuidv4();

      // Default to 2 sets of 60 minutes each
      const defaultSets = sets || [
        { id: uuidv4(), name: 'Set 1', targetDuration: 3600, songs: [] },
        { id: uuidv4(), name: 'Set 2', targetDuration: 3600, songs: [] },
      ];

      const newSetlist = {
        id: setlistId,
        artist_id: artistId,
        name,
        sets: defaultSets,
        created_by_membership_id: created_by_membership_id || null,
        created_at: now,
        updated_at: now,
      };

      await dynamodb.put({
        TableName: 'bndy-setlists',
        Item: newSetlist,
      }).promise();

      return createResponse(201, newSetlist);
    }

    // PUT /api/artists/{artistId}/setlists/{setlistId} - Update setlist
    if (method === 'PUT' && path.match(/\/api\/artists\/[^/]+\/setlists\/[^/]+$/)) {
      const setlistId = event.pathParameters?.setlistId;
      const body = parseBody(event);

      if (!setlistId || !body) {
        return createResponse(400, { error: 'Setlist ID and body are required' });
      }

      // Check if setlist exists
      const existing = await dynamodb.get({
        TableName: 'bndy-setlists',
        Key: { id: setlistId },
      }).promise();

      if (!existing.Item) {
        return createResponse(404, { error: 'Setlist not found' });
      }

      const now = new Date().toISOString();
      const updates = {
        ...existing.Item,
        ...body,
        id: setlistId, // Prevent ID changes
        artist_id: existing.Item.artist_id, // Prevent artist_id changes
        created_at: existing.Item.created_at, // Preserve creation time
        updated_at: now,
      };

      await dynamodb.put({
        TableName: 'bndy-setlists',
        Item: updates,
      }).promise();

      return createResponse(200, updates);
    }

    // DELETE /api/artists/{artistId}/setlists/{setlistId} - Delete setlist
    if (method === 'DELETE' && path.match(/\/api\/artists\/[^/]+\/setlists\/[^/]+$/)) {
      const setlistId = event.pathParameters?.setlistId;

      if (!setlistId) {
        return createResponse(400, { error: 'Setlist ID is required' });
      }

      await dynamodb.delete({
        TableName: 'bndy-setlists',
        Key: { id: setlistId },
      }).promise();

      return createResponse(200, { message: 'Setlist deleted successfully' });
    }

    // POST /api/artists/{artistId}/setlists/{setlistId}/copy - Copy setlist
    if (method === 'POST' && path.match(/\/api\/artists\/[^/]+\/setlists\/[^/]+\/copy$/)) {
      const setlistId = event.pathParameters?.setlistId;
      const body = parseBody(event);

      if (!setlistId) {
        return createResponse(400, { error: 'Setlist ID is required' });
      }

      // Get original setlist
      const original = await dynamodb.get({
        TableName: 'bndy-setlists',
        Key: { id: setlistId },
      }).promise();

      if (!original.Item) {
        return createResponse(404, { error: 'Setlist not found' });
      }

      const now = new Date().toISOString();
      const newSetlistId = uuidv4();
      const newName = body?.name || `${original.Item.name} (Copy)`;

      // Deep copy sets with new IDs
      const copiedSets = original.Item.sets.map(set => ({
        ...set,
        id: uuidv4(),
      }));

      const copiedSetlist = {
        ...original.Item,
        id: newSetlistId,
        name: newName,
        sets: copiedSets,
        created_by_membership_id: body?.created_by_membership_id || original.Item.created_by_membership_id,
        created_at: now,
        updated_at: now,
      };

      await dynamodb.put({
        TableName: 'bndy-setlists',
        Item: copiedSetlist,
      }).promise();

      return createResponse(201, copiedSetlist);
    }

    return createResponse(404, { error: 'Route not found' });

  } catch (error) {
    console.error('Error processing request:', error);
    return createResponse(500, { error: 'Internal server error', details: error.message });
  }
};
