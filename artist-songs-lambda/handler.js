// BNDY Artist Songs Lambda - MVP: Add to Playbook
const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const crypto = require('crypto');

exports.handler = async (event, context) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;

  console.log('Artist Songs Lambda:', { method, path });
  console.log('Request Context:', JSON.stringify(event.requestContext, null, 2));
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    const artistId = event.pathParameters?.artistId;
    const artistSongId = event.pathParameters?.artistSongId;
    const userId = event.requestContext?.authorizer?.userId;

    console.log('Extracted values:', { artistId, artistSongId, userId });

    // POST /api/artists/{artistId}/playbook - Add song
    if (method === 'POST' && path.includes('/playbook') && artistId) {
      return await handleAddSongToPlaybook(JSON.parse(event.body), artistId);
    }

    // GET /api/artists/{artistId}/playbook - List playbook
    if (method === 'GET' && path.includes('/playbook') && artistId) {
      return await handleGetPlaybook(artistId, event.queryStringParameters);
    }

    // PUT /api/artists/{artistId}/playbook/{artistSongId} - Update enrichments
    if (method === 'PUT' && artistSongId && path.includes('/playbook')) {
      return await handleUpdateSong(artistSongId, JSON.parse(event.body));
    }

    // DELETE /api/artists/{artistId}/playbook/{artistSongId} - Remove song
    if (method === 'DELETE' && artistSongId) {
      return await handleDeleteSong(artistSongId);
    }

    // POST /api/artists/{artistId}/pipeline/suggestions - Add song to pipeline
    if (method === 'POST' && path.includes('/pipeline/suggestions') && artistId) {
      return await handleAddSuggestion(JSON.parse(event.body), artistId, userId);
    }

    // GET /api/artists/{artistId}/pipeline - Get pipeline songs by status
    if (method === 'GET' && path.includes('/pipeline') && artistId) {
      return await handleGetPipeline(artistId, event.queryStringParameters);
    }

    // POST /api/artists/{artistId}/pipeline/{artistSongId}/vote - Vote on song
    if (method === 'POST' && artistSongId && path.includes('/vote')) {
      return await handleVote(artistSongId, artistId, userId, JSON.parse(event.body));
    }

    // POST /api/artists/{artistId}/pipeline/{artistSongId}/rag - Update RAG status
    if (method === 'POST' && artistSongId && path.includes('/rag')) {
      return await handleUpdateRagStatus(artistSongId, userId, JSON.parse(event.body));
    }

    // PUT /api/artists/{artistId}/pipeline/{artistSongId}/status - Change status
    if (method === 'PUT' && artistSongId && path.includes('/status')) {
      return await handleChangeStatus(artistSongId, JSON.parse(event.body));
    }

    // PUT /api/artists/{artistId}/pipeline/{artistSongId}/comment - Update comment
    if (method === 'PUT' && artistSongId && path.includes('/comment')) {
      return await handleUpdateComment(artistSongId, JSON.parse(event.body));
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

    if (!result.Item) return null;

    // Map DB fields to frontend expected fields
    const song = result.Item;
    return {
      ...song,
      artist_name: song.artistName || song.artist_name,
      thumbnail_url: song.albumImageUrl || song.thumbnail_url,
      spotify_url: song.spotifyUrl || song.spotify_url,
      preview_url: song.previewUrl || song.preview_url
    };
  } catch (error) {
    console.error('Error fetching global song:', error);
    return null;
  }
}

async function handleAddSuggestion(body, artistId, userId) {
  const now = new Date().toISOString();
  const artistSong = {
    id: crypto.randomUUID(),
    artist_id: artistId,
    song_id: body.song_id,
    status: 'voting',

    votes: {
      [userId]: {
        value: body.initial_vote,
        updated_at: now
      }
    },

    rag_status: {},

    custom_key: null,
    custom_tempo: null,
    tuning: 'standard',
    notes: '',
    youtube_url: '',
    reference_url: '',

    suggested_by_user_id: userId,
    suggested_comment: body.suggested_comment || '',
    vote_score_percentage: null,

    last_performed_at: '1970-01-01T00:00:00.000Z',
    performance_count: 0,
    promoted_to_playbook_at: null,

    added_by_membership_id: body.added_by_membership_id,
    created_at: now,
    updated_at: now,
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

async function handleGetPipeline(artistId, queryParams) {
  const status = queryParams?.status || 'voting';

  const result = await dynamodb.query({
    TableName: 'bndy-artist-songs',
    IndexName: 'artist_id-status-index',
    KeyConditionExpression: 'artist_id = :artistId AND #status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':artistId': artistId,
      ':status': status
    }
  }).promise();

  let songs = await Promise.all(
    result.Items.map(async (artistSong) => {
      const globalSong = await getGlobalSong(artistSong.song_id);

      if (!globalSong) {
        console.log(`Warning: Orphaned artist-song record ${artistSong.id}`);
        return null;
      }

      return { ...artistSong, globalSong };
    })
  );

  songs = songs.filter(song => song !== null);

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify(songs)
  };
}

