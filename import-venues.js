// Import venues data to DynamoDB
const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');

AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

async function importVenues() {
  console.log('📍 Importing venues to DynamoDB...');

  try {
    // Read venues data
    const venuesPath = path.join(__dirname, '..', 'bndy-dataconsolidation', 'migration', 'data', 'venues.json');
    const venuesData = JSON.parse(fs.readFileSync(venuesPath, 'utf8'));

    console.log(`Found ${venuesData.length} venues to import`);

    // Process in batches of 25 (DynamoDB batch limit)
    for (let i = 0; i < venuesData.length; i += 25) {
      const batch = venuesData.slice(i, i + 25);

      const putRequests = batch.map(venue => ({
        PutRequest: {
          Item: {
            id: venue.firestore_id, // Use Firestore ID as primary key
            name: venue.name,
            address: venue.address,
            latitude: venue.location?.lat || 0,
            longitude: venue.location?.lng || 0,
            location_object: venue.location || {},
            google_place_id: venue.googlePlaceId,
            validated: venue.validated || false,
            name_variants: venue.nameVariants || [],
            phone: venue.phone || '',
            postcode: venue.postcode || '',
            facilities: venue.facilities || [],
            social_media_urls: venue.socialMediaURLs || [],
            profile_image_url: venue.profileImageUrl || null,
            standard_ticketed: venue.standardTicketed || false,
            standard_ticket_information: venue.standardTicketInformation || '',
            standard_ticket_url: venue.standardTicketUrl || '',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        }
      }));

      const params = {
        RequestItems: {
          'bndy-venues': putRequests
        }
      };

      await dynamodb.batchWrite(params).promise();
      console.log(`✅ Imported batch ${Math.floor(i/25) + 1}/${Math.ceil(venuesData.length/25)} (${batch.length} venues)`);

      // Small delay to avoid throttling
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log('🎉 Venues import complete!');

    // Verify the import
    const result = await dynamodb.scan({
      TableName: 'bndy-venues',
      Select: 'COUNT'
    }).promise();

    console.log(`📊 Total venues in DynamoDB: ${result.Count}`);

  } catch (error) {
    console.error('❌ Import failed:', error);
  }
}

importVenues();