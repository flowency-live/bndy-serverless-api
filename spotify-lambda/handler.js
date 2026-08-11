// Spotify Lambda - Proxy for Spotify Web API
// Handles search and track info requests

const https = require('https');

// Spotify API credentials from environment
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// In-memory cache for access token
let cachedToken = null;
let tokenExpiry = 0;

const ALLOWED_ORIGINS = [
  'https://www.bndy.co.uk',       // Primary domain
  'https://backstage.bndy.co.uk', // Legacy domain
  'https://bndy.co.uk',            // Apex domain
  'https://live.bndy.co.uk',      // Frontstage
  'https://gigmap.bndy.co.uk',    // GigMap
  'https://map.bndy.co.uk',       // Map (canonical)
  'https://gigs.bndy.co.uk',      // Gigs
  'http://localhost:3000'          // Local development
];

let currentEvent = null;

const getAllowedOrigin = () => {
  const requestOrigin = currentEvent?.headers?.origin || currentEvent?.headers?.Origin;
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
};

/**
 * Get Spotify access token using Client Credentials flow
 */
async function getAccessToken() {
  // Return cached token if still valid
  if (cachedToken && Date.now() < tokenExpiry) {
    console.log('Using cached Spotify token');
    return cachedToken;
  }

  console.log('Requesting new Spotify access token');

  const authString = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');

  const options = {
    hostname: 'accounts.spotify.com',
    path: '/api/token',
    method: 'POST',
    headers: {
      'Authorization': `Basic ${authString}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  };

  const postData = 'grant_type=client_credentials';

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          const response = JSON.parse(data);
          cachedToken = response.access_token;
          // Cache for 55 minutes (token valid for 60)
          tokenExpiry = Date.now() + (55 * 60 * 1000);
          resolve(cachedToken);
        } else {
          console.error('Spotify auth failed:', res.statusCode, data);
          reject(new Error(`Spotify auth failed: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (error) => {
      console.error('Spotify auth request error:', error);
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Make request to Spotify Web API
 */
async function spotifyApiRequest(path, token) {
  const options = {
    hostname: 'api.spotify.com',
    path: path,
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          console.error('Spotify API error:', res.statusCode, data);
          reject(new Error(`Spotify API error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (error) => {
      console.error('Spotify API request error:', error);
      reject(error);
    });

    req.end();
  });
}

/**
 * Search Spotify for tracks with enriched metadata (genres and release dates)
 */
async function searchTracks(query, limit = 20) {
  const token = await getAccessToken();
  const encodedQuery = encodeURIComponent(query);
  const path = `/v1/search?q=${encodedQuery}&type=track&limit=${limit}`;

  console.log('Searching Spotify for:', query, 'limit:', limit);
  const result = await spotifyApiRequest(path, token);

  // Enrich each track with artist genres
  if (result.tracks && result.tracks.items) {
    const enrichedTracks = await Promise.all(
      result.tracks.items.map(async (track) => {
        try {
          // Get artist genres from the first artist
          if (track.artists && track.artists.length > 0) {
            const artistId = track.artists[0].id;
            const artistData = await spotifyApiRequest(`/v1/artists/${artistId}`, token);

            // Add genre (pick first genre if available)
            track.genre = artistData.genres && artistData.genres.length > 0
              ? artistData.genres[0]
              : null;
          }
        } catch (error) {
          console.error(`Failed to get artist data for track ${track.id}:`, error);
          track.genre = null;
        }

        return track;
      })
    );

    result.tracks.items = enrichedTracks;
  }

  return result;
}

/**
 * Lambda handler
 */
exports.handler = async (event) => {
  currentEvent = event;
  console.log('Spotify Lambda invoked:', event.requestContext.http.method, event.requestContext.http.path);

  const headers = {
    'Access-Control-Allow-Origin': getAllowedOrigin(),
    'Access-Control-Allow-Credentials': true,
    'Content-Type': 'application/json'
  };

  try {
    // Handle CORS preflight
    if (event.requestContext.http.method === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: {
          ...headers,
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        },
        body: ''
      };
    }

    const path = event.requestContext.http.path;
    const method = event.requestContext.http.method;

    // GET /api/spotify/search?q=query&limit=20
    if (method === 'GET' && path === '/api/spotify/search') {
      const query = event.queryStringParameters?.q;
      const limit = parseInt(event.queryStringParameters?.limit || '20');

      if (!query) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Missing query parameter: q' })
        };
      }

      const results = await searchTracks(query, limit);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(results)
      };
    }

    // Route not found
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Route not found' })
    };

  } catch (error) {
    console.error('Spotify Lambda error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message
      })
    };
  }
};
