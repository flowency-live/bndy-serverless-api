// BNDY Artist Songs Lambda - MVP: Add to Playbook
const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const crypto = require('crypto');

exports.handler = async (event, context) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;

  console.log('Artist Songs Lambda:', { method, path });
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    const artistId = event.pathParameters?.artistId;
    const artistSongId = event.pathParameters?.artistSongId;

    // POST /api/artists/{artistId}/playbook - Add song
    if (method === 'POST' && path.includes('/playbook') && artistId) {
      return await handleAddSongToPlaybook(JSON.parse(event.body), artistId);
    }

    // GET /api/artists/{artistId}/playbook - List playbook
    if (method === 'GET' && path.includes('/playbook') && artistId) {
      return await handleGetPlaybook(artistId, event.queryStringParameters);
    }

    // PUT /api/artists/{artistId}/playbook/{artistSongId} - Update enrichments
    if (method === 'PUT' && artistSongId) {
      return await handleUpdateSong(artistSongId, JSON.parse(event.body));
    }

    // DELETE /api/artists/{artistId}/playbook/{artistSongId} - Remove song
    if (method === 'DELETE' && artistSongId) {
      return await handleDeleteSong(artistSongId);
    }

    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Route not found' })
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: error.message })
    };
  }
};

async function handleAddSongToPlaybook(body, artistId) {
  const now = new Date().toISOString();
  const artistSong = {
    id: crypto.randomUUID(),
    artist_id: artistId,
    song_id: body.song_id,
    status: 'playbook',
    custom_key: body.custom_key || null,
    custom_tempo: body.custom_tempo || null,
    tuning: body.tuning || 'standard',
    notes: body.notes || '',
    youtube_url: body.youtube_url || '',
    reference_url: body.reference_url || '',
    votes: [],
    readiness: [],
    vetos: [],
    last_performed_at: '1970-01-01T00:00:00.000Z',
    performance_count: 0,
    added_by_membership_id: body.added_by_membership_id,
    created_at: now,
    updated_at: now,
    promoted_to_playbook_at: now,
    last_status_change_at: now
  };

  await dynamodb.put({
    TableName: 'bndy-artist-songs',
    Item: artistSong
  }).promise();

  const globalSong = await getGlobalSong(body.song_id);

  return {
    statusCode: 201,
    headers: getCorsHeaders(),
    body: JSON.stringify({ ...artistSong, globalSong })
  };
}

async function handleGetPlaybook(artistId, queryParams) {
  const result = await dynamodb.query({
    TableName: 'bndy-artist-songs',
    IndexName: 'artist_id-status-index',
    KeyConditionExpression: 'artist_id = :artistId AND #status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':artistId': artistId,
      ':status': 'playbook'
    }
  }).promise();

  let songs = await Promise.all(
    result.Items.map(async (artistSong) => {
      const globalSong = await getGlobalSong(artistSong.song_id);

      // Skip if global song has been deleted (orphaned record)
      if (!globalSong) {
        console.log(`Warning: Orphaned artist-song record ${artistSong.id} references deleted song ${artistSong.song_id}`);
        return null;
      }

      // Override global song title with custom title if set
      if (artistSong.custom_title) {
        globalSong.title = artistSong.custom_title;
      }

      return { ...artistSong, globalSong };
    })
  );

  // Filter out null entries (orphaned records)
  songs = songs.filter(song => song !== null);

  // Apply filters
  if (queryParams?.search) {
    const search = queryParams.search.toLowerCase();
    songs = songs.filter(s => 
      s.globalSong?.title?.toLowerCase().includes(search) ||
      s.globalSong?.artist_name?.toLowerCase().includes(search)
    );
  }

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify(songs)
  };
}

async function handleUpdateSong(artistSongId, body) {
  const updates = [];
  const values = { ':now': new Date().toISOString() };

  if (body.title !== undefined) {
    updates.push('custom_title = :custom_title');
    values[':custom_title'] = body.title;
  }
  if (body.custom_key !== undefined) {
    updates.push('custom_key = :custom_key');
    values[':custom_key'] = body.custom_key;
  }
  if (body.custom_tempo !== undefined) {
    updates.push('custom_tempo = :custom_tempo');
    values[':custom_tempo'] = body.custom_tempo;
  }
  if (body.tuning !== undefined) {
    updates.push('tuning = :tuning');
    values[':tuning'] = body.tuning;
  }
  if (body.custom_duration !== undefined) {
    updates.push('custom_duration = :custom_duration');
    values[':custom_duration'] = body.custom_duration;
  }
  if (body.notes !== undefined) {
    updates.push('notes = :notes');
    values[':notes'] = body.notes;
  }
  if (body.youtube_url !== undefined) {
    updates.push('youtube_url = :youtube_url');
    values[':youtube_url'] = body.youtube_url;
  }
  if (body.reference_url !== undefined) {
    updates.push('reference_url = :reference_url');
    values[':reference_url'] = body.reference_url;
  }

  updates.push('updated_at = :now');

  const result = await dynamodb.update({
    TableName: 'bndy-artist-songs',
    Key: { id: artistSongId },
    UpdateExpression: 'SET ' + updates.join(', '),
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW'
  }).promise();

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify(result.Attributes)
  };
}

async function handleDeleteSong(artistSongId) {
  await dynamodb.delete({
    TableName: 'bndy-artist-songs',
    Key: { id: artistSongId }
  }).promise();

  return {
    statusCode: 204,
    headers: getCorsHeaders(),
    body: ''
  };
}

async function getGlobalSong(songId) {
  try {
    const result = await dynamodb.get({
      TableName: 'bndy-songs',
      Key: { id: songId }
    }).promise();
    return result.Item || null;
  } catch (error) {
    console.error('Error fetching global song:', error);
    return null;
  }
}

function getCorsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,Cookie',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Credentials': 'true'
  };
}
