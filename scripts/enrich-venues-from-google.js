// Enrich all venues with Google Places data (city, phone, website)
// Uses batching and rate limiting to respect API quotas

const AWS = require('aws-sdk');
const https = require('https');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });
const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
if (!GOOGLE_API_KEY) {
  throw new Error('Set GOOGLE_PLACES_API_KEY before running this script.');
}

// Configuration
const BATCH_SIZE = 50; // Process 50 venues at a time
const DELAY_BETWEEN_REQUESTS = 200; // 200ms = 5 requests/second (well under 10/sec limit)
const DELAY_BETWEEN_BATCHES = 5000; // 5 seconds between batches

// Statistics tracking
const stats = {
  total: 0,
  enriched: 0,
  failed: 0,
  skipped: 0,
  errors: []
};

// Extract city from Google Places address_components
// Priority: postal_town (UK) > locality > administrative_area_level_2
function extractCity(addressComponents) {
  if (!addressComponents || addressComponents.length === 0) {
    return null;
  }

  // Priority 1: postal_town (primary UK city field)
  const postalTown = addressComponents.find(component =>
    component.types.includes('postal_town')
  );
  if (postalTown) {
    return postalTown.long_name;
  }

  // Priority 2: locality (general city field)
  const locality = addressComponents.find(component =>
    component.types.includes('locality')
  );
  if (locality) {
    return locality.long_name;
  }

  // Priority 3: administrative_area_level_2 (county/region fallback)
  const adminArea2 = addressComponents.find(component =>
    component.types.includes('administrative_area_level_2')
  );
  if (adminArea2) {
    return adminArea2.long_name;
  }

  return null;
}

// Fetch place details from Google Places API
function getPlaceDetails(placeId) {
  return new Promise((resolve, reject) => {
    const fields = 'address_components,formatted_phone_number,website';
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${fields}&key=${GOOGLE_API_KEY}`;

    https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.status === 'OK') {
            resolve(result.result);
          } else if (result.status === 'ZERO_RESULTS' || result.status === 'NOT_FOUND') {
            resolve(null); // Place no longer exists
          } else {
            reject(new Error(`Google Places API error: ${result.status} - ${result.error_message || ''}`));
          }
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

// Update venue in DynamoDB
async function updateVenue(venueId, updates) {
  const updateExpressions = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {
    ':updated_at': new Date().toISOString()
  };

  // Build dynamic update expression
  if (updates.city !== undefined) {
    updateExpressions.push('city = :city');
    expressionAttributeValues[':city'] = updates.city;
  }

  if (updates.phone !== undefined) {
    updateExpressions.push('phone = :phone');
    expressionAttributeValues[':phone'] = updates.phone;
  }

  if (updates.website !== undefined) {
    updateExpressions.push('website = :website');
    expressionAttributeValues[':website'] = updates.website;
  }

  updateExpressions.push('updated_at = :updated_at');

  const params = {
    TableName: 'bndy-venues',
    Key: { id: venueId },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'NONE'
  };

  if (Object.keys(expressionAttributeNames).length > 0) {
    params.ExpressionAttributeNames = expressionAttributeNames;
  }

  await dynamodb.update(params).promise();
}

// Process a single venue
async function processVenue(venue) {
  const venueId = venue.id;
  const venueName = venue.name;
  const googlePlaceId = venue.google_place_id;

  console.log(`[${stats.total + 1}] Processing: ${venueName} (${venueId})`);

  // Skip if no Google Place ID
  if (!googlePlaceId || googlePlaceId === '') {
    console.log(`  ⏭️  Skipped: No Google Place ID`);
    stats.skipped++;
    return;
  }

  // Skip if already has city, phone, and website
  if (venue.city && venue.phone && venue.website) {
    console.log(`  ⏭️  Skipped: Already has city, phone, and website`);
    stats.skipped++;
    return;
  }

  try {
    // Fetch from Google Places API
    const placeDetails = await getPlaceDetails(googlePlaceId);

    if (!placeDetails) {
      console.log(`  ⚠️  Warning: Place not found in Google Places API`);
      stats.failed++;
      stats.errors.push({ venueId, venueName, error: 'Place not found' });
      return;
    }

    // Extract data
    const updates = {};

    // Extract city
    if (!venue.city && placeDetails.address_components) {
      const city = extractCity(placeDetails.address_components);
      if (city) {
        updates.city = city;
      }
    }

    // Extract phone
    if (!venue.phone && placeDetails.formatted_phone_number) {
      updates.phone = placeDetails.formatted_phone_number;
    }

    // Extract website
    if (!venue.website && placeDetails.website) {
      updates.website = placeDetails.website;
    }

    // Update if we have any new data
    if (Object.keys(updates).length > 0) {
      await updateVenue(venueId, updates);
      console.log(`  ✅ Enriched: ${Object.keys(updates).join(', ')}`);
      stats.enriched++;
    } else {
      console.log(`  ⏭️  Skipped: No new data available`);
      stats.skipped++;
    }

  } catch (error) {
    console.error(`  ❌ Error: ${error.message}`);
    stats.failed++;
    stats.errors.push({ venueId, venueName, error: error.message });
  }
}

// Sleep utility
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Main execution
async function main() {
  console.log('============================================');
  console.log('BNDY Venues Enrichment from Google Places');
  console.log('============================================\n');
  console.log(`Batch size: ${BATCH_SIZE} venues`);
  console.log(`Rate limit: ${1000 / DELAY_BETWEEN_REQUESTS} requests/second`);
  console.log(`Delay between batches: ${DELAY_BETWEEN_BATCHES}ms\n`);

  try {
    // Scan all venues
    console.log('Fetching all venues from DynamoDB...\n');
    const scanParams = {
      TableName: 'bndy-venues',
      FilterExpression: 'attribute_exists(google_place_id) AND google_place_id <> :empty',
      ExpressionAttributeValues: {
        ':empty': ''
      }
    };

    const result = await dynamodb.scan(scanParams).promise();
    const venues = result.Items;

    console.log(`Found ${venues.length} venues with Google Place IDs\n`);
    console.log('Starting enrichment...\n');

    // Process in batches
    for (let i = 0; i < venues.length; i += BATCH_SIZE) {
      const batch = venues.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(venues.length / BATCH_SIZE);

      console.log(`\n========== BATCH ${batchNum}/${totalBatches} (${batch.length} venues) ==========\n`);

      // Process each venue in batch with delay
      for (const venue of batch) {
        stats.total++;
        await processVenue(venue);
        await sleep(DELAY_BETWEEN_REQUESTS);
      }

      // Delay between batches (except for last batch)
      if (i + BATCH_SIZE < venues.length) {
        console.log(`\n⏸️  Waiting ${DELAY_BETWEEN_BATCHES}ms before next batch...\n`);
        await sleep(DELAY_BETWEEN_BATCHES);
      }
    }

    // Print final statistics
    console.log('\n============================================');
    console.log('ENRICHMENT COMPLETE');
    console.log('============================================\n');
    console.log(`Total venues processed: ${stats.total}`);
    console.log(`✅ Successfully enriched: ${stats.enriched}`);
    console.log(`⏭️  Skipped (already complete or no Place ID): ${stats.skipped}`);
    console.log(`❌ Failed: ${stats.failed}\n`);

    if (stats.errors.length > 0) {
      console.log('Errors:');
      stats.errors.forEach((error, index) => {
        console.log(`  ${index + 1}. ${error.venueName} (${error.venueId}): ${error.error}`);
      });
      console.log('');
    }

    console.log('============================================\n');

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run the script
main();