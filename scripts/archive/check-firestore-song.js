// Check actual Firestore song structure
const admin = require('firebase-admin');

const serviceAccount = {
  type: "service_account",
  project_id: "bandflow2025",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDV4oNzuT3G7Tmt\nQMVrdomvnYemupKotyY42x6WYo+fc2vHlPQECLSP7nYw8jGIMo2aHQQ11lFJYO+i\n2SbSF2eVsJZpwR4AlAV+e3QiOFxbnPsEe+rzI9PbZQgxYE/ndR5XUxNtBWQGnFXT\nZmNt1R/1gBhvBHxI1MAbkml8e52wnPvrPUHpFG2wSLBueayb/j/AT0tjJwXwIdUM\ny/zxnZtPUGcOfTSisSdeS+HN+bDLmg6IZCDTlzJmBkjaUJvrSZPZALqXbeP5uMtV\npBUJ+oa/SV8fZbpGMvIajAbOurtEUUD7zDATbbOU33FpxQGWyZJUG2CBsZV9rM5a\nfq/cUQDhAgMBAAECggEABKwAyumyT+EXAnUgwtKWAOO+edQhBGxFh1ZajkNU1HFH\nDf1canMKutfR4nFd4Kk/05/IrsjeezorWqaNFqerq9bacddFxmwCGTbNRpSUbuAo\nhJrubg7VQtLyHH4x/9H2K1Pj5hy123LPHJ6js06lfUoyoaH3hlGjjxtrlrKhplQj\nRqVB7T/KYUTx8qEgvT/5xqfmmlEIyuwuyii9HY1esXcZqYYX/Q2lRlpf7z8FF7Iv\nWSbEmOtvetEA9wNsDrqDEfSBM9ejPkTW9MVp60+qwy8mHw9HjvtkByBGRGxYkqB+\nW7gyBGEOy7obNKaaFWGfZu21k2H1/lyVhI8xjNgFmQKBgQD1LJrLhjfKP4EwyC0I\nDMcEtVTX8bw87iDVP1xZqnYp2SfMLMCQ/KcxxAHePB8fyGNQ6Vk4jPOjWPsBI8Hu\nL2vcfdFLWqhNaurcCsCGXpEAd4Mq/C/0e0nS7Iz4jazLFxFQgEbsMdujMzFijUoA\nhw6+de72/zfl+8LKRjZYGjK/eQKBgQDfVDhbxB6+B+U0KTUeaxkqJY+lwiAipAq7\n/dKNqdgcRiFkq2g89LIeDelypFbtUmdloDO9LPLTTj+fY/nRDFmAtigB2hcvvPoc\nOwuiiH02x/nCavctxFa4e78wCRri30W6KRRDw9XoYUSq46+dRc6VFtsupQg+jwfl\nzfALLSzqqQKBgQDAhQQQaRaKBA/oRGfH+HCW6+TxpOrRVZQGn7he2JHtDo5Hr6SO\ntTZ8x5NH9SHjjTEfqfzbgSMX05lWLcPsyuQBwfKFH20lTZ2ap/7CBKQMH8yqBlmJ\nuv4fWIzh6C4VU8nO0sveUNBNeLeA0b2YaHVVbbn1zjcQqv8sYrHtwLS00QKBgQCx\n7bGxOwGbOUMdWa9eeslj0OUvlQhxUOzUdhdokmcBr8YvJHk6B2JZm4/grJotHjgO\nuaI/GC6mt3LtFIQWT5aHe5lIUG+ksxU5pLlSVxgbqxuMEBi6t/C3rq/WH4ryMhyl\ngtEIZGBqcgR5ekmSLem20qzx7r4wyVfreTXEUcu1cQKBgBujvXOZgIZ92pqqRdXL\nNq/5Taal57junShQvzMnFIKlpSz+DZmIOfC4Ls97OaWeFoZVHk4lX4YOLQGZTfBR\n6OMxZCAkgo8AkLXw/J495NUzgIXzhSnrbjoSUlU3OsYU5ppuH8Oqrs5nDHRCC9Pk\nQAmyYCHIbpXLWBcX6QhxQJiE\n-----END PRIVATE KEY-----\n",
  client_email: "firebase-adminsdk-g7zrf@bandflow2025.iam.gserviceaccount.com",
};

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
