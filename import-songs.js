// Import songs data to DynamoDB
const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');

AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

async function importSongs() {
  console.log('🎶 Importing songs to DynamoDB...');

  try {
    // Read songs data
    const songsPath = path.join(__dirname, '..', 'bndy-dataconsolidation', 'migration', 'data', 'songs.json');
    const songsData = JSON.parse(fs.readFileSync(songsPath, 'utf8'));

    console.log(`Found ${songsData.length} songs to import`);

    // Process in batches of 25 (DynamoDB batch limit)
    for (let i = 0; i < songsData.length; i += 25) {
      const batch = songsData.slice(i, i + 25);

      const putRequests = batch.map(song => ({
        PutRequest: {
          Item: {
            id: song.id, // Use existing ID as primary key
            title: song.title,
            artistName: song.artistName || '',
            duration: song.duration || null,
            genre: song.genre || '',
            releaseDate: song.releaseDate || null,
            album: song.album || null,
            spotifyUrl: song.streamingUrls?.spotify || '',
            appleMusicUrl: song.streamingUrls?.appleMusic || '',
            youtubeUrl: song.streamingUrls?.youtube || '',
            audioFileUrl: song.audioFileUrl || '',
            isFeatured: song.isFeatured || false,
            tags: song.tags || [],
            created_at: song.createdAt || new Date().toISOString(),
            updated_at: song.updatedAt || new Date().toISOString()
          }
        }
      }));

      const params = {
        RequestItems: {
          'bndy-songs': putRequests
        }
      };

      await dynamodb.batchWrite(params).promise();
      console.log(`✅ Imported batch ${Math.floor(i/25) + 1}/${Math.ceil(songsData.length/25)} (${batch.length} songs)`);

      // Small delay to avoid throttling
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log('🎉 Songs import complete!');

    // Verify the import
    const result = await dynamodb.scan({
      TableName: 'bndy-songs',
      Select: 'COUNT'
    }).promise();

    console.log(`📊 Total songs in DynamoDB: ${result.Count}`);

  } catch (error) {
    console.error('❌ Import failed:', error);
  }
}

importSongs();