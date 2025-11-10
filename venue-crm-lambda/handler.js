const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

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
      'Access-Control-Allow-Origin': '*',
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
    };
  } catch (error) {
    console.error('Error enriching artist-venue:', error);
    return null;
  }
}

exports.handler = async (event) => {
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
      const artistId = event.pathParameters?.artistId;
      const body = parseBody(event);

      if (!artistId || !body) {
        return createResponse(400, { error: 'Artist ID and body are required' });
      }

      const { venueId, notes, customVenueName } = body;

      if (!venueId) {
        return createResponse(400, { error: 'venueId is required' });
      }

      // Check if venue exists
      const venueResult = await dynamodb.get({
        TableName: 'bndy-venues',
        Key: { id: venueId },
      }).promise();

      if (!venueResult.Item) {
        return createResponse(404, { error: 'Venue not found' });
      }

      // Check if relationship already exists
      const existingResult = await dynamodb.query({
        TableName: 'bndy-artist-venues',
        IndexName: 'artist_id-index',
        KeyConditionExpression: 'artist_id = :artistId',
        FilterExpression: 'venue_id = :venueId',
        ExpressionAttributeValues: {
          ':artistId': artistId,
          ':venueId': venueId,
        },
      }).promise();

      if (existingResult.Items && existingResult.Items.length > 0) {
        return createResponse(409, { error: 'Venue relationship already exists' });
      }

      const now = new Date().toISOString();
      const artistVenue = {
        id: uuidv4(),
        artist_id: artistId,
        venue_id: venueId,
        notes: notes || '',
        custom_venue_name: customVenueName || null,
        first_gig_date: null,
        managed_on_bndy: Boolean(venueResult.Item.managed_by_user_id),
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

    // Route not found
    return createResponse(404, { error: 'Route not found' });

  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: error.message });
  }
};
