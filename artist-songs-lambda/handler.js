// BNDY Artist Songs Lambda - MVP: Add to Playbook
const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const lambda = new AWS.Lambda({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ALLOWED_ORIGINS = [
  'https://www.bndy.co.uk',       // Primary domain
  'https://backstage.bndy.co.uk', // Legacy domain
  'https://bndy.co.uk',            // Apex domain
  'https://live.bndy.co.uk',      // Frontstage
  'https://gigs.bndy.co.uk',      // Gigs
  'https://bndy.live',             // Public maps domain
  'https://stage.bndy.live',       // Backstage domain
  'http://localhost:3000'          // Local development
];

let currentEvent = null;

const getAllowedOrigin = () => {
  const requestOrigin = currentEvent?.headers?.origin || currentEvent?.headers?.Origin;
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
};

// JWT Secret - cached after first retrieval
let JWT_SECRET = null;

/**
 * Get JWT secret from SSM Parameter Store with fallback to env var
 */
async function getJWTSecret() {
  if (JWT_SECRET) {
    return JWT_SECRET; // Return cached value
  }

  // Try SSM first
  try {
    const result = await ssm.getParameter({
      Name: '/bndy/auth/jwt-secret',
      WithDecryption: true
    }).promise();
    JWT_SECRET = result.Parameter.Value;
    console.log('[ARTIST-SONGS] JWT_SECRET loaded from SSM');
    return JWT_SECRET;
  } catch (error) {
    console.error('[ARTIST-SONGS] Failed to get JWT_SECRET from SSM:', error.message);
    // Fallback to environment variable
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      console.log('[ARTIST-SONGS] JWT_SECRET loaded from environment variable (fallback)');
      return JWT_SECRET;
    }
    throw new Error('JWT_SECRET not available from SSM or environment');
  }
}

// Parse cookies from event
const parseCookies = (cookieHeader) => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, value] = cookie.trim().split('=');
    cookies[name] = value;
    return cookies;
  }, {});
};

// Extract userId from JWT session cookie
const extractUserId = async (event) => {
  let sessionToken = null;

  // HTTP API v2 format - cookies array
  if (event.cookies && Array.isArray(event.cookies)) {
    const cookieString = event.cookies.find(c => c.startsWith('bndy_session='));
    if (cookieString) {
      sessionToken = cookieString.split('=')[1];
    }
  }

  // HTTP API v1 format OR fallback - Cookie header
  if (!sessionToken) {
    const cookieHeader = event.headers?.Cookie || event.headers?.cookie || '';
    const cookies = parseCookies(cookieHeader);
    sessionToken = cookies.bndy_session;
  }

  if (!sessionToken) {
    return null;
  }

  try {
    const jwtSecret = await getJWTSecret();
    const session = jwt.verify(sessionToken, jwtSecret);
    return session.userId;
  } catch (error) {
    console.error('[AUTH] JWT verification failed:', error.message);
    return null;
  }
};

