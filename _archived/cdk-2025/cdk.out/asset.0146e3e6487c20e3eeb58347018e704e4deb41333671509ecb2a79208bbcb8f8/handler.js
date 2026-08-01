const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, PutCommand, UpdateCommand, GetCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const OpenAI = require('openai');
const { z } = require('zod');
const ngeohash = require('ngeohash');

const client = new DynamoDBClient({ region: 'eu-west-2' });
const dynamodb = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true
  }
});

const JWT_SECRET = process.env.JWT_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const QUEUE_TABLE = 'bndy-ingest-queue';
const EVENTS_TABLE = 'bndy-events';
const VENUES_TABLE = 'bndy-venues';
const ARTISTS_TABLE = 'bndy-artists';
const BNDY_API_BASE = 'https://api.bndy.co.uk';

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const ALLOWED_ORIGINS = [
  'https://www.bndy.co.uk',       // Primary domain
  'https://backstage.bndy.co.uk', // Legacy domain
  'https://bndy.co.uk',            // Apex domain
  'https://live.bndy.co.uk',      // Frontstage
  'http://localhost:3000'          // Local development
];

let currentEvent = null;

const getAllowedOrigin = () => {
  const requestOrigin = currentEvent?.headers?.origin || currentEvent?.headers?.Origin;
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
};

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
      'Access-Control-Allow-Origin': getAllowedOrigin(),
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

    // Handle SKIP events (TBC, Karaoke, Quiz) - mark as rejected
    if (queueItem.artistResolution.action === 'SKIP') {
      await dynamodb.send(new UpdateCommand({
        TableName: QUEUE_TABLE,
        Key: { queue_id: queueId },
        UpdateExpression: 'SET #status = :rejected, rejectedAt = :now, rejectedBy = :userId, skipReason = :reason',
        ExpressionAttributeNames: {
          '#status': 'status'
        },
        ExpressionAttributeValues: {
          ':rejected': 'rejected',
          ':now': new Date().toISOString(),
          ':userId': authResult.user.userId,
          ':reason': 'Theme event (no artist): ' + queueItem.artistResolution.theme
        }
      }));

      return createResponse(200, {
        success: true,
        skipped: true,
        reason: 'Theme event (no artist): ' + queueItem.artistResolution.theme
      });
    }

    let venueId = queueItem.venueResolution.venue_id;
    let artistId = queueItem.artistResolution.artist_id;

    // Handle Open Mic events - create a generic "Open Mic" artist if not exists
    if (queueItem.artistResolution.action === 'OPEN_MIC') {
      // Try to find existing "Open Mic" artist
      const artistsResponse = await axios.get(`${BNDY_API_BASE}/api/artists`);
      const allArtists = artistsResponse.data || [];
      const openMicArtist = allArtists.find(a => a.name === 'Open Mic');

      if (openMicArtist) {
        artistId = openMicArtist.id;
      } else {
        // Create generic Open Mic artist
        artistId = uuidv4();
        await dynamodb.send(new PutCommand({
          TableName: ARTISTS_TABLE,
          Item: {
            id: artistId,
            name: 'Open Mic',
            artist_type: 'event',
            bio: 'Generic entry for open mic nights',
            isVerified: false,
            source: 'agentic_ingest',
            createdAt: new Date().toISOString()
          }
        }));
        console.log('Created generic Open Mic artist:', artistId);
      }
    }

    if (queueItem.venueResolution.action === 'CREATE_NEW') {
      venueId = uuidv4();
      const venueData = {
        id: venueId,
        name: normalizeVenueName(queueItem.venueName),
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

    // Compute geohash fields for frontstage map
    const lat = queueItem.venueResolution.location?.lat || 0;
    const lng = queueItem.venueResolution.location?.lng || 0;
    const geohash6 = (lat && lng) ? ngeohash.encode(lat, lng, 6) : null;
    const geohash4 = (lat && lng) ? ngeohash.encode(lat, lng, 4) : null;

    const isOpenMic = queueItem.artistResolution.action === 'OPEN_MIC';

    const eventData = {
      id: eventId,
      naturalKey,
      venueId,
      artistId,
      date: eventDate,
      startTime: eventTime,
      endTime: '23:00',
      title: isOpenMic ? `Open Mic @ ${queueItem.venueName}` : `${queueItem.artistName} @ ${queueItem.venueName}`,
      type: 'gig',
      isPublic: true,
      isOpenMic,
      source: 'agentic_ingest',
      geoLat: lat,
      geoLng: lng,
      geohash6,
      geohash4,
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

  // Provide current date for context
  const today = new Date().toISOString().split('T')[0];

  const prompt = `
Extract gig events from this webpage. Return ONLY valid JSON.

TODAY'S DATE: ${today}

STRICT RULES:
- venueName: Include city if mentioned (e.g., "Queens Hotel Macclesfield")
- artistName: Band/artist name only
- date: YYYY-MM-DD format. If only day/month given (e.g., "Friday 17th October"), infer the year from today's date
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
      },
      enrichments: {
        address: topGooglePlace.formatted_address,
        website: topGooglePlace.website
      },
      matched_venue: {
        id: placeIdMatch.id,
        name: placeIdMatch.name,
        facebookUrl: placeIdMatch.facebookUrl,
        website: placeIdMatch.website
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
  // Normalize name for comparison
  const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const extractedNorm = normalize(artistName);

  // Handle theme events (not real artists)
  const themePatterns = {
    'open mic': 'OPEN_MIC',
    'openmic': 'OPEN_MIC',
    'open mike': 'OPEN_MIC',
    'tbc': 'SKIP',
    'to be confirmed': 'SKIP',
    'karaoke': 'SKIP',
    'quiz': 'SKIP',
    'quiz night': 'SKIP'
  };

  for (const [pattern, action] of Object.entries(themePatterns)) {
    if (extractedNorm.includes(pattern)) {
      return {
        action,
        confidence: 1.0,
        reasons: ['theme_event'],
        theme: pattern
      };
    }
  }

  // Load all artists from BNDY API
  const artistsResponse = await axios.get(`${BNDY_API_BASE}/api/artists`);
  const allArtists = artistsResponse.data || [];

  // Find exact name match
  const exactMatch = allArtists.find(a => normalize(a.name) === extractedNorm);
  if (exactMatch) {
    return {
      action: 'MATCH_EXISTING',
      artist_id: exactMatch.id,
      confidence: 0.7,
      reasons: ['name_exact'],
      matched_artist: {
        id: exactMatch.id,
        name: exactMatch.name,
        location: exactMatch.location,
        facebookUrl: exactMatch.facebookUrl,
        instagramUrl: exactMatch.instagramUrl,
        websiteUrl: exactMatch.websiteUrl
      }
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

    // Process events in parallel for speed (must complete within 30s API Gateway timeout)
    const processPromises = extractedEvents.map(async (extractedEvent) => {
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
        // Grouping keys for UI
        venue_group_key: generateGroupKey(extractedEvent.venueName),
        artist_group_key: generateGroupKey(extractedEvent.artistName),
        created_at: new Date().toISOString()
      };

      await dynamodb.send(new PutCommand({
        TableName: QUEUE_TABLE,
        Item: queueItem
      }));

      return queueId;
    });

    const queueIds = await Promise.all(processPromises);

    console.log(`Loaded ${queueIds.length} events into queue`);

    return createResponse(200, {
      success: true,
      extracted: extractedEvents.length,
      queued: queueIds.length
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

    // Check if venue already has Facebook in social_media_urls
    const socialMediaUrls = venue.social_media_urls || [];
    const hasFacebook = socialMediaUrls.some(s => s.platform === 'facebook' && s.url);

    if (!hasFacebook) {
      // Add Facebook URL to social_media_urls array
      const updatedSocialMedia = [
        ...socialMediaUrls,
        { platform: 'facebook', url: facebookUrl }
      ];

      await dynamodb.send(new UpdateCommand({
        TableName: VENUES_TABLE,
        Key: { id: venueId },
        UpdateExpression: 'SET social_media_urls = :urls, updated_at = :now',
        ExpressionAttributeValues: {
          ':urls': updatedSocialMedia,
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

// Standalone endpoint for bulk venue enrichment
async function enrichVenueFacebook(event) {
  const authResult = requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const body = event.body ? JSON.parse(event.body) : null;
  if (!body || !body.venueId || !body.facebookUrl) {
    return createResponse(400, { error: 'venueId and facebookUrl required' });
  }

  try {
    await enrichVenueWithFacebookUrl(body.venueId, body.facebookUrl);
    return createResponse(200, { success: true });
  } catch (error) {
    console.error('Error enriching venue:', error);
    return createResponse(500, { error: 'Failed to enrich venue' });
  }
}

// Standalone endpoint for updating venue Google Place ID
async function updateVenuePlaceId(event) {
  const authResult = requireAuth(event);
  if (authResult.error) {
    return createResponse(401, { error: authResult.error });
  }

  const body = event.body ? JSON.parse(event.body) : null;
  if (!body || !body.venueId || !body.googlePlaceId) {
    return createResponse(400, { error: 'venueId and googlePlaceId required' });
  }

  try {
    await dynamodb.send(new UpdateCommand({
      TableName: VENUES_TABLE,
      Key: { id: body.venueId },
      UpdateExpression: 'SET google_place_id = :placeId, updated_at = :now',
      ExpressionAttributeValues: {
        ':placeId': body.googlePlaceId,
        ':now': new Date().toISOString()
      }
    }));

    console.log(`Updated venue ${body.venueId} with Google Place ID: ${body.googlePlaceId}`);
    return createResponse(200, { success: true });
  } catch (error) {
    console.error('Error updating venue Place ID:', error);
    return createResponse(500, { error: 'Failed to update venue' });
  }
}

function generateNaturalKey(venueId, artistId, date) {
  const crypto = require('crypto');
  const raw = `${venueId}|${artistId}|${date}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function normalizeVenueName(name) {
  // Capitalize "The" at the start, keep rest as-is for display
  let normalized = name.trim();

  // Handle "the" at the start (case-insensitive)
  if (/^the\s+/i.test(normalized)) {
    normalized = 'The ' + normalized.substring(4).trim();
  }

  return normalized;
}

function generateGroupKey(name) {
  const crypto = require('crypto');
  // Normalize name for grouping: lowercase, remove punctuation, collapse whitespace
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return crypto.createHash('sha1').update(normalized).digest('hex').substring(0, 12);
}

// NEW: Venue enrichment endpoint
const VenueSchema = z.object({
  venueName: z.string().min(1).max(100),
  facebookUrl: z.string().url().optional()
});

const VenuesExtractSchema = z.object({
  venues: z.array(VenueSchema).max(200)
});

async function extractVenuesWithLLM(html) {
  const text = htmlToVisibleText(html);
  const clampedText = text.slice(0, 50000);

  const prompt = `
Extract ALL unique venue names and their Facebook URLs from this webpage. Return ONLY valid JSON.

STRICT RULES:
- venueName: Include city if mentioned (e.g., "Queens Hotel Macclesfield", "the Dog Inn Chadderton")
- facebookUrl: Only if there's a Facebook link for that venue
- Extract EVERY unique venue mentioned, not just those with events
- Maximum 200 venues

JSON Schema:
{
  "venues": [
    {
      "venueName": "string",
      "facebookUrl": "https://..." (optional)
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
  const validated = VenuesExtractSchema.parse(parsed);
  return validated.venues;
}

async function extractVenues(event) {
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
    console.log('Extracting venues from HTML...');
    const extractedVenues = await extractVenuesWithLLM(body.html);
    console.log(`Extracted ${extractedVenues.length} venues`);

    const results = {
      perfectMatches: [],
      newVenues: [],
      totalExtracted: extractedVenues.length
    };

    for (const extracted of extractedVenues) {
      const venueResolution = await resolveVenue(extracted.venueName, locationContext);

      const result = {
        extractedName: extracted.venueName,
        facebookUrl: extracted.facebookUrl,
        resolution: venueResolution
      };

      if (venueResolution.confidence === 0.99 && venueResolution.venue_id) {
        // Perfect match - can enrich immediately
        results.perfectMatches.push({
          ...result,
          venueId: venueResolution.venue_id,
          currentFacebookUrl: venueResolution.matched_venue?.facebookUrl,
          needsEnrichment: !venueResolution.matched_venue?.facebookUrl && extracted.facebookUrl
        });
      } else {
        // New venue or uncertain match
        results.newVenues.push(result);
      }
    }

    console.log(`Perfect matches: ${results.perfectMatches.length}, New venues: ${results.newVenues.length}`);

    return createResponse(200, results);

  } catch (error) {
    console.error('Error in extractVenues:', error);
    return createResponse(500, { error: 'Failed to extract venues: ' + error.message });
  }
}

/**
 * POST /api/ingest/bulk-import
 *
 * Bulk import structured data (artists, venues, events) with deduplication.
 * Uses resolveVenue() for Google Places lookup + duplicate checking.
 * Uses resolveArtist() for artist name matching.
 *
 * Body: {
 *   artists: { [localId]: { name, act_type, genres, location, urls, bio } },
 *   venues: { [localId]: { name, location: { town, region }, urls } },
 *   events: { [localId]: { artist_id, venue_id, date, time, title } },
 *   options?: { locationContext?: string, dryRun?: boolean }
 * }
 *
 * Returns: {
 *   success: true,
 *   artistIdMap: { [localId]: bndyUuid },
 *   venueIdMap: { [localId]: bndyUuid },
 *   results: { artists: {...}, venues: {...}, events: {...} }
 * }
 */
async function handleBulkImport(event) {
  console.log('BULK_IMPORT: Starting bulk import');

  const body = event.body ? JSON.parse(event.body) : null;
  if (!body) {
    return createResponse(400, { error: 'Request body required' });
  }

  const { artists = {}, venues = {}, events = {}, options = {} } = body;
  const locationContext = options.locationContext || 'Greater Manchester, UK';
  const dryRun = options.dryRun || false;

  // Support pre-computed ID maps from chunked imports
  const precomputedArtistIdMap = options.artistIdMap || {};
  const precomputedVenueIdMap = options.venueIdMap || {};

  console.log(`BULK_IMPORT: Processing ${Object.keys(artists).length} artists, ${Object.keys(venues).length} venues, ${Object.keys(events).length} events`);
  console.log(`BULK_IMPORT: Location context: ${locationContext}, Dry run: ${dryRun}`);
  if (Object.keys(precomputedArtistIdMap).length > 0 || Object.keys(precomputedVenueIdMap).length > 0) {
    console.log(`BULK_IMPORT: Using precomputed ID maps (${Object.keys(precomputedArtistIdMap).length} artists, ${Object.keys(precomputedVenueIdMap).length} venues)`);
  }

  const results = {
    artists: { created: [], matched: [], failed: [] },
    venues: { created: [], matched: [], failed: [] },
    events: { created: [], skipped: [], failed: [] }
  };

  // Merge precomputed ID maps with any new ones from this batch
  const artistIdMap = { ...precomputedArtistIdMap };  // localId -> bndyUuid
  const venueIdMap = { ...precomputedVenueIdMap };   // localId -> bndyUuid

  // ========== PHASE 1: Process Artists ==========
  console.log('BULK_IMPORT: Phase 1 - Processing artists');

  for (const [localId, artistData] of Object.entries(artists)) {
    try {
      console.log(`  Artist: ${artistData.name} (${localId})`);

      const resolution = await resolveArtist(artistData.name, null);

      if (resolution.action === 'MATCH_EXISTING') {
        artistIdMap[localId] = resolution.artist_id;
        results.artists.matched.push({
          localId,
          bndyId: resolution.artist_id,
          name: artistData.name,
          matchedName: resolution.matched_artist?.name
        });
        console.log(`    -> MATCHED: ${resolution.artist_id}`);

      } else if (resolution.action === 'SKIP') {
        results.artists.failed.push({
          localId,
          name: artistData.name,
          reason: `Theme event: ${resolution.theme}`
        });
        console.log(`    -> SKIPPED: ${resolution.theme}`);

      } else if (resolution.action === 'CREATE_NEW' || resolution.action === 'OPEN_MIC') {
        if (dryRun) {
          artistIdMap[localId] = `DRY_RUN_${localId}`;
          results.artists.created.push({ localId, name: artistData.name, dryRun: true });
          console.log(`    -> WOULD CREATE (dry run)`);
        } else {
          const artistId = uuidv4();
          const newArtist = {
            id: artistId,
            name: artistData.name,
            artist_type: (artistData.act_type || 'band').toLowerCase(),
            genres: artistData.genres || [],
            bio: artistData.bio || '',
            location: artistData.location?.city || artistData.location?.region || null,
            isVerified: false,
            source: 'bulk_import',
            ai_created: true,
            createdAt: new Date().toISOString()
          };

          // Extract URLs
          if (artistData.urls && Array.isArray(artistData.urls)) {
            for (const urlObj of artistData.urls) {
              if (urlObj.kind === 'facebook') newArtist.facebookUrl = urlObj.url;
              if (urlObj.kind === 'instagram') newArtist.instagramUrl = urlObj.url;
              if (urlObj.kind === 'spotify') newArtist.spotifyUrl = urlObj.url;
              if (urlObj.kind === 'website') newArtist.websiteUrl = urlObj.url;
            }
          }

          await dynamodb.send(new PutCommand({
            TableName: ARTISTS_TABLE,
            Item: newArtist
          }));

          artistIdMap[localId] = artistId;
          results.artists.created.push({ localId, bndyId: artistId, name: artistData.name });
          console.log(`    -> CREATED: ${artistId}`);
        }
      }
    } catch (error) {
      console.error(`    -> ERROR: ${error.message}`);
      results.artists.failed.push({ localId, name: artistData.name, error: error.message });
    }
  }

  // ========== PHASE 2: Process Venues ==========
  console.log('BULK_IMPORT: Phase 2 - Processing venues');

  for (const [localId, venueData] of Object.entries(venues)) {
    try {
      const city = venueData.location?.town || venueData.location?.region || 'UK';
      console.log(`  Venue: ${venueData.name}, ${city} (${localId})`);

      const resolution = await resolveVenue(venueData.name, `${city}, UK`);

      if (resolution.action === 'MATCH_EXISTING') {
        venueIdMap[localId] = resolution.venue_id;
        results.venues.matched.push({
          localId,
          bndyId: resolution.venue_id,
          name: venueData.name,
          matchedName: resolution.matched_venue?.name,
          confidence: resolution.confidence
        });
        console.log(`    -> MATCHED: ${resolution.venue_id} (${resolution.confidence})`);

      } else if (resolution.action === 'CREATE_NEW') {
        if (!resolution.enrichments?.googlePlaceId) {
          results.venues.failed.push({
            localId,
            name: venueData.name,
            reason: 'No Google Place found'
          });
          console.log(`    -> FAILED: No Google Place found`);
          continue;
        }

        if (dryRun) {
          venueIdMap[localId] = `DRY_RUN_${localId}`;
          results.venues.created.push({
            localId,
            name: venueData.name,
            googlePlaceId: resolution.enrichments.googlePlaceId,
            dryRun: true
          });
          console.log(`    -> WOULD CREATE (dry run)`);
        } else {
          const venueId = uuidv4();
          const newVenue = {
            id: venueId,
            name: venueData.name,
            validated: false,
            source: 'bulk_import',
            ai_created: true,
            needs_review: true,
            createdAt: new Date().toISOString(),
            ...resolution.enrichments,
            latitude: resolution.location?.lat || 0,
            longitude: resolution.location?.lng || 0,
            location: {
              lat: resolution.location?.lat || 0,
              lng: resolution.location?.lng || 0
            }
          };

          // Extract Facebook URL if provided
          if (venueData.urls && Array.isArray(venueData.urls)) {
            const fbUrl = venueData.urls.find(u => u.kind === 'facebook');
            if (fbUrl) {
              newVenue.social_media_urls = [{ platform: 'facebook', url: fbUrl.url }];
            }
          }

          await dynamodb.send(new PutCommand({
            TableName: VENUES_TABLE,
            Item: newVenue
          }));

          venueIdMap[localId] = venueId;
          results.venues.created.push({
            localId,
            bndyId: venueId,
            name: venueData.name,
            googlePlaceId: resolution.enrichments.googlePlaceId
          });
          console.log(`    -> CREATED: ${venueId}`);
        }
      }
    } catch (error) {
      console.error(`    -> ERROR: ${error.message}`);
      results.venues.failed.push({ localId, name: venueData.name, error: error.message });
    }
  }

  // ========== PHASE 3: Process Events ==========
  console.log('BULK_IMPORT: Phase 3 - Processing events');

  for (const [localId, eventData] of Object.entries(events)) {
    try {
      const artistBndyId = artistIdMap[eventData.artist_id];
      const venueBndyId = venueIdMap[eventData.venue_id];

      console.log(`  Event: ${eventData.date} - artist:${eventData.artist_id} @ venue:${eventData.venue_id} (${localId})`);

      if (!artistBndyId) {
        results.events.skipped.push({
          localId,
          reason: `Artist not imported: ${eventData.artist_id}`
        });
        console.log(`    -> SKIPPED: Artist not imported`);
        continue;
      }

      if (!venueBndyId) {
        results.events.skipped.push({
          localId,
          reason: `Venue not imported: ${eventData.venue_id}`
        });
        console.log(`    -> SKIPPED: Venue not imported`);
        continue;
      }

      if (dryRun) {
        results.events.created.push({
          localId,
          artistId: artistBndyId,
          venueId: venueBndyId,
          date: eventData.date,
          dryRun: true
        });
        console.log(`    -> WOULD CREATE (dry run)`);
        continue;
      }

      // Get venue for geohash
      const venueResult = await dynamodb.send(new GetCommand({
        TableName: VENUES_TABLE,
        Key: { id: venueBndyId }
      }));
      const venue = venueResult.Item;

      // Get artist for title
      const artistResult = await dynamodb.send(new GetCommand({
        TableName: ARTISTS_TABLE,
        Key: { id: artistBndyId }
      }));
      const artist = artistResult.Item;

      const eventId = uuidv4();
      const eventDate = eventData.date;
      const eventTime = eventData.time || '20:00';

      // Compute geohash
      const lat = venue?.latitude || venue?.location?.lat || 0;
      const lng = venue?.longitude || venue?.location?.lng || 0;
      const geohash6 = (lat && lng) ? ngeohash.encode(lat, lng, 6) : null;
      const geohash4 = (lat && lng) ? ngeohash.encode(lat, lng, 4) : null;

      const naturalKey = generateNaturalKey(venueBndyId, artistBndyId, eventDate);

      const newEvent = {
        id: eventId,
        naturalKey,
        venueId: venueBndyId,
        artistId: artistBndyId,
        date: eventDate,
        startTime: eventTime,
        endTime: '23:00',
        title: eventData.title || `${artist?.name || 'Artist'} @ ${venue?.name || 'Venue'}`,
        type: 'gig',
        isPublic: true,
        source: 'bulk_import',
        geoLat: lat,
        geoLng: lng,
        geohash6,
        geohash4,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await dynamodb.send(new PutCommand({
        TableName: EVENTS_TABLE,
        Item: newEvent
      }));

      results.events.created.push({
        localId,
        bndyId: eventId,
        date: eventDate,
        title: newEvent.title
      });
      console.log(`    -> CREATED: ${eventId}`);

    } catch (error) {
      console.error(`    -> ERROR: ${error.message}`);
      results.events.failed.push({ localId, error: error.message });
    }
  }

  // ========== Summary ==========
  console.log('BULK_IMPORT: Complete');
  console.log(`  Artists: ${results.artists.created.length} created, ${results.artists.matched.length} matched, ${results.artists.failed.length} failed`);
  console.log(`  Venues: ${results.venues.created.length} created, ${results.venues.matched.length} matched, ${results.venues.failed.length} failed`);
  console.log(`  Events: ${results.events.created.length} created, ${results.events.skipped.length} skipped, ${results.events.failed.length} failed`);

  return createResponse(200, {
    success: true,
    dryRun,
    artistIdMap,
    venueIdMap,
    results,
    summary: {
      artists: {
        total: Object.keys(artists).length,
        created: results.artists.created.length,
        matched: results.artists.matched.length,
        failed: results.artists.failed.length
      },
      venues: {
        total: Object.keys(venues).length,
        created: results.venues.created.length,
        matched: results.venues.matched.length,
        failed: results.venues.failed.length
      },
      events: {
        total: Object.keys(events).length,
        created: results.events.created.length,
        skipped: results.events.skipped.length,
        failed: results.events.failed.length
      }
    }
  });
}

exports.handler = async (event) => {
  currentEvent = event;
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

    if (routeKey === 'POST /api/ingest/extract-venues') {
      return await extractVenues(event);
    }

    if (routeKey === 'POST /api/ingest/enrich-venue-facebook') {
      return await enrichVenueFacebook(event);
    }

    if (routeKey === 'POST /api/ingest/update-venue-placeid') {
      return await updateVenuePlaceId(event);
    }

    if (routeKey === 'POST /api/ingest/bulk-import') {
      return await handleBulkImport(event);
    }

    return createResponse(404, { error: 'Route not found' });

  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};
