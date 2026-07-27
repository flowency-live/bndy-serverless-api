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

// CRITICAL: GOOGLE_SEARCH_ENGINE_ID is currently set to "placeholder" in Lambda environment
// This causes Google Custom Search API to return 0 results
// The code now safely aborts enrichment when no results are found
// To enable this feature: Create a Custom Search Engine at https://programmablesearchengine.google.com/
// and update the Lambda environment variable with the real cx value

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

    // Extract city/town from address with smart country detection
    // Handles both patterns:
    // - "Street, City Postcode, United Kingdom" (3 parts)
    // - "Name, Street, City Postcode, Country" (4+ parts)
    const addressParts = venue.address.split(',').map(p => p.trim());

    let cityPart;
    const lastPart = addressParts[addressParts.length - 1];
    const isCountry = ['United Kingdom', 'UK', 'England', 'Scotland', 'Wales', 'Northern Ireland'].includes(lastPart);

    if (isCountry && addressParts.length === 3) {
      // Special case: 3-part address ending in country (e.g., "Street, City Postcode, Country")
      // Use second part which contains the city
      cityPart = addressParts[1];
    } else if (addressParts.length >= 3) {
      // Original working logic for 4+ part addresses
      cityPart = addressParts[2];
    } else if (addressParts.length >= 2) {
      // Fallback to second part
      cityPart = addressParts[1];
    } else {
      cityPart = addressParts[0] || '';
    }

    // Remove UK postcode pattern (e.g., "SK15 1JP", "LA21 8ED") and extract city name
    const location = cityPart
      .replace(/\s+[A-Z]{1,2}\d{1,2}\s*\d[A-Z]{2}$/i, '') // Remove postcode
      .trim()
      .split(' ')[0]; // Get first word

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

    // CRITICAL: Abort if no search results (prevents AI hallucination)
    if (generalResults.length === 0 && facebookResults.length === 0) {
      console.log(`[Venue Enrichment] No search results - skipping enrichment for ${venue.name}`);

      const updateParams = {
        TableName: 'bndy-venues',
        Key: { id: venueId },
        UpdateExpression: 'SET enrichment_status = :status, enrichment_date = :date, updated_at = :updated',
        ExpressionAttributeValues: {
          ':status': 'no_results',
          ':date': new Date().toISOString(),
          ':updated': new Date().toISOString()
        }
      };

      await dynamodb.update(updateParams).promise();

      return {
        statusCode: 200,
        body: JSON.stringify({
          success: true,
          venueId,
          status: 'no_results',
          message: 'No Google search results found - enrichment skipped'
        })
      };
    }

    // Ask Claude to analyze the search results and identify correct URLs
    const prompt = `You are extracting venue URLs from Google search results.

CRITICAL: You MUST ONLY return URLs that appear in the search results below. DO NOT invent or guess URLs. If no search results are provided, return null for all fields.

VENUE NAME: ${venue.name}
ADDRESS: ${venue.address}

GENERAL SEARCH:
${generalResults.map((r, i) => `${i + 1}. ${r.title}\n   ${r.link}\n   ${r.snippet}`).join('\n\n')}

FACEBOOK SEARCH:
${facebookResults.map((r, i) => `${i + 1}. ${r.title}\n   ${r.link}\n   ${r.snippet}`).join('\n\n')}

INSTRUCTIONS:
1. WEBSITE: Look at the GENERAL SEARCH results above. Return the URL from result #1 ONLY if it's clearly the venue's official website. SKIP review sites (TripAdvisor, Yelp, Google), aggregators, or booking sites. If result #1 is not valid, try result #2-3. If no valid website found in the search results, return null. DO NOT invent URLs.

2. FACEBOOK: Look at the FACEBOOK SEARCH results above. Return the FIRST URL that is a direct Facebook page (facebook.com/username or facebook.com/p/name-id). SKIP any URLs with /groups/, /events/, /posts/, /share/. If no valid Facebook URL found in the search results, return null. DO NOT invent URLs.

3. CONFIDENCE:
   - HIGH: Result #1 is clearly this venue's official page
   - MEDIUM: Had to use result #2-3, or venue name is common
   - LOW: Multiple venues with same name, or uncertain match

4. IMPORTANT: If the search results are empty or contain no valid URLs, return null for all fields. NEVER invent or guess URLs based on the venue name.

Return ONLY the JSON object below with no preamble, explanation, or markdown formatting:
{
  "website": "url or null",
  "facebook": "url or null",
  "confidence": "HIGH",
  "notes": "1-2 sentence explanation"
}`;

    const message = await anthropic.messages.create({
      model: 'claude-3-opus-20240229',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    // Parse Claude's response (extract JSON from any preamble text)
    const responseText = message.content[0].text;
    console.log('[Venue Enrichment] Claude response:', responseText);

    // Extract JSON object from response (Claude sometimes adds preamble)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON object found in Claude response');
    }

    const enrichmentData = JSON.parse(jsonMatch[0]);

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
