// Import artists data to DynamoDB
const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');

AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

async function importArtists() {
  console.log('🎵 Importing artists to DynamoDB...');

  try {
    // Read artists data
    const artistsPath = path.join(__dirname, '..', 'bndy-dataconsolidation', 'migration', 'data', 'artists.json');
    const artistsData = JSON.parse(fs.readFileSync(artistsPath, 'utf8'));

    console.log(`Found ${artistsData.length} artists to import`);

    // Process in batches of 25 (DynamoDB batch limit)
    for (let i = 0; i < artistsData.length; i += 25) {
      const batch = artistsData.slice(i, i + 25);

      const putRequests = batch.map(artist => ({
        PutRequest: {
          Item: {
            id: artist.id, // Use existing ID as primary key
            name: artist.name,
            bio: artist.bio || '',
            location: artist.location || '',
            genres: artist.genres || [],
            facebookUrl: artist.originalData?.facebookUrl || '',
            instagramUrl: artist.originalData?.instagramUrl || '',
            websiteUrl: artist.originalData?.websiteUrl || '',
            socialMediaUrls: artist.socialMediaURLs || [],
            profileImageUrl: artist.profileImageUrl || '',
            isVerified: artist.isVerified || false,
            followerCount: artist.followerCount || 0,
            claimedByUserId: artist.isClaimed ? 'claimed' : null,
            created_at: artist.createdAt || new Date().toISOString(),
            updated_at: artist.updatedAt || new Date().toISOString()
          }
        }
      }));

      const params = {
        RequestItems: {
          'bndy-artists': putRequests
        }
      };

      await dynamodb.batchWrite(params).promise();
      console.log(`✅ Imported batch ${Math.floor(i/25) + 1}/${Math.ceil(artistsData.length/25)} (${batch.length} artists)`);

      // Small delay to avoid throttling
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log('🎉 Artists import complete!');

    // Verify the import
    const result = await dynamodb.scan({
      TableName: 'bndy-artists',
      Select: 'COUNT'
    }).promise();

    console.log(`📊 Total artists in DynamoDB: ${result.Count}`);

  } catch (error) {
    console.error('❌ Import failed:', error);
  }
}

importArtists();