exports.handler = async (event, context) => {
  currentEvent = event;
  const method = event.requestContext?.http?.method || event.httpMethod;
  const path = event.requestContext?.http?.path || event.rawPath || event.path;

  console.log('[Artist Songs Lambda] Processing request:', { method, path });
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    const artistId = event.pathParameters?.artistId;
    const artistSongId = event.pathParameters?.artistSongId;
    const userId = await extractUserId(event);

    // SECURITY: Require authentication for all private artist-specific endpoints
    // These endpoints expose sensitive data (playbook, pipeline, votes) and MUST NOT be publicly accessible
    // Fix for: https://api.bndy.co.uk/api/artists/{id}/playbook returning data without auth
    const PRIVATE_PATHS = ['/playbook', '/pipeline', '/check-vote-reminders'];
    const isPrivateEndpoint = PRIVATE_PATHS.some(p => path.includes(p));

    if (isPrivateEndpoint && !userId) {
      console.log('[SECURITY] Blocked unauthenticated access to private endpoint:', path);
      return {
        statusCode: 401,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Authentication required' })
      };
    }

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

    // DELETE /api/artists/{artistId}/pipeline/{artistSongId} - Delete suggestion (only by suggester)
    if (method === 'DELETE' && artistSongId && path.includes('/pipeline')) {
      return await handleDeleteSuggestion(artistSongId, userId);
    }

    // POST /api/artists/{artistId}/pipeline/{artistSongId}/rag - Update RAG status (legacy)
    if (method === 'POST' && artistSongId && path.includes('/rag') && !path.includes('/rag-status')) {
      return await handleUpdateRagStatus(artistSongId, userId, JSON.parse(event.body));
    }

    // PUT /api/artists/{artistId}/pipeline/{artistSongId}/rag-status - Update RAG status
    if (method === 'PUT' && artistSongId && path.includes('/rag-status')) {
      const body = JSON.parse(event.body);
      return await handleUpdateRagStatus(artistSongId, userId, { status: body.rag_status });
    }

    // PUT /api/artists/{artistId}/pipeline/{artistSongId}/status - Change status
    if (method === 'PUT' && artistSongId && path.includes('/status') && !path.includes('/rag-status')) {
      return await handleChangeStatus(artistSongId, JSON.parse(event.body));
    }

    // PUT /api/artists/{artistId}/pipeline/{artistSongId}/comment - Update comment
    if (method === 'PUT' && artistSongId && path.includes('/comment')) {
      return await handleUpdateComment(artistSongId, JSON.parse(event.body));
    }

    // POST /api/artists/{artistId}/check-vote-reminders - Check for unvoted songs
    if (method === 'POST' && path.includes('/check-vote-reminders') && artistId) {
      return await handleCheckVoteReminders(artistId, userId);
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
  // Validate required fields
  if (!body.song_id || typeof body.song_id !== 'string') {
    console.error('[ARTIST-SONGS] Invalid song_id in request body:', { song_id: body.song_id, type: typeof body.song_id });
    return {
      statusCode: 400,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'song_id is required and must be a valid string' })
    };
  }

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
    votes: {},  // Must be object (Map), not array (List) for userId-keyed votes
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
  console.log('[UPDATE-SONG] Received update request:', { artistSongId: artistSongId.substring(0, 8) + '...', body });
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
  if (body.additional_url !== undefined) {
    updates.push('additional_url = :additional_url');
    values[':additional_url'] = body.additional_url;
  }
  if (body.guitar_chords_url !== undefined) {
    updates.push('guitar_chords_url = :guitar_chords_url');
    values[':guitar_chords_url'] = body.guitar_chords_url;
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
    // Validate songId
    if (!songId || typeof songId !== 'string') {
      console.error('[ARTIST-SONGS] Invalid songId:', { songId, type: typeof songId });
      return null;
    }

    const result = await dynamodb.get({
      TableName: 'bndy-songs',
      Key: { id: songId }
    }).promise();

    if (!result.Item) {
      console.log('[ARTIST-SONGS] Global song not found:', songId);
      return null;
    }

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
    console.error('[ARTIST-SONGS] Error fetching global song:', { songId, error: error.message });
    return null;
  }
}

