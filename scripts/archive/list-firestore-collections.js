// List all Firestore collections
const admin = require('firebase-admin');
const fs = require('fs');


function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    return JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8'));
  }

  throw new Error('Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_PATH before running this archive script.');
}

const serviceAccount = loadServiceAccount();

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const firestore = admin.firestore();

async function listCollections() {
  console.log('Listing all root collections in Firestore...\n');

  const collections = await firestore.listCollections();

  console.log(`Found ${collections.length} root collections:`);
  for (const collection of collections) {
    console.log(`  - ${collection.id}`);

    // Get document count
    const snapshot = await collection.limit(1).get();
    const count = snapshot.size;
    console.log(`    (has ${count > 0 ? 'at least 1' : '0'} document)`);
  }

  // Try to find songs-related collections
  console.log('\nSearching for song-related collections...');
  const possibleNames = ['songs', 'song', 'bndy-songs', 'bandSongs', 'globalSongs'];

  for (const name of possibleNames) {
    try {
      const snapshot = await firestore.collection(name).limit(1).get();
      if (snapshot.size > 0) {
        console.log(`  Found data in: ${name} (${snapshot.size} docs)`);
        const doc = snapshot.docs[0];
        console.log(`  Sample data:`, JSON.stringify(doc.data(), null, 2).substring(0, 200));
      }
    } catch (error) {
      // Collection doesn't exist
    }
  }
}

listCollections()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
