const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, PutCommand, UpdateCommand, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const OpenAI = require('openai');
const { z } = require('zod');

const client = new DynamoDBClient({ region: 'eu-west-2' });
const dynamodb = DynamoDBDocumentClient.from(client);

const JWT_SECRET = process.env.JWT_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const QUEUE_TABLE = 'bndy-ingest-queue';
const EVENTS_TABLE = 'bndy-events';
const VENUES_TABLE = 'bndy-venues';
const ARTISTS_TABLE = 'bndy-artists';
const BNDY_API_BASE = 'https://api.bndy.co.uk';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Zod schema for event extraction
const EventSchema = z.object({
  venueName: z.string().min(1).max(100),
  artistName: z.string().min(1).max(100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be HH:mm').optional(),
  facebookUrl: z.string().url().optional(),
  notes: z.string().max(500).optional()
});

const ExtractSchema = z.object({
  events: z.array(EventSchema).max(200)
});

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

// Helper functions for extraction and resolution
function htmlToVisibleText(html) {
  return html
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractEventsWithLLM(html) {
  const text = htmlToVisibleText(html);
  const clampedText = text.slice(0, 50000);

  const prompt = `
Extract gig events from this webpage. Return ONLY valid JSON.

STRICT RULES:
- venueName: Include city if mentioned (e.g., "Queens Hotel Macclesfield")
- artistName: Band/artist name only
- date: YYYY-MM-DD format (parse relative dates like "this Saturday")
- time: HH:mm format, omit if not specified (we default to 20:00 later)
- facebookUrl: Only if explicitly mentioned
- notes: Ticket price, entry info, etc.
- Maximum 200 events

JSON Schema:
{
  "events": [
    {
      "venueName": "string",
      "artistName": "string",
      "date": "YYYY-MM-DD",
      "time": "HH:mm" (optional),
      "facebookUrl": "https://..." (optional),
      "notes": "string" (optional)
    }
  ]
}

Text:
${clampedText}
`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0
  });

  const parsed = JSON.parse(response.choices[0].message.content || '{}');
  const validated = ExtractSchema.parse(parsed);
  return validated.events;
}

async function resolveVenue(venueName, locationContext) {
  // Load all venues from BNDY API
  const venuesResponse = await axios.get(`${BNDY_API_BASE}/api/venues`);
  const allVenues = venuesResponse.data || [];

  // Search Google Places
  const placesResponse = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
    params: {
      query: `${venueName} ${locationContext}`,
      key: GOOGLE_PLACES_API_KEY
    }
  });

  if (placesResponse.data.status !== 'OK' || !placesResponse.data.results || placesResponse.data.results.length === 0) {
    return {
      action: 'CREATE_NEW',
      confidence: 0.5,
      reasons: ['no_google_results']
    };
  }

  const topGooglePlace = placesResponse.data.results[0];

  // Check for place_id match first
  const placeIdMatch = allVenues.find(v => v.googlePlaceId === topGooglePlace.place_id);
  if (placeIdMatch) {
    return {
      action: 'MATCH_EXISTING',
      venue_id: placeIdMatch.id,
      confidence: 0.99,
      reasons: ['place_id_match'],
      location: {
        lat: topGooglePlace.geometry.location.lat,
        lng: topGooglePlace.geometry.location.lng
      }
    };
  }

  // Fallback to creating new with Google enrichments
  return {
    action: 'CREATE_NEW',
    confidence: 0.8,
    reasons: ['google_enrichment'],
    enrichments: {
      googlePlaceId: topGooglePlace.place_id,
      address: topGooglePlace.formatted_address,
      latitude: topGooglePlace.geometry.location.lat,
      longitude: topGooglePlace.geometry.location.lng
    },
    location: {
      lat: topGooglePlace.geometry.location.lat,
      lng: topGooglePlace.geometry.location.lng
    }
  };
}

async function resolveArtist(artistName, venueLocation) {
  // Load all artists from BNDY API
  const artistsResponse = await axios.get(`${BNDY_API_BASE}/api/artists`);
  const allArtists = artistsResponse.data || [];

  // Normalize name for comparison
  const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const extractedNorm = normalize(artistName);

  // Find exact name match
  const exactMatch = allArtists.find(a => normalize(a.name) === extractedNorm);
  if (exactMatch) {
    return {
      action: 'MATCH_EXISTING',
      artist_id: exactMatch.id,
      confidence: 0.7,
      reasons: ['name_exact']
    };
  }

  // No match - create new
  return {
    action: 'CREATE_NEW',
    confidence: 0.8,
    reasons: ['new_artist'],
    artist_data: {
      name: artistName,
      location: null
    }
  };
}

