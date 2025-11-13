# Add Song Auto-Enrichment Implementation Plan

**Created:** 2025-11-04
**Status:** READY FOR REVIEW

## Problem
Songs added via add-song-modal don't get genre/decade populated automatically.

## Root Cause
- Frontend sends `spotifyUrl` to backend
- Backend expects `song_id` (which is undefined)
- No enrichment logic on song creation

## Solution
Modify `handleAddSongToPlaybook()` in artist-songs-lambda/handler.js to:

1. Accept `spotifyUrl` from request body
2. Check if song exists in `bndy-songs` by spotifyUrl
3. If exists: Use existing song_id
4. If not exists: Create song + enrich silently
5. Link song_id in `bndy-artist-songs`

## Code Changes

### New Helper Functions (Add to handler.js)

```javascript
/**
 * Find song by Spotify URL in bndy-songs table
 */
async function findSongBySpotifyUrl(spotifyUrl) {
  const result = await dynamodb.scan({
    TableName: 'bndy-songs',
    FilterExpression: 'spotifyUrl = :url',
    ExpressionAttributeValues: {
      ':url': spotifyUrl
    },
    Limit: 1
  }).promise();

  return result.Items && result.Items.length > 0 ? result.Items[0] : null;
}

/**
 * Extract Spotify track ID from Spotify URL
 * Example: https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp -> 3n3Ppam7vgaVa1iaRUc9Lp
 */
function extractSpotifyTrackId(spotifyUrl) {
  const match = spotifyUrl.match(/track\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

/**
 * Get Spotify track metadata using spotify-lambda's getAccessToken pattern
 */
async function getSpotifyTrackMetadata(trackId) {
  const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
  const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    console.error('Spotify credentials not configured');
    return null;
  }

  const https = require('https');

  // Get access token
  const authString = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');

  const tokenOptions = {
    hostname: 'accounts.spotify.com',
    path: '/api/token',
    method: 'POST',
    headers: {
      'Authorization': `Basic ${authString}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  };

  const token = await new Promise((resolve, reject) => {
    const req = https.request(tokenOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          const response = JSON.parse(data);
          resolve(response.access_token);
        } else {
          reject(new Error('Failed to get Spotify token'));
        }
      });
    });
    req.on('error', reject);
    req.write('grant_type=client_credentials');
    req.end();
  });

  // Get track metadata
  const trackOptions = {
    hostname: 'api.spotify.com',
    path: `/v1/tracks/${trackId}`,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  const trackData = await new Promise((resolve, reject) => {
    const req = https.request(trackOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error('Failed to get track metadata'));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });

  // Get artist genres
  const artistId = trackData.artists[0]?.id;
  let genre = null;

  if (artistId) {
    const artistOptions = {
      hostname: 'api.spotify.com',
      path: `/v1/artists/${artistId}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    };

    const artistData = await new Promise((resolve, reject) => {
      const req = https.request(artistOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    });

    if (artistData && artistData.genres && artistData.genres.length > 0) {
      genre = artistData.genres[0];
    }
  }

  return {
    title: trackData.name,
    artistName: trackData.artists.map(a => a.name).join(', '),
    album: trackData.album.name,
    albumImageUrl: trackData.album.images[0]?.url || null,
    duration: Math.floor(trackData.duration_ms / 1000),
    releaseDate: trackData.album.release_date || null,
    previewUrl: trackData.preview_url || null,
    genre: genre
  };
}

/**
 * Create new song in bndy-songs with enriched metadata
 */
async function createEnrichedSong(spotifyUrl, metadata) {
  const songId = crypto.randomUUID();
  const now = new Date().toISOString();

  const song = {
    id: songId,
    title: metadata.title,
    artistName: metadata.artistName,
    album: metadata.album || null,
    albumImageUrl: metadata.albumImageUrl || null,
    duration: metadata.duration || null,
    genre: metadata.genre || '',
    releaseDate: metadata.releaseDate || null,
    previewUrl: metadata.previewUrl || null,
    spotifyUrl: spotifyUrl,
    appleMusicUrl: '',
    youtubeUrl: '',
    audioFileUrl: '',
    isFeatured: false,
    tags: [],
    createdAt: now,
    updatedAt: now
  };

  await dynamodb.put({
    TableName: 'bndy-songs',
    Item: song
  }).promise();

  return song;
}
```

### Modified handleAddSongToPlaybook()

```javascript
async function handleAddSongToPlaybook(body, artistId) {
  const now = new Date().toISOString();
  let songId = body.song_id; // Legacy support if song_id is provided

  // NEW: Handle spotifyUrl from frontend
  if (!songId && body.spotifyUrl) {
    try {
      // Check if song already exists
      let existingSong = await findSongBySpotifyUrl(body.spotifyUrl);

      if (existingSong) {
        console.log('[ADD_SONG] Found existing song:', existingSong.id);
        songId = existingSong.id;
      } else {
        // Extract Spotify track ID
        const trackId = extractSpotifyTrackId(body.spotifyUrl);

        if (trackId) {
          console.log('[ADD_SONG] Creating new song from Spotify:', trackId);

          // Get metadata from Spotify (with enrichment)
          const metadata = await getSpotifyTrackMetadata(trackId);

          if (metadata) {
            // Create song with enriched data
            const newSong = await createEnrichedSong(body.spotifyUrl, metadata);
            songId = newSong.id;
            console.log('[ADD_SONG] Created enriched song:', songId, 'Genre:', metadata.genre || 'none');
          } else {
            console.error('[ADD_SONG] Failed to get Spotify metadata for track:', trackId);
            // Fall back to creating basic song
            const basicSong = {
              id: crypto.randomUUID(),
              spotifyUrl: body.spotifyUrl,
              title: 'Unknown',
              artistName: 'Unknown',
              genre: '',
              createdAt: now,
              updatedAt: now
            };
            await dynamodb.put({ TableName: 'bndy-songs', Item: basicSong }).promise();
            songId = basicSong.id;
          }
        }
      }
    } catch (error) {
      console.error('[ADD_SONG] Error handling spotifyUrl:', error);
      // Don't fail the request - continue with undefined song_id (logged for debugging)
    }
  }

  // UNCHANGED: Rest of function stays exactly the same
  const artistSong = {
    id: crypto.randomUUID(),
    artist_id: artistId,
    song_id: songId,
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

  const globalSong = await getGlobalSong(songId);

  return {
    statusCode: 201,
    headers: getCorsHeaders(),
    body: JSON.stringify({ ...artistSong, globalSong })
  };
}
```

## Key Design Decisions

1. **Backward compatible**: Still accepts `song_id` if provided
2. **Non-blocking**: User gets immediate response
3. **Enrichment inline**: Happens during song creation (1-2 seconds total)
4. **Silent failures**: If Spotify enrichment fails, song still created with basic metadata
5. **No frontend changes**: Works with existing `spotifyUrl` parameter
6. **Deduplication**: Checks for existing song by spotifyUrl first

## User Experience

- User clicks "Add Song" → Immediate success toast
- Behind the scenes: Song created with genre/decade from Spotify
- If enrichment fails: Song still works, just missing genre/decade (user never knows)
- Total time: ~1-2 seconds (same as before)

## Testing Plan

1. Local test with sample Spotify URL
2. Deploy to staging
3. Test adding:
   - Existing song from bndy-songs (should reuse)
   - New song from Spotify (should enrich)
   - Song with no artist genres (should handle gracefully)

## Rollback Plan

If issues occur:
1. Restore from `_production_baselines/artist-songs-lambda-BASELINE.zip`
2. Or revert just the `handleAddSongToPlaybook()` function to current version