async function triggerNotification(type, artistId, userId, metadata) {
  const notificationsFunctionName = process.env.NOTIFICATIONS_FUNCTION_NAME;

  if (!notificationsFunctionName) {
    console.log('[NOTIFICATION] NOTIFICATIONS_FUNCTION_NAME not configured, skipping notification');
    return;
  }

  try {
    // Get performer's display name
    let performedByName;

    if (type === 'vote_reminder') {
      // For vote_reminder, use System as performer (notification is to self)
      performedByName = 'System';

      // vote_reminder notifications are sent to the user themselves
      const payload = {
        action: 'create',
        type: type,
        priority: 'high',
        artistId: artistId,
        performedByUserId: userId,
        performedByName: performedByName,
        recipientUserId: userId,
        metadata: metadata
      };

      console.log('[NOTIFICATION] Triggering vote_reminder for user');

      await lambda.invoke({
        FunctionName: notificationsFunctionName,
        InvocationType: 'Event',
        Payload: JSON.stringify(payload)
      }).promise();

      return;
    }

    // For event-based notifications, get performer name
    if (type === 'song_added') {
      // For song_added, query bndy-artist-memberships (anonymous)
      const membershipResult = await dynamodb.query({
        TableName: 'bndy-artist-memberships',
        IndexName: 'user_id-index',
        KeyConditionExpression: 'user_id = :userId',
        FilterExpression: 'artist_id = :artistId',
        ExpressionAttributeValues: {
          ':userId': userId,
          ':artistId': artistId
        },
        Limit: 1
      }).promise();

      performedByName = membershipResult.Items?.[0]?.display_name || 'A member';
    } else {
      // For all other types, query bndy-users (named)
      const userResult = await dynamodb.get({
        TableName: 'bndy-users',
        Key: { cognito_id: userId }
      }).promise();

      performedByName = userResult.Item?.display_name ||
                       userResult.Item?.first_name ||
                       'Unknown User';
    }

    // Query all artist members
    const membershipsResult = await dynamodb.query({
      TableName: 'bndy-artist-memberships',
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

async function handleAddSuggestion(body, artistId, userId) {
  console.log('[Artist Songs Lambda] Adding suggestion to pipeline');

  if (!userId) {
    return {
      statusCode: 401,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Authentication required' })
    };
  }

  const now = new Date().toISOString();
  const status = body.status || 'voting';

  // SAFEGUARD: Check if this song already exists in the artist's pipeline
  console.log('[ADD_SUGGESTION] Checking for duplicate song_id:', body.song_id);
  const existingSongsResult = await dynamodb.query({
    TableName: 'bndy-artist-songs',
    IndexName: 'artist_id-status-index',
    KeyConditionExpression: 'artist_id = :artistId',
    FilterExpression: 'song_id = :songId',
    ExpressionAttributeValues: {
      ':artistId': artistId,
      ':songId': body.song_id
    }
  }).promise();

  if (existingSongsResult.Items && existingSongsResult.Items.length > 0) {
    const existingSong = existingSongsResult.Items[0];
    console.log('[ADD_SUGGESTION] Duplicate detected - song already exists with status:', existingSong.status);
    return {
      statusCode: 409,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        error: 'Song already exists',
        message: `This song is already in your pipeline with status: ${existingSong.status}`,
        existingSong: existingSong
      })
    };
  }

  const artistSong = {
    id: crypto.randomUUID(),
    artist_id: artistId,
    song_id: body.song_id,
    status: status,

    votes: status === 'voting' ? {
      [userId]: {
        value: body.initial_vote,
        updated_at: now
      }
    } : {},

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
    voting_scale: 3,  // New songs use 0-3 scale (existing songs without this field use 5)

    last_performed_at: '1970-01-01T00:00:00.000Z',
    performance_count: 0,
    promoted_to_playbook_at: null,

    added_by_membership_id: body.added_by_membership_id,
    created_at: now,
    updated_at: now,
    last_status_change_at: now
  };

  console.log('[ADD_SUGGESTION] Created artistSong with status:', status);

  await dynamodb.put({
    TableName: 'bndy-artist-songs',
    Item: artistSong
  }).promise();

  const globalSong = await getGlobalSong(body.song_id);

  await triggerNotification(
    'song_added',
    artistId,
    userId,
    {
      songId: globalSong.id,
      songTitle: globalSong.title,
      songArtist: globalSong.artist_name || globalSong.artistName
    }
  );

  // Only trigger vote_reminder if status is 'voting'
  if (status === 'voting') {
    // Query all artist members
    const membershipsResult = await dynamodb.query({
      TableName: 'bndy-artist-memberships',
      IndexName: 'artist_id-index',
      KeyConditionExpression: 'artist_id = :artistId',
      ExpressionAttributeValues: {
        ':artistId': artistId
      }
    }).promise();

    // Filter out the suggester (they already voted)
    const otherMembers = (membershipsResult.Items || [])
      .filter(member => member.user_id !== userId)
      .map(member => member.user_id);

    // Send vote_reminder to each member (they have 1 new song to vote on)
    for (const memberId of otherMembers) {
      await triggerNotification(
        'vote_reminder',
        artistId,
        memberId,
        {
          count: 1  // They have at least this new song to vote on
        }
      );
    }
  }

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

    console.log('[VOTE] Starting vote handler', {
      artistSongId: artistSongId?.substring(0, 8) + '...',
      artistId: artistId?.substring(0, 8) + '...',
      userId: userId?.substring(0, 8) + '...',
      voteValue: body.vote_value
    });

    if (!userId) {
      console.error('[VOTE] No userId provided - authentication failed');
      return {
        statusCode: 401,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: 'Authentication required' })
      };
    }

    // Fetch song first to get voting_scale for validation
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

    // FIX: Convert votes from array to object if needed (legacy data issue)
    // Songs created via playbook had votes:[] instead of votes:{}
    let existingVotes = song.votes;
    if (Array.isArray(existingVotes)) {
      console.log('[VOTE] Converting votes from array to object for song:', artistSongId);
      existingVotes = {};
    }
    existingVotes = existingVotes || {};

    // Detect actual scale from vote values - if any vote > 3, song was voted with 5-star scale
    const voteValues = Object.values(existingVotes).map(v => (v && typeof v.value === 'number') ? v.value : 0);
    const maxVoteValue = voteValues.length > 0 ? Math.max(...voteValues) : 0;
    const votingScale = song.voting_scale || (maxVoteValue > 3 ? 5 : 3);

    if (body.vote_value === undefined || body.vote_value === null || body.vote_value < 0 || body.vote_value > votingScale) {
      console.error('[VOTE] Invalid vote value:', body.vote_value, 'for scale:', votingScale);
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({ error: `Invalid vote value. Must be between 0 and ${votingScale}.` })
      };
    }
    // Use the already-converted existingVotes (handles array->object conversion)
    const votes = existingVotes;

    console.log('[VOTE] Current votes before update:', Object.keys(votes));

    votes[userId] = {
      value: body.vote_value,
      updated_at: now
    };

    console.log('[VOTE] Votes after adding new vote:', Object.keys(votes));

    // Check if this is a poo vote (value = 0) - auto-discard
    const isPooVote = body.vote_value === 0;
    let newStatus = song.status;
    let statusChanged = false;
    let updateExpression = '';
    let voteCount = Object.keys(votes).length;
    let memberCount = 0;
    let scorePercentage = null;

    const expressionAttributeValues = {
      ':votes': votes,
      ':now': now
    };

    if (isPooVote) {
      console.log('[VOTE] POO VOTE DETECTED - Auto-discarding song');
      newStatus = 'discarded';
      statusChanged = true;

      // Append note about poo vote
      const existingNotes = song.notes || '';
      const pooNote = 'Song discarded - received a poo vote';
      const updatedNotes = existingNotes ? `${existingNotes}\n\n${pooNote}` : pooNote;

      updateExpression = 'SET votes = :votes, #status = :status, notes = :notes, updated_at = :now, last_status_change_at = :now';
      expressionAttributeValues[':status'] = newStatus;
      expressionAttributeValues[':notes'] = updatedNotes;

    } else {
      // Normal voting flow
      const memberCountResult = await dynamodb.query({
        TableName: 'bndy-artist-memberships',
        IndexName: 'artist_id-index',
        KeyConditionExpression: 'artist_id = :artistId',
        ExpressionAttributeValues: { ':artistId': artistId }
      }).promise();

      memberCount = memberCountResult.Items.length;

      console.log('[VOTE] Member count:', memberCount, 'Vote count:', voteCount, 'Voting scale:', votingScale);

      const totalVotes = Object.values(votes).reduce((sum, v) => sum + v.value, 0);
      const maxScore = memberCount * votingScale;  // Use song's voting_scale (3 or 5)
      scorePercentage = Math.round((totalVotes / maxScore) * 100);

      // Calculate disagreement flag (only when all votes are in)
      let hasDisagreement = false;
      if (voteCount >= memberCount) {
        const voteValues = Object.values(votes).map(v => v.value);
        const average = voteValues.reduce((a, b) => a + b, 0) / voteValues.length;

        // Calculate standard deviation
        const variance = voteValues.reduce((sum, v) => sum + Math.pow(v - average, 2), 0) / voteValues.length;
        const stdDev = Math.sqrt(variance);

        const min = Math.min(...voteValues);
        const max = Math.max(...voteValues);
        const range = max - min;

        // Flag if high disagreement - adjust thresholds based on scale
        // For 5-star: stdDev >= 1.5, range >= 4, or (5 and <=2)
        // For 3-star: stdDev >= 0.9, range >= 2, or (3 and 1)
        if (votingScale === 3) {
          if (stdDev >= 0.9 || range >= 2 || (voteValues.some(v => v === 3) && voteValues.some(v => v === 1))) {
            hasDisagreement = true;
          }
        } else {
          if (stdDev >= 1.5 || range >= 4 || (voteValues.some(v => v === 5) && voteValues.some(v => v <= 2))) {
            hasDisagreement = true;
          }
        }
      }

      newStatus = (voteCount >= memberCount && song.status === 'voting') ? 'review' : song.status;

      // Check auto-discard threshold if all votes are in and would go to review
      if (newStatus === 'review') {
        const artistResult = await dynamodb.get({
          TableName: 'bndy-artists',
          Key: { id: artistId }
        }).promise();

        const autoDiscardThreshold = artistResult.Item?.autoDiscardThreshold;
        if (autoDiscardThreshold !== null && autoDiscardThreshold !== undefined && scorePercentage < autoDiscardThreshold) {
          console.log('[VOTE] Auto-discarding song: score', scorePercentage, '% below threshold', autoDiscardThreshold, '%');
          newStatus = 'discarded';
        }
      }

      statusChanged = newStatus !== song.status;

      console.log('[VOTE] Status transition:', {
        oldStatus: song.status,
        newStatus,
        willPromote: statusChanged,
        scorePercentage,
        hasDisagreement
      });

      updateExpression = 'SET votes = :votes, vote_score_percentage = :score, has_disagreement = :disagreement, #status = :status, updated_at = :now' +
        (statusChanged ? ', last_status_change_at = :now' : '');
      expressionAttributeValues[':score'] = scorePercentage;
      expressionAttributeValues[':disagreement'] = hasDisagreement;
      expressionAttributeValues[':status'] = newStatus;
    }

    await dynamodb.update({
      TableName: 'bndy-artist-songs',
      Key: { id: artistSongId },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: expressionAttributeValues
    }).promise();

    const globalSong = await getGlobalSong(song.song_id);

    console.log('[VOTE] Vote recorded successfully', {
      songTitle: globalSong?.title,
      finalVoteCount: voteCount,
      finalMemberCount: memberCount,
      finalStatus: newStatus
    });

    // Trigger song_ready notification when all members have voted
    if (statusChanged && newStatus === 'review') {
      await triggerNotification(
        'song_ready',
        artistId,
        userId,
        {
          songId: song.song_id,
          songTitle: globalSong?.title || 'Unknown Song',
          songArtist: globalSong?.artist_name || globalSong?.artistName || '',
          voteCount: voteCount
        }
      );
    }

    // Update vote_reminder notification after voting
    try {
      // Query for existing vote_reminder for this user + artist
      const voteReminderResult = await dynamodb.query({
        TableName: 'bndy-notifications',
        IndexName: 'user_id-index',
        KeyConditionExpression: 'user_id = :userId',
        FilterExpression: '#type = :type AND artist_id = :artistId AND #read = :false',
        ExpressionAttributeNames: {
          '#type': 'type',
          '#read': 'read'
        },
        ExpressionAttributeValues: {
          ':userId': userId,
          ':type': 'vote_reminder',
          ':artistId': artistId,
          ':false': false
        }
      }).promise();

      if (voteReminderResult.Items?.length > 0) {
        // Recalculate unvoted songs count
        const allVotingSongsResult = await dynamodb.query({
          TableName: 'bndy-artist-songs',
          IndexName: 'artist_id-index',
          KeyConditionExpression: 'artist_id = :artistId',
          FilterExpression: '#status = :voting',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':artistId': artistId,
            ':voting': 'voting'
          }
        }).promise();

        const remainingUnvoted = (allVotingSongsResult.Items || []).filter(s => {
          const v = s.votes || {};
          return !v[userId];
        }).length;

        console.log('[VOTE] Updating vote_reminder:', { remainingUnvoted });

        const voteReminder = voteReminderResult.Items[0];

        if (remainingUnvoted === 0) {
          // Mark as read if no more unvoted songs
          await dynamodb.update({
            TableName: 'bndy-notifications',
            Key: { id: voteReminder.id },
            UpdateExpression: 'SET #read = :true, updated_at = :now',
            ExpressionAttributeNames: { '#read': 'read' },
            ExpressionAttributeValues: {
              ':true': true,
              ':now': now
            }
          }).promise();
          console.log('[VOTE] Marked vote_reminder as read (count=0)');
        } else {
          // Update count in metadata
          const existingMetadata = JSON.parse(voteReminder.metadata || '{}');
          const updatedMetadata = { ...existingMetadata, count: remainingUnvoted };

          await dynamodb.update({
            TableName: 'bndy-notifications',
            Key: { id: voteReminder.id },
            UpdateExpression: 'SET metadata = :metadata, message = :message, updated_at = :now',
            ExpressionAttributeValues: {
              ':metadata': JSON.stringify(updatedMetadata),
              ':message': `There ${remainingUnvoted === 1 ? 'is' : 'are'} ${remainingUnvoted} song suggestion${remainingUnvoted === 1 ? '' : 's'} that need${remainingUnvoted === 1 ? 's' : ''} your vote!`,
              ':now': now
            }
          }).promise();
          console.log('[VOTE] Updated vote_reminder count:', remainingUnvoted);
        }
      }
    } catch (reminderError) {
      console.error('[VOTE] Failed to update vote_reminder (non-blocking):', reminderError.message);
    }

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
    console.error('[VOTE] Error in handleVote:', error);
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

