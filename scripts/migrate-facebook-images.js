// Migration script to fetch Facebook profile images for existing artists
// Run with: node scripts/migrate-facebook-images.js

const AWS = require('aws-sdk');
const https = require('https');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: 'eu-west-2' });

/**
 * Extract Facebook username from URL
 */
function extractFacebookUsername(url) {
  if (!url) return null;

  try {
    // Handle profile.php?id= format
    if (url.includes('profile.php?id=')) {
      const match = url.match(/id=(\d+)/);
      return match ? match[1] : null;
    }

    // Handle standard facebook.com/username format
    const match = url.match(/facebook\.com\/([a-zA-Z0-9.]{2,}[^/?]*)/);
    if (!match) return null;

    const username = match[1];

    // Filter out non-username paths
    const excludedPaths = ['profile.php', 'people', 'pages', 'groups', 'events', 'photos', 'videos', 'p'];
    if (excludedPaths.includes(username)) return null;

    return username;
  } catch (error) {
    console.error('Error extracting Facebook username:', error);
    return null;
  }
}

/**
 * Check if a URL returns a valid image
 */
function checkImageExists(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = res.headers.location;
        https.get(redirectUrl, (redirectRes) => {
          resolve(redirectRes.statusCode === 200 && redirectRes.headers['content-type']?.startsWith('image/'));
        }).on('error', () => resolve(false));
      } else {
        resolve(res.statusCode === 200 && res.headers['content-type']?.startsWith('image/'));
      }
    }).on('error', () => resolve(false));
  });
}

/**
 * Fetch Facebook profile picture URL
 */
async function fetchFacebookProfilePicture(facebookUrl) {
  if (!facebookUrl) return null;

  // Strip trailing slash - Graph API is sensitive to it
  const cleanUrl = facebookUrl.trim().replace(/\/$/, '');

  const username = extractFacebookUsername(cleanUrl);
  if (!username) {
    return null;
  }

  const profilePicUrl = `https://graph.facebook.com/${username}/picture?type=large`;
  const exists = await checkImageExists(profilePicUrl);

  if (exists) {
    return profilePicUrl;
  }

  return null;
}

/**
 * Main migration function
 */
async function migrateArtistImages() {
  console.log('Starting Facebook image migration...\n');

  try {
    // Scan all artists
    const scanParams = {
      TableName: 'bndy-artists',
      ProjectionExpression: 'id, #name, facebookUrl, profileImageUrl',
      ExpressionAttributeNames: {
        '#name': 'name'
      }
    };

    const result = await dynamodb.scan(scanParams).promise();
    const artists = result.Items;

    console.log(`Found ${artists.length} total artists\n`);

    // Filter artists that need Facebook image fetch
    const artistsNeedingImages = artists.filter(artist => {
      return artist.facebookUrl && !artist.profileImageUrl;
    });

    console.log(`${artistsNeedingImages.length} artists need Facebook images\n`);

    let successCount = 0;
    let failCount = 0;
    let skipCount = 0;

    // Process each artist
    for (let i = 0; i < artistsNeedingImages.length; i++) {
      const artist = artistsNeedingImages[i];

      console.log(`[${i + 1}/${artistsNeedingImages.length}] Processing: ${artist.name}`);
      console.log(`  Facebook URL: ${artist.facebookUrl}`);

      try {
        // Fetch Facebook image
        const fbImage = await fetchFacebookProfilePicture(artist.facebookUrl);

        if (fbImage) {
          // Update artist with new image
          const updateParams = {
            TableName: 'bndy-artists',
            Key: { id: artist.id },
            UpdateExpression: 'SET profileImageUrl = :profileImageUrl, updated_at = :updated_at',
            ExpressionAttributeValues: {
              ':profileImageUrl': fbImage,
              ':updated_at': new Date().toISOString()
            }
          };

          await dynamodb.update(updateParams).promise();
          console.log(`  ✓ Successfully fetched and stored image`);
          successCount++;
        } else {
          console.log(`  ✗ Could not fetch Facebook image`);
          failCount++;
        }
      } catch (error) {
        console.error(`  ✗ Error processing artist:`, error.message);
        failCount++;
      }

      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('\n===========================================');
    console.log('Migration complete!');
    console.log(`Total artists: ${artists.length}`);
    console.log(`Needed images: ${artistsNeedingImages.length}`);
    console.log(`Successfully fetched: ${successCount}`);
    console.log(`Failed to fetch: ${failCount}`);
    console.log(`Already had images: ${artists.length - artistsNeedingImages.length}`);
    console.log('===========================================');

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

// Run migration
migrateArtistImages();
