// Complete Migration: Firestore songs -> DynamoDB with thumbnails and metadata
// Run with: node migrate-songs-complete.js

const admin = require('firebase-admin');
const fs = require('fs');
const AWS = require('aws-sdk');

// Initialize Firebase Admin

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

// Initialize DynamoDB
const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

async function migrateSongs() {
  console.log('Starting complete song migration from Firestore to DynamoDB...');

  try {
    // Get all songs from Firestore
    const songsSnapshot = await firestore.collection('bf_base_songs').get();
    console.log(`Found ${songsSnapshot.size} songs in Firestore`);

    let migrated = 0;
    let failed = 0;
    const errors = [];

    for (const doc of songsSnapshot.docs) {
      const firestoreData = doc.data();

      try {
        // Map Firestore data to DynamoDB format
        const dynamoItem = {
          id: doc.id,
          title: firestoreData.title || '',
          artistName: firestoreData.artist || '',

          // Album info - thumbnail is at root level in Firestore
          album: firestoreData.album || null,
          albumImageUrl: firestoreData.thumbnail || null,

          // Duration and basic info - duration is in metadata object
          duration: firestoreData.metadata?.duration ? parseInt(firestoreData.metadata.duration) : null,
          genre: firestoreData.genre || '',
          releaseDate: firestoreData.releaseDate || null,

          // URLs - spotifyUid and previewUrl are at root level
          spotifyUrl: firestoreData.spotifyUid || '',
          appleMusicUrl: firestoreData.appleMusicUrl || '',
          youtubeUrl: firestoreData.youtubeUrl || '',
          audioFileUrl: firestoreData.audioFileUrl || '',

          // Metadata - store as nested object (bpm, key, duration)
          metadata: firestoreData.metadata ? {
            bpm: firestoreData.metadata.bpm || null,
            key: firestoreData.metadata.key || null,
            duration: firestoreData.metadata.duration || null,
          } : null,

          // Additional fields from root level
          previewUrl: firestoreData.previewUrl || null,
          metadataStatus: firestoreData.metadataStatus || null,
          songAddedBy: firestoreData.songAddedBy || null,

          // Other fields
          isFeatured: firestoreData.isFeatured || false,
          tags: firestoreData.tags || [],

          // Timestamps - convert Firestore timestamps
          createdAt: firestoreData.createdAt?.toDate ? firestoreData.createdAt.toDate().toISOString() : new Date().toISOString(),
          updatedAt: firestoreData.updatedAt?.toDate ? firestoreData.updatedAt.toDate().toISOString() : new Date().toISOString(),
        };

        // Update item in DynamoDB (will overwrite if exists)
        await dynamodb.put({
          TableName: 'bndy-songs',
          Item: dynamoItem
        }).promise();

        migrated++;

        if (migrated % 10 === 0) {
          console.log(`Migrated ${migrated}/${songsSnapshot.size} songs...`);
        }

      } catch (error) {
        failed++;
        errors.push({ id: doc.id, title: firestoreData.title, error: error.message });
        console.error(`Failed to migrate song ${doc.id}:`, error.message);
      }
    }

    console.log('\n=== Migration Complete ===');
    console.log(`Total songs: ${songsSnapshot.size}`);
    console.log(`Successfully migrated: ${migrated}`);
    console.log(`Failed: ${failed}`);

    if (errors.length > 0) {
      console.log('\nFailed songs:');
      errors.forEach(e => console.log(`  - ${e.id} (${e.title}): ${e.error}`));
    }

    // Sample check - verify one song has thumbnail
    const sampleSong = songsSnapshot.docs.find(doc => doc.data().metadata?.thumbnail);
    if (sampleSong) {
      console.log('\nVerifying migration - checking sample song:', sampleSong.data().title);
      const result = await dynamodb.get({
        TableName: 'bndy-songs',
        Key: { id: sampleSong.id }
      }).promise();

      console.log('Sample song in DynamoDB:');
      console.log('  - Title:', result.Item.title);
      console.log('  - Artist:', result.Item.artistName);
      console.log('  - Album Image:', result.Item.albumImageUrl);
      console.log('  - Metadata BPM:', result.Item.metadata?.bpm);
      console.log('  - Metadata Key:', result.Item.metadata?.key);
    }

  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
}

// Run migration
migrateSongs()
  .then(() => {
    console.log('\nMigration completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('\nMigration failed:', error);
    process.exit(1);
  });