async function handleDeleteSuggestion(artistSongId, userId) {
  console.log('[DELETE_SUGGESTION] Starting', {
    artistSongId: artistSongId?.substring(0, 8) + '...',
    userId: userId ? userId.substring(0, 8) + '...' : 'NULL'
  });

  if (!userId) {
    console.error('[DELETE_SUGGESTION] ERROR: No userId provided - authentication required');
    return {
      statusCode: 401,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Authentication required' })
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

  // SAFEGUARD: Prevent deletion of playbook/active songs
  if (song.status === 'playbook' || song.status === 'active') {
    console.error('[DELETE_SUGGESTION] ERROR: Cannot delete playbook/active song', {
      songId: artistSongId?.substring(0, 8) + '...',
      status: song.status
    });
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        error: 'Cannot delete active playbook songs',
        message: 'This song is in your active playbook. Remove it from the playbook first.'
      })
    };
  }

  // SAFEGUARD: Only allow deletion of parked, discarded, or voting songs
  const deletableStatuses = ['parked', 'discarded', 'voting', 'practice', 'review'];
  if (!deletableStatuses.includes(song.status)) {
    console.error('[DELETE_SUGGESTION] ERROR: Song status not deletable', {
      songId: artistSongId?.substring(0, 8) + '...',
      status: song.status
    });
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        error: 'Cannot delete song with this status',
        message: `Songs with status "${song.status}" cannot be deleted.`
      })
    };
  }

  // Only the suggester can delete voting/review/practice songs
  // Parked/discarded songs can be deleted by anyone (they're archived)
  if (['voting', 'review', 'practice'].includes(song.status) && song.suggested_by_user_id !== userId) {
    console.error('[DELETE_SUGGESTION] ERROR: User is not the suggester', {
      requestingUserId: userId.substring(0, 8) + '...',
      suggestedByUserId: song.suggested_by_user_id?.substring(0, 8) + '...',
      status: song.status
    });
    return {
      statusCode: 403,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Only the suggester can delete this song' })
    };
  }

  await dynamodb.delete({
    TableName: 'bndy-artist-songs',
    Key: { id: artistSongId }
  }).promise();

  console.log('[DELETE_SUGGESTION] SUCCESS: Song permanently deleted', {
    songId: artistSongId?.substring(0, 8) + '...',
    status: song.status
  });

  return {
    statusCode: 204,
    headers: getCorsHeaders(),
    body: ''
  };
}

