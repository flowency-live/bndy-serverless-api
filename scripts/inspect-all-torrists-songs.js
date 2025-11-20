const AWS = require('aws-sdk');
AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

async function inspectAllSongs() {
  const result = await dynamodb.query({
    TableName: 'bndy-artist-songs',
    IndexName: 'artist_id-status-index',
    KeyConditionExpression: 'artist_id = :artistId AND #status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':artistId': '13944bfd-89ab-402e-95dc-a371fd78fd2f',
      ':status': 'playbook'
    }
  }).promise();

  console.log('Total playbook songs: ' + result.Items.length);

  const songsWithDetails = await Promise.all(
    result.Items.map(async (artistSong) => {
      if (!artistSong.song_id) {
        return {
          artistSongId: artistSong.id,
          title: 'NO_SONG_ID_ORPHANED',
          custom_key: artistSong.custom_key,
          created_at: artistSong.created_at,
          updated_at: artistSong.updated_at,
          hasError: true
        };
      }

      try {
        const globalResult = await dynamodb.get({
          TableName: 'bndy-songs',
          Key: { id: artistSong.song_id }
        }).promise();

        return {
          artistSongId: artistSong.id,
          song_id: artistSong.song_id,
          title: globalResult.Item?.title || 'TITLE_MISSING',
          custom_key: artistSong.custom_key,
          globalKey: globalResult.Item?.metadata?.key || null,
          created_at: artistSong.created_at,
          updated_at: artistSong.updated_at,
          hasError: false
        };
      } catch (error) {
        return {
          artistSongId: artistSong.id,
          song_id: artistSong.song_id,
          title: 'ERROR_FETCHING',
          custom_key: artistSong.custom_key,
          created_at: artistSong.created_at,
          updated_at: artistSong.updated_at,
          hasError: true,
          error: error.message
        };
      }
    })
  );

  songsWithDetails.sort((a, b) => a.title.localeCompare(b.title));

  console.log('\nALL SONGS IN PLAYBOOK:\n');

  songsWithDetails.forEach((song, index) => {
    const num = index + 1;
    console.log(num + '. ' + song.title);
    console.log('   ID: ' + song.artistSongId);
    if (song.song_id) console.log('   SongID: ' + song.song_id);
    console.log('   CustomKey: ' + (song.custom_key || 'NOT_SET'));
    if (song.globalKey) console.log('   GlobalKey: ' + song.globalKey);
    console.log('   Updated: ' + song.updated_at);
    if (song.hasError) console.log('   ERROR');
    console.log('');
  });

  console.log('SUMMARY:');
  console.log('Total: ' + songsWithDetails.length);
  console.log('With custom_key: ' + songsWithDetails.filter(s => s.custom_key).length);
  console.log('Without custom_key: ' + songsWithDetails.filter(s => !s.custom_key).length);
  console.log('Errors: ' + songsWithDetails.filter(s => s.hasError).length);
}

inspectAllSongs().catch(console.error);
