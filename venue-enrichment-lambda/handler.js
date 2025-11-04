// BNDY Venue Enrichment Lambda - Web search + AI verification
// Uses Google Custom Search API to find results, Claude to verify matches

const AWS = require('aws-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const GOOGLE_SEARCH_ENGINE_ID = process.env.GOOGLE_SEARCH_ENGINE_ID;

/**
 * Perform Google Custom Search
 */
function googleSearch(query) {
  return new Promise((resolve, reject) => {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_SEARCH_ENGINE_ID}&q=${encodedQuery}&num=10`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.items) {
            resolve(result.items.map(item => ({
              title: item.title,
              link: item.link,
              snippet: item.snippet
            })));
          } else {
            resolve([]);
          }
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

exports.handler = async (event) => {
  console.log('[Venue Enrichment] Lambda invoked:', JSON.stringify(event));

  try {
    // Parse input
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const { venueId } = body;

    if (!venueId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'venueId is required' })
      };
    }

    // Fetch venue from DynamoDB
    const getParams = {
      TableName: 'bndy-venues',
      Key: { id: venueId }
    };

    const result = await dynamodb.get(getParams).promise();

    if (!result.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Venue not found' })
      };
    }

    const venue = result.Item;
    console.log(`[Venue Enrichment] Processing venue: ${venue.name}`);

    // Extract city/town from address (usually element 2 or 3)
    // Example: "Daintry St, Oakhill, Stoke-on-Trent ST4 5NN, United Kingdom"
    const addressParts = venue.address.split(',').map(p => p.trim());
    const city = addressParts.length >= 3 ? addressParts[2] : addressParts[1] || '';
    const location = city.split(' ')[0]; // Get just city name, remove postcode

    // Perform Google searches with city/town for better accuracy
    const searchQuery = `${venue.name} ${location}`;
    const facebookQuery = `${venue.name} ${location} facebook`;

    console.log(`[Venue Enrichment] Searching Google for: "${searchQuery}"`);
    console.log(`[Venue Enrichment] Searching Google for: "${facebookQuery}"`);

    const [generalResults, facebookResults] = await Promise.all([
      googleSearch(searchQuery),
      googleSearch(facebookQuery)
    ]);

    console.log(`[Venue Enrichment] Found ${generalResults.length} general results, ${facebookResults.length} Facebook results`);

    // Ask Claude to analyze the search results and identify correct URLs
    const prompt = `You are extracting venue URLs from Google search results.

VENUE NAME: ${venue.name}
ADDRESS: ${venue.address}

GENERAL SEARCH:
${generalResults.map((r, i) => `${i + 1}. ${r.title}\n   ${r.link}\n   ${r.snippet}`).join('\n\n')}

FACEBOOK SEARCH:
${facebookResults.map((r, i) => `${i + 1}. ${r.title}\n   ${r.link}\n   ${r.snippet}`).join('\n\n')}

INSTRUCTIONS:
1. WEBSITE: Return result #1 URL from general search UNLESS it's clearly NOT a venue website (e.g., it's a review site like TripAdvisor/Yelp, or it's an aggregator site). If result #1 is wrong, use result #2. If no venue website found in top 3, return null.

2. FACEBOOK: Return the FIRST URL from Facebook search that is a direct Facebook page (facebook.com/username or facebook.com/p/name-id). SKIP any URLs with: /groups/, /events/, /posts/, /share/. If none found, return null.

3. CONFIDENCE:
   - Use HIGH if top search results clearly match the venue's address/location (city, postcode, or area mentioned in search results).
   - Use MEDIUM if you had to use result #2-3, OR if search results are slightly ambiguous but location details are consistent.
   - Use LOW ONLY if you CANNOT determine which venue is correct, OR if the URLs you found clearly DO NOT match this venue's address/location.

Return ONLY valid JSON:
{
  "website": "url or null",
  "facebook": "url or null",
  "confidence": "HIGH",
  "notes": "1-2 sentence explanation"
}`;

    const message = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    // Parse Claude's response
    const responseText = message.content[0].text;
    console.log('[Venue Enrichment] Claude response:', responseText);

    const enrichmentData = JSON.parse(responseText);

    const updates = [];
    const expressionValues = {};
    const expressionNames = {};

    // HIGH confidence: Auto-update venue
    if (enrichmentData.confidence === 'HIGH') {
      console.log(`[Venue Enrichment] HIGH confidence - auto-updating venue ${venue.name}`);

      if (enrichmentData.facebook) {
        const socialMediaUrls = venue.social_media_urls || [];
        const hasFacebook = socialMediaUrls.some(url =>
          typeof url === 'string' && url.includes('facebook.com')
        );

        if (!hasFacebook) {
          socialMediaUrls.push(enrichmentData.facebook);
          updates.push('#social_media_urls = :social_media_urls');
          expressionValues[':social_media_urls'] = socialMediaUrls;
          expressionNames['#social_media_urls'] = 'social_media_urls';
        }
      }

      if (enrichmentData.website && !venue.website) {
        updates.push('website = :website');
        expressionValues[':website'] = enrichmentData.website;
      }

      // Set enrichment status to high_confidence
      updates.push('enrichment_status = :enrichment_status');
      expressionValues[':enrichment_status'] = 'high_confidence';
      updates.push('enrichment_date = :enrichment_date');
      expressionValues[':enrichment_date'] = new Date().toISOString();
      updates.push('updated_at = :updated_at');
      expressionValues[':updated_at'] = new Date().toISOString();

    } else {
      // MEDIUM/LOW confidence: Save for HITL review
      console.log(`[Venue Enrichment] ${enrichmentData.confidence} confidence - flagging for review`);

      updates.push('enrichment_status = :enrichment_status');
      expressionValues[':enrichment_status'] = 'needs_review';
      updates.push('enrichment_data = :enrichment_data');
      expressionValues[':enrichment_data'] = {
        suggested_website: enrichmentData.website,
        suggested_facebook: enrichmentData.facebook,
        confidence: enrichmentData.confidence,
        notes: enrichmentData.notes,
        date: new Date().toISOString()
      };
      updates.push('updated_at = :updated_at');
      expressionValues[':updated_at'] = new Date().toISOString();
    }

    // Perform the update
    if (updates.length > 0) {
      const updateParams = {
        TableName: 'bndy-venues',
        Key: { id: venueId },
        UpdateExpression: `SET ${updates.join(', ')}`,
        ExpressionAttributeValues: expressionValues,
        ...(Object.keys(expressionNames).length > 0 && { ExpressionAttributeNames: expressionNames })
      };

      await dynamodb.update(updateParams).promise();
      console.log(`[Venue Enrichment] Updated venue ${venue.name} with status: ${enrichmentData.confidence}`);

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          venueId,
          enrichmentData,
          status: enrichmentData.confidence === 'HIGH' ? 'auto_updated' : 'flagged_for_review'
        })
      };
    } else {
      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          venueId,
          enrichmentData,
          status: 'no_changes_needed'
        })
      };
    }

  } catch (error) {
    console.error('[ERROR] Venue enrichment failed:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Enrichment failed',
        message: error.message
      })
    };
  }
};