async function extractFromURL(event) {
  const authResult = requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const url = 'https://www.gigs-news.uk/';
  const locationContext = 'Greater Manchester, UK';

  try {
    console.log('Fetching HTML from:', url);
    const htmlResponse = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 15000
    });

    console.log('Extracting events with LLM...');
    const extractedEvents = await extractEventsWithLLM(htmlResponse.data);
    console.log(`Extracted ${extractedEvents.length} events`);

    let processedCount = 0;

    for (const extractedEvent of extractedEvents) {
      console.log(`Processing: ${extractedEvent.artistName} @ ${extractedEvent.venueName}`);

      const venueResolution = await resolveVenue(extractedEvent.venueName, locationContext);
      const artistResolution = await resolveArtist(extractedEvent.artistName, venueResolution.location);

      const queueId = uuidv4();
      const queueItem = {
        queue_id: queueId,
        venueName: extractedEvent.venueName,
        artistName: extractedEvent.artistName,
        date: extractedEvent.date,
        time: extractedEvent.time,
        notes: extractedEvent.notes,
        facebookUrl: extractedEvent.facebookUrl,
        venueResolution,
        artistResolution,
        status: 'pending',
        source: 'gigs-news_automated',
        created_at: new Date().toISOString()
      };

      await dynamodb.send(new PutCommand({
        TableName: QUEUE_TABLE,
        Item: queueItem
      }));

      processedCount++;
    }

    console.log(`Loaded ${processedCount} events into queue`);

    return createResponse(200, {
      success: true,
      extracted: extractedEvents.length,
      queued: processedCount
    });

  } catch (error) {
    console.error('Error in extractFromURL:', error);
    return createResponse(500, { error: 'Failed to extract events: ' + error.message });
  }
}

async function extractFromHTML(event) {
  const authResult = requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const body = event.body ? JSON.parse(event.body) : null;
  if (!body || !body.html) {
    return createResponse(400, { error: 'HTML content required in request body' });
  }

  const locationContext = 'Greater Manchester, UK';

  try {
    console.log('Extracting events from pasted HTML...');
    const extractedEvents = await extractEventsWithLLM(body.html);
    console.log(`Extracted ${extractedEvents.length} events`);

    let processedCount = 0;

    for (const extractedEvent of extractedEvents) {
      console.log(`Processing: ${extractedEvent.artistName} @ ${extractedEvent.venueName}`);

      const venueResolution = await resolveVenue(extractedEvent.venueName, locationContext);
      const artistResolution = await resolveArtist(extractedEvent.artistName, venueResolution.location);

      // Facebook URL enrichment for 100% matched venues
      if (venueResolution.confidence === 0.99 && venueResolution.venue_id && extractedEvent.facebookUrl) {
        await enrichVenueWithFacebookUrl(venueResolution.venue_id, extractedEvent.facebookUrl);
      }

      const queueId = uuidv4();
      const queueItem = {
        queue_id: queueId,
        venueName: extractedEvent.venueName,
        artistName: extractedEvent.artistName,
        date: extractedEvent.date,
        time: extractedEvent.time,
        notes: extractedEvent.notes,
        facebookUrl: extractedEvent.facebookUrl,
        venueResolution,
        artistResolution,
        status: 'pending',
        source: 'gigs-news_manual_paste',
        created_at: new Date().toISOString()
      };

      await dynamodb.send(new PutCommand({
        TableName: QUEUE_TABLE,
        Item: queueItem
      }));

      processedCount++;
    }

    console.log(`Loaded ${processedCount} events into queue`);

    return createResponse(200, {
      success: true,
      extracted: extractedEvents.length,
      queued: processedCount
    });

  } catch (error) {
    console.error('Error in extractFromHTML:', error);
    return createResponse(500, { error: 'Failed to extract events: ' + error.message });
  }
}

async function enrichVenueWithFacebookUrl(venueId, facebookUrl) {
  try {
    // Get the venue first to check if it already has a Facebook URL
    const venueResult = await dynamodb.send(new GetCommand({
      TableName: VENUES_TABLE,
      Key: { id: venueId }
    }));

    const venue = venueResult.Item;
    if (!venue) {
      console.log(`Venue ${venueId} not found for Facebook URL enrichment`);
      return;
    }

    // Only enrich if venue doesn't already have a Facebook URL
    if (!venue.facebookUrl || venue.facebookUrl === '') {
      await dynamodb.send(new UpdateCommand({
        TableName: VENUES_TABLE,
        Key: { id: venueId },
        UpdateExpression: 'SET facebookUrl = :url, updatedAt = :now',
        ExpressionAttributeValues: {
          ':url': facebookUrl,
          ':now': new Date().toISOString()
        }
      }));

      console.log(`Enriched venue ${venueId} with Facebook URL: ${facebookUrl}`);
    } else {
      console.log(`Venue ${venueId} already has Facebook URL, skipping enrichment`);
    }
  } catch (error) {
    console.error(`Error enriching venue ${venueId} with Facebook URL:`, error);
    // Don't throw - enrichment failure shouldn't block the extraction
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

    if (routeKey === 'POST /api/ingest/extract-from-url') {
      return await extractFromURL(event);
    }

    if (routeKey === 'POST /api/ingest/extract-from-html') {
      return await extractFromHTML(event);
    }

    return createResponse(404, { error: 'Route not found' });

  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};