async function handleVote(artistSongId, artistId, userId, body) {
  try {
    const now = new Date().toISOString();

    if (!body.vote_value || body.vote_value < 1 || body.vote_value > 5) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Invalid vote value. Must be between 1 and 5.' })
      };
    }

    const songResult = await dynamodb.get({
      TableName: 'bndy-artist-songs',
      Key: { id: artistSongId }
    }).promise();

    if (!songResult.Item) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Song not found' })
      };
    }

    const song = songResult.Item;
    const votes = song.votes || {};

    votes[userId] = {
      value: body.vote_value,
      updated_at: now
    };

    const memberCountResult = await dynamodb.query({
      TableName: 'bndy-artist-memberships',
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      ExpressionAttributeValues: { ':artistId': artistId }
    }).promise();

    const memberCount = memberCountResult.Items.length;
    const voteCount = Object.keys(votes).length;

    const totalVotes = Object.values(votes).reduce((sum, v) => sum + v.value, 0);
    const scorePercentage = Math.round((totalVotes / (memberCount * 5)) * 100);

    const newStatus = (voteCount >= memberCount && song.status === 'voting') ? 'review' : song.status;
    const statusChanged = newStatus !== song.status;

    await dynamodb.update({
      TableName: 'bndy-artist-songs',
      Key: { id: artistSongId },
      UpdateExpression: 'SET votes = :votes, vote_score_percentage = :score, #status = :status, updated_at = :now' +
        (statusChanged ? ', last_status_change_at = :now' : ''),
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':votes': votes,
        ':score': scorePercentage,
        ':status': newStatus,
        ':now': now
      }
    }).promise();

    const globalSong = await getGlobalSong(song.song_id);

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        ...song,
        votes,
        vote_score_percentage: scorePercentage,
        status: newStatus,
        updated_at: now,
        globalSong
      })
    };
  } catch (error) {
    console.error('Error in handleVote:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        error: 'Failed to submit vote',
        message: error.message,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      })
    };
  }
}

async function handleUpdateRagStatus(artistSongId, userId, body) {
  const now = new Date().toISOString();

  const songResult = await dynamodb.get({
    TableName: 'bndy-artist-songs',
    Key: { id: artistSongId }
  }).promise();

  if (!songResult.Item) {
    return {
      statusCode: 404,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Song not found' })
    };
  }

  const song = songResult.Item;
  const ragStatus = song.rag_status || {};

  ragStatus[userId] = {
    status: body.status,
    updated_at: now
  };

  await dynamodb.update({
    TableName: 'bndy-artist-songs',
    Key: { id: artistSongId },
    UpdateExpression: 'SET rag_status = :rag_status, updated_at = :now',
    ExpressionAttributeValues: {
      ':rag_status': ragStatus,
      ':now': now
    }
  }).promise();

  const globalSong = await getGlobalSong(song.song_id);

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({
      ...song,
      rag_status: ragStatus,
      updated_at: now,
      globalSong
    })
  };
}

async function handleChangeStatus(artistSongId, body) {
  const now = new Date().toISOString();
  const newStatus = body.status;

  const updates = ['#status = :status', 'updated_at = :now', 'last_status_change_at = :now'];
  const values = {
    ':status': newStatus,
    ':now': now
  };

  if (newStatus === 'playbook') {
    updates.push('promoted_to_playbook_at = :now');
  }

  const result = await dynamodb.update({
    TableName: 'bndy-artist-songs',
    Key: { id: artistSongId },
    UpdateExpression: 'SET ' + updates.join(', '),
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW'
  }).promise();

  const globalSong = await getGlobalSong(result.Attributes.song_id);

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({ ...result.Attributes, globalSong })
  };
}

async function handleUpdateComment(artistSongId, body) {
  const now = new Date().toISOString();

  const result = await dynamodb.update({
    TableName: 'bndy-artist-songs',
    Key: { id: artistSongId },
    UpdateExpression: 'SET suggested_comment = :comment, updated_at = :now',
    ExpressionAttributeValues: {
      ':comment': body.comment,
      ':now': now
    },
    ReturnValues: 'ALL_NEW'
  }).promise();

  const globalSong = await getGlobalSong(result.Attributes.song_id);

  return {
    statusCode: 200,
    headers: getCorsHeaders(),
    body: JSON.stringify({ ...result.Attributes, globalSong })
  };
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
