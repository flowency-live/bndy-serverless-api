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
    console.log('[VENUE-CRM] JWT_SECRET loaded from SSM');
    return JWT_SECRET;
  } catch (error) {
    console.error('[VENUE-CRM] Failed to get JWT_SECRET from SSM:', error.message);
    if (process.env.JWT_SECRET) {
      JWT_SECRET = process.env.JWT_SECRET;
      console.log('[VENUE-CRM] JWT_SECRET loaded from environment variable (fallback)');
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
    console.error('[VENUE-CRM] Invalid session token:', error.message);
    return { error: 'Invalid session' };
  }
};

const ALLOWED_ORIGINS = [
  'https://www.bndy.co.uk',       // Primary domain
  'https://backstage.bndy.co.uk', // Legacy domain
  'https://bndy.co.uk',            // Apex domain
  'https://live.bndy.co.uk',      // Frontstage
  'https://gigmap.bndy.co.uk',    // GigMap
  'http://localhost:3000'          // Local development
];

let currentEvent = null;

const getAllowedOrigin = () => {
  const requestOrigin = currentEvent?.headers?.origin || currentEvent?.headers?.Origin;
  return ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : ALLOWED_ORIGINS[0];
};

// Helper: Parse JSON body
function parseBody(event) {
  try {
    return typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch (error) {
    console.error('Failed to parse body:', error);
    return null;
  }
}

// Helper: Create response
function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': getAllowedOrigin(),
      'Access-Control-Allow-Credentials': true,
    },
    body: JSON.stringify(body),
  };
}

// Helper: Enrich artist-venue with venue details and counts
async function enrichArtistVenue(artistVenue) {
  try {
    // Fetch venue details
    const venueResult = await dynamodb.get({
      TableName: 'bndy-venues',
      Key: { id: artistVenue.venue_id },
    }).promise();

    if (!venueResult.Item) {
      console.log(`Venue not found: ${artistVenue.venue_id}`);
      return null;
    }

    const venue = venueResult.Item;

    // Count contacts
    const contactsResult = await dynamodb.query({
      TableName: 'bndy-artist-venue-contacts',
      IndexName: 'artist_venue_id-index',
      KeyConditionExpression: 'artist_venue_id = :artistVenueId',
      ExpressionAttributeValues: {
        ':artistVenueId': artistVenue.id,
      },
      Select: 'COUNT',
    }).promise();

    // Count gigs (query bndy-events)
    const gigsResult = await dynamodb.query({
      TableName: 'bndy-events',
      IndexName: 'artistId-date-index',
      KeyConditionExpression: 'artistId = :artistId',
      FilterExpression: 'venueId = :venueId',
      ExpressionAttributeValues: {
        ':artistId': artistVenue.artist_id,
        ':venueId': artistVenue.venue_id,
      },
      Select: 'COUNT',
    }).promise();

    // Count notes
    const notesResult = await dynamodb.query({
      TableName: 'bndy-venue-notes',
      IndexName: 'artist_venue_id-index',
      KeyConditionExpression: 'artist_venue_id = :artistVenueId',
      ExpressionAttributeValues: {
        ':artistVenueId': artistVenue.id,
      },
      Select: 'COUNT',
    }).promise();

    // Compute managed_on_bndy flag
    const managedOnBndy = Boolean(venue.managed_by_user_id);

    return {
      ...artistVenue,
      managed_on_bndy: managedOnBndy,
      venue: {
        id: venue.id,
        name: venue.name,
        address: venue.address,
        city: venue.city,
        postcode: venue.postcode,
        latitude: venue.latitude,
        longitude: venue.longitude,
        googlePlaceId: venue.googlePlaceId,
        website: venue.website,
        phone: venue.phone,
      },
      contactCount: contactsResult.Count || 0,
      gigCount: gigsResult.Count || 0,
      noteCount: notesResult.Count || 0,
    };
  } catch (error) {
    console.error('Error enriching artist-venue:', error);
    return null;
  }
}

