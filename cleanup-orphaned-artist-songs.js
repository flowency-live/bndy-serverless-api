const AWS = require('aws-sdk');
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

const ARTIST_ID = '5e55a762-3dad-4a5c-9e27-018f718f794d'; // Killin Scarlet

async function findOrphanedRecords() {
  console.log(`Finding artist-songs for artist ${ARTIST_ID}...`);

  // Get all artist-songs for this artist
  const artistSongsResult = await dynamodb.scan({
    TableName: 'bndy-artist-songs',
    FilterExpression: 'artist_id = :artistId',
    ExpressionAttributeValues: {
      ':artistId': ARTIST_ID
    }
  }).promise();

  const artistSongs = artistSongsResult.Items || [];
  console.log(`Found ${artistSongs.length} artist-songs`);

  // Check which ones have missing base songs
  const orphaned = [];
  for (const artistSong of artistSongs) {
    try {
      const baseSong = await dynamodb.get({
        TableName: 'bndy-songs',
        Key: { id: artistSong.song_id }
      }).promise();

      if (!baseSong.Item) {
        console.log(`ORPHANED: artist-song ${artistSong.id} references missing song ${artistSong.song_id}`);
        orphaned.push(artistSong);
      }
    } catch (error) {
      console.error(`Error checking song ${artistSong.song_id}:`, error);
    }
  }

  console.log(`\nFound ${orphaned.length} orphaned records`);

  // Delete orphaned records
  if (orphaned.length > 0) {
    console.log('\nDeleting orphaned records...');
    for (const record of orphaned) {
      await dynamodb.delete({
        TableName: 'bndy-artist-songs',
        Key: { id: record.id }
      }).promise();
      console.log(`Deleted orphaned record ${record.id}`);
    }
    console.log(`\nCleanup complete! Deleted ${orphaned.length} orphaned records.`);
  } else {
    console.log('\nNo orphaned records to clean up.');
  }
}

findOrphanedRecords()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
