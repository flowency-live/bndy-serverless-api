// Check actual Firestore song structure
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

async function checkSong() {
  const snapshot = await firestore.collection('bf_base_songs')
    .where('title', '==', "You're So Vain")
    .limit(1)
    .get();

  if (snapshot.empty) {
    console.log('Song not found');
    return;
  }

  const doc = snapshot.docs[0];
  const data = doc.data();

  console.log('Full Firestore document for "You\'re So Vain":');
  console.log(JSON.stringify(data, null, 2));
}

checkSong()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
