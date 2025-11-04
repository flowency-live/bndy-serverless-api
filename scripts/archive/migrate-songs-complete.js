// Complete Migration: Firestore songs -> DynamoDB with thumbnails and metadata
// Run with: node migrate-songs-complete.js

const admin = require('firebase-admin');
const AWS = require('aws-sdk');

// Initialize Firebase Admin
const serviceAccount = {
  type: "service_account",
  project_id: "bandflow2025",
  private_key_id: "...",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDV4oNzuT3G7Tmt\nQMVrdomvnYemupKotyY42x6WYo+fc2vHlPQECLSP7nYw8jGIMo2aHQQ11lFJYO+i\n2SbSF2eVsJZpwR4AlAV+e3QiOFxbnPsEe+rzI9PbZQgxYE/ndR5XUxNtBWQGnFXT\nZmNt1R/1gBhvBHxI1MAbkml8e52wnPvrPUHpFG2wSLBueayb/j/AT0tjJwXwIdUM\ny/zxnZtPUGcOfTSisSdeS+HN+bDLmg6IZCDTlzJmBkjaUJvrSZPZALqXbeP5uMtV\npBUJ+oa/SV8fZbpGMvIajAbOurtEUUD7zDATbbOU33FpxQGWyZJUG2CBsZV9rM5a\nfq/cUQDhAgMBAAECggEABKwAyumyT+EXAnUgwtKWAOO+edQhBGxFh1ZajkNU1HFH\nDf1canMKutfR4nFd4Kk/05/IrsjeezorWqaNFqerq9bacddFxmwCGTbNRpSUbuAo\nhJrubg7VQtLyHH4x/9H2K1Pj5hy123LPHJ6js06lfUoyoaH3hlGjjxtrlrKhplQj\nRqVB7T/KYUTx8qEgvT/5xqfmmlEIyuwuyii9HY1esXcZqYYX/Q2lRlpf7z8FF7Iv\nWSbEmOtvetEA9wNsDrqDEfSBM9ejPkTW9MVp60+qwy8mHw9HjvtkByBGRGxYkqB+\nW7gyBGEOy7obNKaaFWGfZu21k2H1/lyVhI8xjNgFmQKBgQD1LJrLhjfKP4EwyC0I\nDMcEtVTX8bw87iDVP1xZqnYp2SfMLMCQ/KcxxAHePB8fyGNQ6Vk4jPOjWPsBI8Hu\nL2vcfdFLWqhNaurcCsCGXpEAd4Mq/C/0e0nS7Iz4jazLFxFQgEbsMdujMzFijUoA\nhw6+de72/zfl+8LKRjZYGjK/eQKBgQDfVDhbxB6+B+U0KTUeaxkqJY+lwiAipAq7\n/dKNqdgcRiFkq2g89LIeDelypFbtUmdloDO9LPLTTj+fY/nRDFmAtigB2hcvvPoc\nOwuiiH02x/nCavctxFa4e78wCRri30W6KRRDw9XoYUSq46+dRc6VFtsupQg+jwfl\nzfALLSzqqQKBgQDAhQQQaRaKBA/oRGfH+HCW6+TxpOrRVZQGn7he2JHtDo5Hr6SO\ntTZ8x5NH9SHjjTEfqfzbgSMX05lWLcPsyuQBwfKFH20lTZ2ap/7CBKQMH8yqBlmJ\nuv4fWIzh6C4VU8nO0sveUNBNeLeA0b2YaHVVbbn1zjcQqv8sYrHtwLS00QKBgQCx\n7bGxOwGbOUMdWa9eeslj0OUvlQhxUOzUdhdokmcBr8YvJHk6B2JZm4/grJotHjgO\nuaI/GC6mt3LtFIQWT5aHe5lIUG+ksxU5pLlSVxgbqxuMEBi6t/C3rq/WH4ryMhyl\ngtEIZGBqcgR5ekmSLem20qzx7r4wyVfreTXEUcu1cQKBgBujvXOZgIZ92pqqRdXL\nNq/5Taal57junShQvzMnFIKlpSz+DZmIOfC4Ls97OaWeFoZVHk4lX4YOLQGZTfBR\n6OMxZCAkgo8AkLXw/J495NUzgIXzhSnrbjoSUlU3OsYU5ppuH8Oqrs5nDHRCC9Pk\nQAmyYCHIbpXLWBcX6QhxQJiE\n-----END PRIVATE KEY-----\n",
  client_email: "firebase-adminsdk-g7zrf@bandflow2025.iam.gserviceaccount.com",
  client_id: "...",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: "..."
};

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
