const AWS = require('aws-sdk');
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

async function checkArtistSongs() {
  const result = await dynamodb.query({
    TableName: 'bndy-artist-songs',
    IndexName: 'artist_id-status-index',
    KeyConditionExpression: 'artist_id = :artistId',
    ExpressionAttributeValues: {
      ':artistId': '13944bfd-89ab-402e-95dc-a371fd78fd2f'
    }
  }).promise();

  console.log('Total songs for The Torrists:', result.Items.length);
  
  const songsWithoutSongId = result.Items.filter(item => !item.song_id);
  console.log('\nSongs without song_id:', songsWithoutSongId.length);
  
  if (songsWithoutSongId.length > 0) {
    console.log('\nDetails of songs without song_id:');
    songsWithoutSongId.forEach(song => {
      console.log(JSON.stringify({
        id: song.id,
        status: song.status,
        song_id: song.song_id,
        custom_key: song.custom_key,
        custom_tempo: song.custom_tempo,
        created_at: song.created_at
      }, null, 2));
    });
  }
}

checkArtistSongs().catch(console.error);
