const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const ssm = new AWS.SSM({ region: 'eu-west-2' });

// JWT Secret - cached after first retrieval
let JWT_SECRET = null;

/**
 * Get JWT secret from SSM Parameter Store with fallback to env var
 */
async function getJWTSecret() {
  if (JWT_SECRET) {
    return JWT_SECRET;
  }

  try {
    const result = await ssm.getParameter({
      Name: '/bndy/auth/jwt-secret',
      WithDecryption: true
    }).promise();
    JWT_SECRET = result.Parameter.Value;
    console.log('[SETLISTS] JWT_SECRET loaded from SSM');
    return JWT_SECRET;
  } catch (error) {
    console.error('[SETLISTS] Failed to get JWT_SECRET from SSM:', error.message);
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      console.log('[SETLISTS] JWT_SECRET loaded from environment variable (fallback)');
      return JWT_SECRET;
    }
    throw new Error('JWT_SECRET not available from SSM or environment');
  }
}

/**
 * Parse cookies from event
 */
const parseCookies = (cookieHeader) => {
  if (!cookieHeader) return {};
  return cookieHeader.split(';').reduce((cookies, cookie) => {
    const [name, value] = cookie.trim().split('=');
    cookies[name] = value;
    return cookies;
  }, {});
};

/**
 * Authentication middleware - SEC-04
 */
const requireAuth = async (event) => {
  let sessionToken = null;

  if (event.cookies && Array.isArray(event.cookies)) {
    const cookieString = event.cookies.find(c => c.startsWith('bndy_session='));
    if (cookieString) {
      sessionToken = cookieString.split('=')[1];
    }
  } else {
    const cookies = parseCookies(event.headers?.Cookie || event.headers?.cookie || '');
    sessionToken = cookies.bndy_session;
  }

  if (!sessionToken) {
    return { error: 'Not authenticated' };
  }

  try {
    const jwtSecret = await getJWTSecret();
    const session = jwt.verify(sessionToken, jwtSecret);
    return { user: session };
  } catch (error) {
    console.error('[SETLISTS] Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

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
// CORS is now handled by API Gateway CorsConfiguration in template.yaml
function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

// Helper function to enrich setlist songs with tuning data
async function enrichSetlistWithTuning(setlist) {
  console.log('========== ENRICHMENT FUNCTION CALLED ==========');
  console.log('Enriching setlist:', setlist.name);
  console.log('Artist ID:', setlist.artist_id);

  if (!setlist.sets || setlist.sets.length === 0) {
    console.log('No sets found, returning setlist unchanged');
    return setlist;
  }

  // Get all unique song_ids from all sets
  const songIds = new Set();
  setlist.sets.forEach(set => {
    if (set.songs) {
      set.songs.forEach(song => {
        console.log(`[ENRICH] Song: "${song.title}" has song_id:`, song.song_id);
        if (song.song_id) {
          songIds.add(song.song_id);
        } else {
          console.warn(`[ENRICH] Song "${song.title}" missing song_id field!`);
        }
      });
    }
  });

  console.log(`[ENRICH] Found ${songIds.size} unique song_ids to lookup tuning for`);

  // Fetch all artist songs from playbook to get tuning and duration data
  const enrichmentMap = {};
  const artistId = setlist.artist_id;

  console.log(`[ENRICH] Fetching all playbook songs for artist: ${artistId}`);

  try {
    const result = await dynamodb.query({
      TableName: 'bndy-artist-songs',
      IndexName: 'artist_id-status-index',
      KeyConditionExpression: 'artist_id = :artistId AND #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':artistId': artistId,
        ':status': 'playbook',
      },
    }).promise();

    console.log(`[ENRICH] Found ${result.Items ? result.Items.length : 0} playbook songs`);

    // Build enrichment map from playbook songs (tuning + custom_duration + custom_key + notes)
    // NOTE: Setlists store the artist-song 'id', NOT the global 'song_id'
    if (result.Items) {
      result.Items.forEach(item => {
        if (item.id) {
          enrichmentMap[item.id] = {
            tuning: item.tuning || 'standard',
            custom_duration: item.custom_duration || null,
            custom_key: item.custom_key || null,
            notes: item.notes || ''
          };
          if (item.tuning !== 'standard' || item.custom_duration || item.custom_key || item.notes) {
            console.log(`[ENRICH] Mapped artist-song ID ${item.id} (global song: ${item.song_id}) -> tuning: ${item.tuning}, custom_duration: ${item.custom_duration}, custom_key: ${item.custom_key}, notes: ${item.notes ? 'yes' : 'no'}`);
          }
        }
      });
    }

    console.log(`[ENRICH] Built enrichment map with ${Object.keys(enrichmentMap).length} entries`);
  } catch (error) {
    console.error(`[ENRICH] Error fetching playbook songs:`, error);
  }

  // Enrich songs with tuning, custom_duration, custom_key, and notes data
  const enrichedSets = setlist.sets.map(set => ({
    ...set,
    songs: set.songs.map(song => {
      const enrichment = enrichmentMap[song.song_id] || { tuning: 'standard', custom_duration: null, custom_key: null, notes: '' };
      if (enrichment.tuning !== 'standard' || enrichment.custom_duration || enrichment.custom_key || enrichment.notes) {
        console.log(`[ENRICH] Applied to "${song.title}": tuning=${enrichment.tuning}, custom_duration=${enrichment.custom_duration}, custom_key=${enrichment.custom_key}, notes=${enrichment.notes ? 'yes' : 'no'}`);
      }
      return {
        ...song,
        tuning: enrichment.tuning,
        custom_duration: enrichment.custom_duration,
        key: enrichment.custom_key || song.key,
        notes: enrichment.notes
      };
    }),
  }));

  const enrichedSetlist = {
    ...setlist,
    sets: enrichedSets,
  };

  console.log('========== ENRICHMENT COMPLETE ==========');
  const allEnrichedSongs = enrichedSets.flatMap(set => set.songs || []);
  const nonStandardCount = allEnrichedSongs.filter(s => s.tuning !== 'standard').length;
  console.log(`Returning setlist with ${allEnrichedSongs.length} songs, ${nonStandardCount} with non-standard tuning`);

  return enrichedSetlist;
}

exports.handler = async (event) => {
  currentEvent = event;
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

      // Enrich each setlist with tuning data
      const enrichedSetlists = await Promise.all(
        (result.Items || []).map(setlist => enrichSetlistWithTuning(setlist))
      );

      return createResponse(200, enrichedSetlists);
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
      // SEC-04: Require authentication for setlist creation
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return createResponse(401, { error: authResult.error });
      }

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
      // SEC-04: Require authentication for setlist updates
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return createResponse(401, { error: authResult.error });
      }

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
      // SEC-04: Require authentication for setlist deletion
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return createResponse(401, { error: authResult.error });
      }

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
      // SEC-04: Require authentication for setlist copy
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return createResponse(401, { error: authResult.error });
      }

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