exports.handler = async (event) => {
  currentEvent = event;
  console.log('Venue CRM Lambda Event:', JSON.stringify(event, null, 2));

  const path = event.requestContext?.http?.path || event.path || '';
  const method = event.requestContext?.http?.method || event.httpMethod || '';

  try {
    // GET /api/artists/{artistId}/crm/venues - List all venues for artist
    if (method === 'GET' && path.match(/\/api\/artists\/[^/]+\/crm\/venues$/)) {
      const artistId = event.pathParameters?.artistId;

      if (!artistId) {
        return createResponse(400, { error: 'Artist ID is required' });
      }

      const result = await dynamodb.query({
        TableName: 'bndy-artist-venues',
        IndexName: 'artist_id-index',
        KeyConditionExpression: 'artist_id = :artistId',
        ExpressionAttributeValues: {
          ':artistId': artistId,
        },
        ScanIndexForward: false, // Most recent first
      }).promise();

      // Enrich with venue details and counts
      const enrichedVenues = await Promise.all(
        result.Items.map(item => enrichArtistVenue(item))
      );

      // Filter out null results (venues that no longer exist)
      const validVenues = enrichedVenues.filter(v => v !== null);

      return createResponse(200, validVenues);
    }

    // POST /api/artists/{artistId}/crm/venues - Create artist-venue relationship
    if (method === 'POST' && path.match(/\/api\/artists\/[^/]+\/crm\/venues$/)) {
      // SEC-04: Require authentication for CRM venue creation
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return createResponse(401, { error: authResult.error });
      }

      const artistId = event.pathParameters?.artistId;
      const body = parseBody(event);

      if (!artistId || !body) {
        return createResponse(400, { error: 'Artist ID and body are required' });
      }

      const { venueId, notes, customVenueName, newVenueData } = body;

      let finalVenueId = venueId;

      // If newVenueData is provided, create the venue first
      if (newVenueData) {
        const { name, address, city, postcode, googlePlaceId, latitude, longitude, socialMediaUrls } = newVenueData;

        if (!name || !address) {
          return createResponse(400, { error: 'newVenueData requires name and address' });
        }

        // Generate a new venue ID
        finalVenueId = uuidv4();
        const now = new Date().toISOString();

        const newVenue = {
          id: finalVenueId,
          name,
          address,
          city: city || null,
          postcode: postcode || null,
          googlePlaceId: googlePlaceId || null,
          latitude: latitude || 0,
          longitude: longitude || 0,
          created_at: now,
          updated_at: now,
        };

        // Add social media URLs if provided
        if (socialMediaUrls && Array.isArray(socialMediaUrls) && socialMediaUrls.length > 0) {
          newVenue.socialMediaUrls = socialMediaUrls;
        }

        await dynamodb.put({
          TableName: 'bndy-venues',
          Item: newVenue,
        }).promise();

        console.log('Created new venue:', finalVenueId, name);
      } else {
        // Existing venue flow - check if it exists
        if (!finalVenueId) {
          return createResponse(400, { error: 'venueId is required when not creating a new venue' });
        }

        const venueResult = await dynamodb.get({
          TableName: 'bndy-venues',
          Key: { id: finalVenueId },
        }).promise();

        if (!venueResult.Item) {
          return createResponse(404, { error: 'Venue not found' });
        }
      }

      // Check if relationship already exists
      const existingResult = await dynamodb.query({
        TableName: 'bndy-artist-venues',
        IndexName: 'artist_id-index',
        KeyConditionExpression: 'artist_id = :artistId',
        FilterExpression: 'venue_id = :venueId',
        ExpressionAttributeValues: {
          ':artistId': artistId,
          ':venueId': finalVenueId,
        },
      }).promise();

      if (existingResult.Items && existingResult.Items.length > 0) {
        return createResponse(409, { error: 'Venue relationship already exists' });
      }

      // Fetch venue details for managed_on_bndy flag
      const finalVenueResult = await dynamodb.get({
        TableName: 'bndy-venues',
        Key: { id: finalVenueId },
      }).promise();

      const now = new Date().toISOString();
      const artistVenue = {
        id: uuidv4(),
        artist_id: artistId,
        venue_id: finalVenueId,
        notes: notes || '',
        custom_venue_name: customVenueName || null,
        first_gig_date: null,
        managed_on_bndy: Boolean(finalVenueResult.Item?.managed_by_user_id),
        last_venue_update_at: null,
        created_at: now,
        updated_at: now,
      };

      await dynamodb.put({
        TableName: 'bndy-artist-venues',
        Item: artistVenue,
      }).promise();

      // Enrich before returning
      const enriched = await enrichArtistVenue(artistVenue);

      return createResponse(201, enriched);
    }

    // PUT /api/artists/{artistId}/crm/venues/{venueId} - Update notes/custom name
    if (method === 'PUT' && path.match(/\/api\/artists\/[^/]+\/crm\/venues\/[^/]+$/)) {
      // SEC-04: Require authentication for CRM venue update
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return createResponse(401, { error: authResult.error });
      }

      const artistId = event.pathParameters?.artistId;
      const venueId = event.pathParameters?.venueId;
      const body = parseBody(event);

      if (!artistId || !venueId || !body) {
        return createResponse(400, { error: 'Artist ID, venue ID, and body are required' });
      }

      // Find the artist-venue relationship
      const queryResult = await dynamodb.query({
        TableName: 'bndy-artist-venues',
        IndexName: 'artist_id-index',
        KeyConditionExpression: 'artist_id = :artistId',
        FilterExpression: 'venue_id = :venueId',
        ExpressionAttributeValues: {
          ':artistId': artistId,
          ':venueId': venueId,
        },
      }).promise();

      if (!queryResult.Items || queryResult.Items.length === 0) {
        return createResponse(404, { error: 'Venue relationship not found' });
      }

      const artistVenue = queryResult.Items[0];

      // Build update expression
      const updates = [];
      const attributeValues = {};
      const attributeNames = {};

      if (body.notes !== undefined) {
        updates.push('#notes = :notes');
        attributeValues[':notes'] = body.notes;
        attributeNames['#notes'] = 'notes';
      }

      if (body.customVenueName !== undefined) {
        updates.push('custom_venue_name = :customVenueName');
        attributeValues[':customVenueName'] = body.customVenueName;
      }

      updates.push('updated_at = :updatedAt');
      attributeValues[':updatedAt'] = new Date().toISOString();

      await dynamodb.update({
        TableName: 'bndy-artist-venues',
        Key: { id: artistVenue.id },
        UpdateExpression: `SET ${updates.join(', ')}`,
        ExpressionAttributeValues: attributeValues,
        ...(Object.keys(attributeNames).length > 0 && { ExpressionAttributeNames: attributeNames }),
      }).promise();

      // Fetch updated item and enrich
      const updatedResult = await dynamodb.get({
        TableName: 'bndy-artist-venues',
        Key: { id: artistVenue.id },
      }).promise();

      const enriched = await enrichArtistVenue(updatedResult.Item);

      return createResponse(200, enriched);
    }

    // DELETE /api/artists/{artistId}/crm/venues/{venueId} - Delete relationship + cascade contacts
    if (method === 'DELETE' && path.match(/\/api\/artists\/[^/]+\/crm\/venues\/[^/]+$/)) {
      // SEC-04: Require authentication for CRM venue deletion
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return createResponse(401, { error: authResult.error });
      }

      const artistId = event.pathParameters?.artistId;
      const venueId = event.pathParameters?.venueId;

      if (!artistId || !venueId) {
        return createResponse(400, { error: 'Artist ID and venue ID are required' });
      }

      // Find the artist-venue relationship
      const queryResult = await dynamodb.query({
        TableName: 'bndy-artist-venues',
        IndexName: 'artist_id-index',
        KeyConditionExpression: 'artist_id = :artistId',
        FilterExpression: 'venue_id = :venueId',
        ExpressionAttributeValues: {
          ':artistId': artistId,
          ':venueId': venueId,
        },
      }).promise();

      if (!queryResult.Items || queryResult.Items.length === 0) {
        return createResponse(404, { error: 'Venue relationship not found' });
      }

      const artistVenue = queryResult.Items[0];

      // Cascade delete: Query contacts
      const contactsResult = await dynamodb.query({
        TableName: 'bndy-artist-venue-contacts',
        IndexName: 'artist_venue_id-index',
        KeyConditionExpression: 'artist_venue_id = :artistVenueId',
        ExpressionAttributeValues: {
          ':artistVenueId': artistVenue.id,
        },
      }).promise();

      // Delete all contacts (batch delete)
      if (contactsResult.Items && contactsResult.Items.length > 0) {
        const deleteRequests = contactsResult.Items.map(contact => ({
          DeleteRequest: {
            Key: { id: contact.id },
          },
        }));

        // BatchWriteItem has 25-item limit, chunk if needed
        for (let i = 0; i < deleteRequests.length; i += 25) {
          const chunk = deleteRequests.slice(i, i + 25);
          await dynamodb.batchWrite({
            RequestItems: {
              'bndy-artist-venue-contacts': chunk,
            },
          }).promise();
        }
      }

      // Delete the artist-venue relationship
      await dynamodb.delete({
        TableName: 'bndy-artist-venues',
        Key: { id: artistVenue.id },
      }).promise();

      return createResponse(204, {});
    }

    // GET /api/artists/{artistId}/crm/venues/{venueId}/contacts - List contacts
    if (method === 'GET' && path.match(/\/api\/artists\/[^/]+\/crm\/venues\/[^/]+\/contacts$/)) {
      const artistId = event.pathParameters?.artistId;
      const venueId = event.pathParameters?.venueId;

      if (!artistId || !venueId) {
        return createResponse(400, { error: 'Artist ID and venue ID are required' });
      }

      // Find artist-venue relationship
      const queryResult = await dynamodb.query({
        TableName: 'bndy-artist-venues',
        IndexName: 'artist_id-index',
        KeyConditionExpression: 'artist_id = :artistId',
        FilterExpression: 'venue_id = :venueId',
        ExpressionAttributeValues: {
          ':artistId': artistId,
          ':venueId': venueId,
        },
      }).promise();

      if (!queryResult.Items || queryResult.Items.length === 0) {
        return createResponse(404, { error: 'Venue relationship not found' });
      }

      const artistVenue = queryResult.Items[0];

      // Query contacts
      const contactsResult = await dynamodb.query({
        TableName: 'bndy-artist-venue-contacts',
        IndexName: 'artist_venue_id-index',
        KeyConditionExpression: 'artist_venue_id = :artistVenueId',
        ExpressionAttributeValues: {
          ':artistVenueId': artistVenue.id,
        },
      }).promise();

      return createResponse(200, contactsResult.Items || []);
    }

    // POST /api/artists/{artistId}/crm/venues/{venueId}/contacts - Create contact
    if (method === 'POST' && path.match(/\/api\/artists\/[^/]+\/crm\/venues\/[^/]+\/contacts$/)) {
      // SEC-04: Require authentication for CRM contact creation
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return createResponse(401, { error: authResult.error });
      }

      const artistId = event.pathParameters?.artistId;
      const venueId = event.pathParameters?.venueId;
      const body = parseBody(event);

      if (!artistId || !venueId || !body) {
        return createResponse(400, { error: 'Artist ID, venue ID, and body are required' });
      }

      const { name, mobile, landline, email } = body;

      if (!name) {
        return createResponse(400, { error: 'Contact name is required' });
      }

      // Find artist-venue relationship
      const queryResult = await dynamodb.query({
        TableName: 'bndy-artist-venues',
        IndexName: 'artist_id-index',
        KeyConditionExpression: 'artist_id = :artistId',
        FilterExpression: 'venue_id = :venueId',
        ExpressionAttributeValues: {
          ':artistId': artistId,
          ':venueId': venueId,
        },
      }).promise();

      if (!queryResult.Items || queryResult.Items.length === 0) {
        return createResponse(404, { error: 'Venue relationship not found' });
      }

      const artistVenue = queryResult.Items[0];

      const now = new Date().toISOString();
      const contact = {
        id: uuidv4(),
        artist_venue_id: artistVenue.id,
        artist_id: artistId,
        venue_id: venueId,
        name: name,
        mobile: mobile || null,
        landline: landline || null,
        email: email || null,
        contact_type: 'artist_added',
        source_venue_contact_id: null,
        created_at: now,
        updated_at: now,
      };

      await dynamodb.put({
        TableName: 'bndy-artist-venue-contacts',
        Item: contact,
      }).promise();

      return createResponse(201, contact);
    }

    // PUT /api/artists/{artistId}/crm/venues/{venueId}/contacts/{contactId} - Update contact
    if (method === 'PUT' && path.match(/\/api\/artists\/[^/]+\/crm\/venues\/[^/]+\/contacts\/[^/]+$/)) {
      // SEC-04: Require authentication for CRM contact update
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return createResponse(401, { error: authResult.error });
      }

      const contactId = event.pathParameters?.contactId;
      const body = parseBody(event);

      if (!contactId || !body) {
        return createResponse(400, { error: 'Contact ID and body are required' });
      }

      // Fetch existing contact
      const contactResult = await dynamodb.get({
        TableName: 'bndy-artist-venue-contacts',
        Key: { id: contactId },
      }).promise();

      if (!contactResult.Item) {
        return createResponse(404, { error: 'Contact not found' });
      }

      // Build update expression
      const updates = [];
      const attributeValues = {};

      if (body.name !== undefined) {
        updates.push('#name = :name');
        attributeValues[':name'] = body.name;
      }

      if (body.mobile !== undefined) {
        updates.push('mobile = :mobile');
        attributeValues[':mobile'] = body.mobile;
      }

      if (body.landline !== undefined) {
        updates.push('landline = :landline');
        attributeValues[':landline'] = body.landline;
      }

      if (body.email !== undefined) {
        updates.push('email = :email');
        attributeValues[':email'] = body.email;
      }

      updates.push('updated_at = :updatedAt');
      attributeValues[':updatedAt'] = new Date().toISOString();

      await dynamodb.update({
        TableName: 'bndy-artist-venue-contacts',
        Key: { id: contactId },
        UpdateExpression: `SET ${updates.join(', ')}`,
        ExpressionAttributeValues: attributeValues,
        ExpressionAttributeNames: { '#name': 'name' },
      }).promise();

      // Fetch updated contact
      const updatedResult = await dynamodb.get({
        TableName: 'bndy-artist-venue-contacts',
        Key: { id: contactId },
      }).promise();

      return createResponse(200, updatedResult.Item);
    }

    // DELETE /api/artists/{artistId}/crm/venues/{venueId}/contacts/{contactId} - Delete contact
    if (method === 'DELETE' && path.match(/\/api\/artists\/[^/]+\/crm\/venues\/[^/]+\/contacts\/[^/]+$/)) {
      // SEC-04: Require authentication for CRM contact deletion
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return createResponse(401, { error: authResult.error });
      }

      const contactId = event.pathParameters?.contactId;

      if (!contactId) {
        return createResponse(400, { error: 'Contact ID is required' });
      }

      await dynamodb.delete({
        TableName: 'bndy-artist-venue-contacts',
        Key: { id: contactId },
      }).promise();

      return createResponse(204, {});
    }

    // GET /api/artists/{artistId}/crm/venues/{venueId}/gigs - Get gig history for venue
    if (method === 'GET' && path.match(/\/api\/artists\/[^/]+\/crm\/venues\/[^/]+\/gigs$/)) {
      const { artistId, venueId } = event.pathParameters || {};

      if (!artistId || !venueId) {
        return createResponse(400, { error: 'Artist ID and Venue ID are required' });
      }

      // Query all events for this artist at this venue
      const result = await dynamodb.query({
        TableName: 'bndy-events',
        IndexName: 'artistId-date-index',
        KeyConditionExpression: 'artistId = :artistId',
        FilterExpression: 'venueId = :venueId AND (#type = :gigType OR #type = :publicGigType)',
        ExpressionAttributeNames: {
          '#type': 'type',
        },
        ExpressionAttributeValues: {
          ':artistId': artistId,
          ':venueId': venueId,
          ':gigType': 'gig',
          ':publicGigType': 'public_gig',
        },
      }).promise();

      // Sort by date (newest first)
      const gigs = (result.Items || []).sort((a, b) => {
        return new Date(b.date) - new Date(a.date);
      });

      return createResponse(200, gigs);
    }

    // GET /api/artists/{artistId}/crm/venues/{venueId}/notes - List notes for venue
    if (method === 'GET' && path.match(/\/api\/artists\/[^/]+\/crm\/venues\/[^/]+\/notes$/)) {
      const artistId = event.pathParameters?.artistId;
      const venueId = event.pathParameters?.venueId;

      if (!artistId || !venueId) {
        return createResponse(400, { error: 'Artist ID and venue ID are required' });
      }

      // Find artist-venue relationship
      const queryResult = await dynamodb.query({
        TableName: 'bndy-artist-venues',
        IndexName: 'artist_id-index',
        KeyConditionExpression: 'artist_id = :artistId',
        FilterExpression: 'venue_id = :venueId',
        ExpressionAttributeValues: {
          ':artistId': artistId,
          ':venueId': venueId,
        },
      }).promise();

      if (!queryResult.Items || queryResult.Items.length === 0) {
        return createResponse(404, { error: 'Venue relationship not found' });
      }

      const artistVenue = queryResult.Items[0];

      // Query notes (most recent first with ScanIndexForward: false)
      const notesResult = await dynamodb.query({
        TableName: 'bndy-venue-notes',
        IndexName: 'artist_venue_id-index',
        KeyConditionExpression: 'artist_venue_id = :artistVenueId',
        ExpressionAttributeValues: {
          ':artistVenueId': artistVenue.id,
        },
        ScanIndexForward: false,
      }).promise();

      return createResponse(200, notesResult.Items || []);
    }

    // POST /api/artists/{artistId}/crm/venues/{venueId}/notes - Create note
    if (method === 'POST' && path.match(/\/api\/artists\/[^/]+\/crm\/venues\/[^/]+\/notes$/)) {
      // SEC-04: Require authentication for CRM note creation
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return createResponse(401, { error: authResult.error });
      }

      const artistId = event.pathParameters?.artistId;
      const venueId = event.pathParameters?.venueId;
      const body = parseBody(event);

      if (!artistId || !venueId || !body) {
        return createResponse(400, { error: 'Artist ID, venue ID, and body are required' });
      }

      const { note_text, created_by_user_id, created_by_display_name } = body;

      if (!note_text || !created_by_user_id || !created_by_display_name) {
        return createResponse(400, { error: 'note_text, created_by_user_id, and created_by_display_name are required' });
      }

      // Find artist-venue relationship
      const queryResult = await dynamodb.query({
        TableName: 'bndy-artist-venues',
        IndexName: 'artist_id-index',
        KeyConditionExpression: 'artist_id = :artistId',
        FilterExpression: 'venue_id = :venueId',
        ExpressionAttributeValues: {
          ':artistId': artistId,
          ':venueId': venueId,
        },
      }).promise();

      if (!queryResult.Items || queryResult.Items.length === 0) {
        return createResponse(404, { error: 'Venue relationship not found' });
      }

      const artistVenue = queryResult.Items[0];

      const now = new Date().toISOString();
      const note = {
        id: uuidv4(),
        artist_venue_id: artistVenue.id,
        artist_id: artistId,
        venue_id: venueId,
        note_text: note_text,
        created_by_user_id: created_by_user_id,
        created_by_display_name: created_by_display_name,
        is_edited: false,
        created_at: now,
        updated_at: now,
      };

      await dynamodb.put({
        TableName: 'bndy-venue-notes',
        Item: note,
      }).promise();

      return createResponse(201, note);
    }

    // PUT /api/artists/{artistId}/crm/venues/{venueId}/notes/{noteId} - Update note
    if (method === 'PUT' && path.match(/\/api\/artists\/[^/]+\/crm\/venues\/[^/]+\/notes\/[^/]+$/)) {
      // SEC-04: Require authentication for CRM note update
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return createResponse(401, { error: authResult.error });
      }

      const noteId = event.pathParameters?.noteId;
      const body = parseBody(event);

      if (!noteId || !body) {
        return createResponse(400, { error: 'Note ID and body are required' });
      }

      const { note_text, user_id } = body;

      if (!note_text || !user_id) {
        return createResponse(400, { error: 'note_text and user_id are required' });
      }

      // Fetch existing note
      const noteResult = await dynamodb.get({
        TableName: 'bndy-venue-notes',
        Key: { id: noteId },
      }).promise();

      if (!noteResult.Item) {
        return createResponse(404, { error: 'Note not found' });
      }

      // Check ownership
      if (noteResult.Item.created_by_user_id !== user_id) {
        return createResponse(403, { error: 'You can only edit your own notes' });
      }

      // Update note
      await dynamodb.update({
        TableName: 'bndy-venue-notes',
        Key: { id: noteId },
        UpdateExpression: 'SET note_text = :noteText, is_edited = :isEdited, updated_at = :updatedAt',
        ExpressionAttributeValues: {
          ':noteText': note_text,
          ':isEdited': true,
          ':updatedAt': new Date().toISOString(),
        },
      }).promise();

      // Fetch updated note
      const updatedResult = await dynamodb.get({
        TableName: 'bndy-venue-notes',
        Key: { id: noteId },
      }).promise();

      return createResponse(200, updatedResult.Item);
    }

    // DELETE /api/artists/{artistId}/crm/venues/{venueId}/notes/{noteId} - Delete note
    if (method === 'DELETE' && path.match(/\/api\/artists\/[^/]+\/crm\/venues\/[^/]+\/notes\/[^/]+$/)) {
      // SEC-04: Require authentication for CRM note deletion
      const authResult = await requireAuth(event);
      if (authResult.error) {
        return createResponse(401, { error: authResult.error });
      }

      const noteId = event.pathParameters?.noteId;
      const queryParams = event.queryStringParameters || {};
      const userId = queryParams.user_id;

      if (!noteId || !userId) {
        return createResponse(400, { error: 'Note ID and user_id are required' });
      }

      // Fetch existing note
      const noteResult = await dynamodb.get({
        TableName: 'bndy-venue-notes',
        Key: { id: noteId },
      }).promise();

      if (!noteResult.Item) {
        return createResponse(404, { error: 'Note not found' });
      }

      // Check ownership
      if (noteResult.Item.created_by_user_id !== userId) {
        return createResponse(403, { error: 'You can only delete your own notes' });
      }

      await dynamodb.delete({
        TableName: 'bndy-venue-notes',
        Key: { id: noteId },
      }).promise();

      return createResponse(204, {});
    }

    // Route not found
    return createResponse(404, { error: 'Route not found' });

  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: error.message });
  }
};
