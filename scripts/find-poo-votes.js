const data = require('../temp-all-songs-with-votes.json');

const songsWithPooVotes = data.Items.filter(song => {
  const votes = song.votes?.M || {};
  return Object.values(votes).some(vote => vote.M?.value?.N === '0');
});

console.log('Total songs with votes:', data.Items.length);
console.log('Songs with poo votes (0):', songsWithPooVotes.length);
console.log('');

songsWithPooVotes.forEach((song, idx) => {
  const votes = song.votes?.M || {};
  const pooVoters = [];
  Object.entries(votes).forEach(([userId, vote]) => {
    if (vote.M?.value?.N === '0') {
      pooVoters.push(userId.substring(0, 12) + '...');
    }
  });

  console.log(`${idx + 1}. Song ID: ${song.id.S}`);
  console.log(`   Artist ID: ${song.artist_id.S}`);
  console.log(`   Status: ${song.status?.S || 'unknown'}`);
  console.log(`   Poo voters: ${pooVoters.join(', ')}`);
  console.log('');
});

// Output JSON for processing
console.log('JSON for updates:');
console.log(JSON.stringify(songsWithPooVotes.map(s => ({
  id: s.id.S,
  artist_id: s.artist_id.S,
  status: s.status?.S
})), null, 2));
