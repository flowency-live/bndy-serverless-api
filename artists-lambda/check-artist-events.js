// Check which of the duplicate artists have events pointing to them
// Only safe to delete artists with NO events

const AWS = require('aws-sdk');

AWS.config.update({ region: 'eu-west-2' });
const dynamodb = new AWS.DynamoDB.DocumentClient();

// Artists identified as duplicates
const DUPLICATE_ARTISTS = [
  { id: 'ffc99392-989c-4989-b86e-1a7f206b71f5', name: 'Andy Bussey' },
  { id: '7c1cbf5c-da4b-4b27-950b-1806c4c0626f', name: 'Andy Bussey' },
  { id: '63d3f78c-f1f3-45f8-8b96-ad2308f65038', name: 'The Ant Hill Mob' },
  { id: '04ec8d8d-f16a-4edf-8449-b11ce8ace95d', name: 'Anthill Mob' },
  { id: '74905f85-925a-452a-963b-d58e5848ac37', name: 'Thick as Thieves' },
  { id: '417962f4-46bb-4b3c-a005-c39aea1b19e9', name: 'Lost Boyz' },
  { id: '4c113f21-28f7-437e-8153-e1f64bd68b90', name: 'Brit Pack' },
  { id: 'ddc1b3e0-5d57-4304-911c-2d296bba207a', name: 'Mojave' },
  { id: 'aedb52b9-6de9-4487-bb73-1aa59880074b', name: 'Amnesia' },
  { id: '22e11870-83ce-46df-b9c7-db52d7b77b54', name: 'Styckleback' },
  { id: '2XApkcrIBjoaX429d6nY', name: 'Total Rex' },
  { id: '90bc7e26-6dfb-4e46-8d38-c79784e93a2b', name: 'JD & the Parrots' },
  { id: '1db507d9-f13a-4eb3-a86c-390fe6d814a9', name: 'The Incredible Skank Brothers' },
  { id: 'b3752a25-9331-4f1f-9cd6-efa8770f3ae3', name: 'Midnight Shift' },
  { id: '3d41ec1b-483d-41d9-b47c-b6100b476419', name: 'The Clementines' },
  { id: 'b447ed89-a494-402c-a95b-ecca89824726', name: 'Kelly Rox' },
  { id: 'i9WCKCA8LpbzWKDtoWXO', name: 'Sonic' },
  { id: 'abecb40a-7213-4a84-a70a-10a19234b6db', name: 'Common People' },
  { id: 'zQdNXfDcXxeUCDIDmjXy', name: 'The Magnetic Jellyfish' },
  { id: '463df1e8-b3d9-465f-8435-2437dd5f195e', name: 'Borderland Band' },
  { id: '8573e476-7041-48c4-975b-e8651e01f9f0', name: 'Undercover Band' },
  { id: 'b8f251b1-2ca5-4bc9-ba4f-6ce1a90ec8ce', name: 'Magic Beans' },
  { id: '29e948e1-162d-4e7b-9cd6-af9baa45529d', name: 'Blind Yeo' },
  { id: '5945e5ef-bdbe-4f7f-b77d-518503dd4d0d', name: 'Eleventh Hour' },
  { id: 'e4178d8d-2bd0-43ef-b1ce-6a97a78fc359', name: 'Sugar Rush Band' },
  { id: 'xFvv503f46ra2NYIZvFf', name: 'Cold Flame' },
  { id: '42de28be-7b0a-4e2d-b8db-53befcb69f39', name: 'The Distant Suns' },
  { id: 'uKGhTCuzlJ9RjE7ZnwWg', name: 'The Brothers' },
];

async function countEventsForArtist(artistId) {
  // Check artistId field
  const params1 = {
    TableName: 'bndy-events',
    FilterExpression: 'artistId = :artistId',
    ExpressionAttributeValues: { ':artistId': artistId },
    Select: 'COUNT'
  };

  let count = 0;
  let lastKey = null;

  do {
    if (lastKey) params1.ExclusiveStartKey = lastKey;
    const result = await dynamodb.scan(params1).promise();
    count += result.Count;
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return count;
}

async function main() {
  console.log('Checking event counts for duplicate artists...\n');
  console.log('=' .repeat(80));

  const safeToDelete = [];
  const hasEvents = [];

  for (const artist of DUPLICATE_ARTISTS) {
    const count = await countEventsForArtist(artist.id);
    const status = count === 0 ? '✓ SAFE' : `✗ ${count} events`;
    console.log(`${status.padEnd(15)} ${artist.id} - "${artist.name}"`);

    if (count === 0) {
      safeToDelete.push(artist);
    } else {
      hasEvents.push({ ...artist, eventCount: count });
    }
  }

  console.log('\n' + '=' .repeat(80));
  console.log(`\nSafe to delete (0 events): ${safeToDelete.length}`);
  console.log(`Has events (DO NOT DELETE): ${hasEvents.length}`);

  if (hasEvents.length > 0) {
    console.log('\nArtists with events (need manual merge):');
    for (const artist of hasEvents) {
      console.log(`  ${artist.id} - "${artist.name}" (${artist.eventCount} events)`);
    }
  }

  if (safeToDelete.length > 0) {
    console.log('\nSafe to delete:');
    for (const artist of safeToDelete) {
      console.log(`  ${artist.id} - "${artist.name}"`);
    }
  }

  return { safeToDelete, hasEvents };
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