async function handleCheckVoteReminders(artistId, userId) {
  console.log('[CHECK_VOTE_REMINDERS] Checking for unvoted songs', {
    artistId: artistId ? artistId.substring(0, 8) + '...' : 'null',
    userId: userId ? userId.substring(0, 8) + '...' : 'null'
  });

  if (!userId) {
    return {
      statusCode: 401,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: 'Authentication required' })
    };
  }

  try {
    // Query all songs in voting status for this artist
    const votingSongsResult = await dynamodb.query({
      TableName: 'bndy-artist-songs',
      IndexName: 'artist_id-status-index',
      KeyConditionExpression: 'artist_id = :artistId AND #status = :status',
      ExpressionAttributeNames: {
        '#status': 'status'
      },
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':status': 'voting'
      }
    }).promise();

    const votingSongs = votingSongsResult.Items || [];

    // Filter to songs where user hasn't voted
    // votes is an object with userId keys: { "userId1": { value: 5, updated_at: "..." }, ... }
    const unvotedSongs = votingSongs.filter(song => {
      const votes = song.votes || {};
      return !votes[userId];  // Check if userId exists as a key in votes object
    });

    const count = unvotedSongs.length;

    console.log('[CHECK_VOTE_REMINDERS] Found unvoted songs:', { count });

    // If count is 0, delete any existing vote_reminder notifications
    if (count === 0) {
      // Query for existing vote_reminder notifications for this user + artist
      const existingNotificationsResult = await dynamodb.query({
        TableName: 'bndy-notifications',
        IndexName: 'user_id-index',
        KeyConditionExpression: 'user_id = :userId',
        FilterExpression: '#type = :type AND artist_id = :artistId',
        ExpressionAttributeNames: {
          '#type': 'type'
        },
        ExpressionAttributeValues: {
          ':userId': userId,
          ':type': 'vote_reminder',
          ':artistId': artistId
        }
      }).promise();

      // Delete any found notifications
      for (const notification of existingNotificationsResult.Items || []) {
        await dynamodb.delete({
          TableName: 'bndy-notifications',
          Key: { id: notification.id }
        }).promise();
        console.log('[CHECK_VOTE_REMINDERS] Deleted vote_reminder notification');
      }

      return {
        statusCode: 200,
        headers: getCorsHeaders(),
        body: JSON.stringify({ count: 0, message: 'No pending votes' })
      };
    }

    // Check if a vote_reminder notification already exists for this user + artist (dismissed or not)
    const existingNotificationsResult = await dynamodb.query({
      TableName: 'bndy-notifications',
      IndexName: 'user_id-index',
      KeyConditionExpression: 'user_id = :userId',
      FilterExpression: '#type = :type AND artist_id = :artistId',
      ExpressionAttributeNames: {
        '#type': 'type'
      },
      ExpressionAttributeValues: {
        ':userId': userId,
        ':type': 'vote_reminder',
        ':artistId': artistId
      }
    }).promise();

    const existingNotifications = existingNotificationsResult.Items || [];

    if (existingNotifications.length === 0) {
      // No existing notification - create new one
      await triggerNotification(
        'vote_reminder',
        artistId,
        userId,
        {
          count: count
        }
      );
      console.log('[CHECK_VOTE_REMINDERS] Created new vote_reminder notification');
    } else {
      // Existing notification(s) found
      const existingNotification = existingNotifications[0];
      const existingMetadata = JSON.parse(existingNotification.metadata || '{}');
      const existingCount = existingMetadata.count || 0;
      const isDismissed = existingNotification.dismissed || false;

      if (existingCount !== count || isDismissed) {
        // Count changed OR notification was dismissed - delete old and create new
        // Delete ALL existing vote_reminder notifications for this user+artist
        for (const notification of existingNotifications) {
          await dynamodb.delete({
            TableName: 'bndy-notifications',
            Key: { id: notification.id }
          }).promise();
        }
        console.log('[CHECK_VOTE_REMINDERS] Deleted', existingNotifications.length, 'old vote_reminder notification(s)');

        // Create fresh notification
        await triggerNotification(
          'vote_reminder',
          artistId,
          userId,
          {
            count: count
          }
        );
        console.log('[CHECK_VOTE_REMINDERS] Created new vote_reminder notification (count changed from', existingCount, 'to', count, 'or was dismissed)');
      } else {
        console.log('[CHECK_VOTE_REMINDERS] Vote_reminder notification exists with same count and not dismissed, no action needed');
      }
    }

    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({ count, message: existingNotificationsResult.Items?.length > 0 ? 'Existing reminder found' : 'Vote reminder created' })
    };
  } catch (error) {
    console.error('[CHECK_VOTE_REMINDERS] Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({ error: error.message })
    };
  }
}

// CORS is now handled by API Gateway CorsConfiguration in template.yaml
function getCorsHeaders() {
  return {
    'Content-Type': 'application/json'
  };
}
