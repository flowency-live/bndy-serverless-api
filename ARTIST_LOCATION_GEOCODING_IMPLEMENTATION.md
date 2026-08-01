# Artist Location Geocoding - Backend Implementation Guide

**Status**: Ready for Implementation
**Priority**: High - Required for location-based artist search weighting
**Affects**: bndy-serverless-api (artists-lambda), bndy-backstage, bndy-frontstage

---

## Problem Statement

Currently, artist location data is stored as a **text string only** (`location: "Manchester, UK"`), with `locationLat` and `locationLng` fields permanently set to `null`. This prevents:

1. **Accurate distance calculations** between artists and venues
2. **Location-based search ranking** (e.g., showing artists near selected venue first)
3. **Geographic filtering** and analytics

The database schema already supports lat/lng coordinates, but they're never populated.

---

## Current State

### Database Schema (DynamoDB: `bndy-artists`)
```javascript
{
  id: "uuid",
  name: "Artist Name",
  location: "Manchester, UK",        // Text string for display
  locationLat: null,                  // ❌ Always null
  locationLng: null,                  // ❌ Always null
  // ... other fields
}
```

### Frontend Location Types

Artists can have **three types** of locations:

1. **City** (`locationType: 'city'`)
   - Example: `"Manchester, UK"`, `"Stoke-on-Trent, UK"`
   - **Has specific coordinates** from Google Places
   - Should store lat/lng

2. **Region** (`locationType: 'region'`)
   - Example: `"North West England"`, `"Scotland"`, `"London"`
   - **No specific coordinates** (covers large area)
   - lat/lng should remain null

3. **National** (`locationType: 'national'`)
   - Example: `"UK"`, `"England"`
   - **No specific coordinates** (covers entire country)
   - lat/lng should remain null

---

## Required Changes

### 1. Artists Lambda (`artists-lambda/handler.js`)

#### Update `handleCreateCommunityArtist()` Function

**Location**: Lines 961-1062

**Changes Needed**:

```javascript
async function handleCreateCommunityArtist(event) {
  console.log(' Artists Lambda: Creating community artist');

  try {
    const body = JSON.parse(event.body);
    const {
      name,
      location,
      locationType,           // ✅ NEW: Accept locationType from frontend
      locationLat,            // ✅ NEW: Accept lat from frontend (for city type)
      locationLng,            // ✅ NEW: Accept lng from frontend (for city type)
      facebookUrl,
      instagramUrl,
      websiteUrl,
      bio,
      genres,
      artist_type,
      artistType,
      actType,
      acoustic
    } = body;

    // Validation
    if (!name || name.trim().length === 0) {
      return {
        statusCode: 400,
        headers: getCommunityHeaders(),
        body: JSON.stringify({ error: 'Artist name is required' })
      };
    }

    if (!location || location.trim().length === 0) {
      return {
        statusCode: 400,
        headers: getCommunityHeaders(),
        body: JSON.stringify({ error: 'Location is required to prevent duplicates' })
      };
    }

    const now = new Date().toISOString();
    const artistId = crypto.randomUUID();

    // Fetch Facebook profile picture if Facebook URL provided
    let profileImageUrl = '';
    if (facebookUrl) {
      console.log('[CREATE_COMMUNITY_ARTIST] Attempting to fetch Facebook profile image...');
      const fbImage = await fetchFacebookProfilePicture(facebookUrl);
      if (fbImage) {
        profileImageUrl = fbImage;
        console.log('[CREATE_COMMUNITY_ARTIST] Facebook image fetched successfully');
      }
    }

    // ✅ NEW: Handle location coordinates based on type
    let finalLocationLat = null;
    let finalLocationLng = null;

    if (locationType === 'city' && locationLat && locationLng) {
      // City-specific location with coordinates from Google Places
      finalLocationLat = locationLat;
      finalLocationLng = locationLng;
      console.log(`[CREATE_COMMUNITY_ARTIST] City location with coordinates: ${locationLat}, ${locationLng}`);
    } else {
      // Regional or national location - no specific coordinates
      console.log(`[CREATE_COMMUNITY_ARTIST] Regional/national location: ${location}`);
    }

    const newArtist = {
      id: artistId,
      name: name.trim(),
      location: location.trim(),
      locationLat: finalLocationLat,   // ✅ UPDATED: Store actual coordinates for city
      locationLng: finalLocationLng,   // ✅ UPDATED: Store actual coordinates for city
      locationType: locationType || null,  // ✅ NEW: Track location type
      facebookUrl: facebookUrl || '',
      instagramUrl: instagramUrl || '',
      websiteUrl: websiteUrl || '',
      spotifyUrl: body.spotifyUrl || '',
      bio: bio || '',
      profileImageUrl,
      isVerified: false,
      claimedByUserId: null,
      socialMediaUrls: [],
      followerCount: 0,
      genres: Array.isArray(genres) ? genres : [],

      // Backstage-compatible fields
      owner_user_id: null,
      artist_type: artistType || artist_type || 'band',
      actType: actType || null,
      acoustic: acoustic || false,
      displayColour: randomColor(),
      member_count: 0,
      allowedEventTypes: ['public_gig'],

      // Data quality tracking
      source: body.source || 'frontstage',
      ai_created: body.ai_created || false,
      needs_review: true,

      created_at: now,
      updated_at: now
    };

    await dynamodb.put({
      TableName: 'bndy-artists',
      Item: newArtist
    }).promise();

    console.log(` Community artist created: ${artistId} (${name}) with ${locationType || 'unknown'} location`);

    return {
      statusCode: 201,
      headers: getCommunityHeaders(),
      body: JSON.stringify({
        message: 'Artist created successfully',
        artist: {
          id: artistId,
          name: newArtist.name,
          location: newArtist.location,
          locationLat: newArtist.locationLat,  // ✅ NEW: Return coordinates
          locationLng: newArtist.locationLng   // ✅ NEW: Return coordinates
        }
      })
    };
  } catch (error) {
    console.error(' Community artist creation failed:', error);
    return {
      statusCode: 500,
      headers: getCommunityHeaders(),
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
}
```

#### Update `handleSearchArtists()` Function

**Location**: Lines 904-952

**Changes Needed**:

```javascript
async function handleSearchArtists(event) {
  console.log(' Artists Lambda: Searching artists with fuzzy matching');

  const { name, location } = event.queryStringParameters || {};

  if (!name || name.length < 2) {
    return {
      statusCode: 400,
      headers: getCommunityHeaders(),
      body: JSON.stringify({ error: 'Name query must be at least 2 characters' })
    };
  }

  try {
    // ✅ UPDATED: Include locationLat and locationLng in projection
    const result = await dynamodb.scan({
      TableName: 'bndy-artists',
      ProjectionExpression: 'id, #name, #location, locationLat, locationLng, locationType, profileImageUrl',  // ✅ UPDATED
      ExpressionAttributeNames: {
        '#name': 'name',
        '#location': 'location'
      }
    }).promise();

    // Calculate match scores
    const matches = result.Items
      .map(artist => ({
        id: artist.id,
        name: artist.name,
        location: artist.location || '',
        locationLat: artist.locationLat || null,      // ✅ NEW: Include in response
        locationLng: artist.locationLng || null,      // ✅ NEW: Include in response
        locationType: artist.locationType || null,    // ✅ NEW: Include in response
        profileImageUrl: artist.profileImageUrl || null,
        matchScore: calculateMatchScore(artist.name, artist.location, name, location || '')
      }))
      .filter(artist => artist.matchScore > 0)
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, 10);

    console.log(` Found ${matches.length} matches for "${name}"`);

    return {
      statusCode: 200,
      headers: getCommunityHeaders(),
      body: JSON.stringify({ matches })
    };
  } catch (error) {
    console.error(' Artist search failed:', error);
    throw error;
  }
}
```

### 2. GET `/api/artists` Endpoint

**Update ALL artist GET endpoints** to include the new fields in projections:

```javascript
// Example: GET /api/artists (all artists)
ProjectionExpression: 'id, #name, #location, locationLat, locationLng, locationType, profileImageUrl, ...'
```

### 3. Update Artist (PUT) Endpoints

Any endpoint that updates artist records should also handle:
- `locationLat`
- `locationLng`
- `locationType`

---

## Frontend Changes (bndy-frontstage)

### 1. Update `createArtist()` Service

**File**: `src/lib/services/artist-service.ts`

**Changes**:

```typescript
export async function createArtist(artist: any): Promise<Artist> {
  try {
    const response = await fetch('https://api.bndy.co.uk/api/artists/community', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: artist.name,
        location: artist.location || '',
        locationType: artist.locationType || null,       // ✅ NEW
        locationLat: artist.locationLat || null,         // ✅ NEW
        locationLng: artist.locationLng || null,         // ✅ NEW
        facebookUrl: artist.facebookUrl || '',
        instagramUrl: artist.instagramUrl || '',
        websiteUrl: artist.websiteUrl || '',
        bio: artist.bio || artist.description || '',
        genres: artist.genres || [],
        artist_type: artist.artist_type || 'band',       // ✅ NEW
        actType: artist.actType || null,                 // ✅ NEW
        acoustic: artist.acoustic || false,              // ✅ NEW
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to create artist');
    }

    const data = await response.json();

    return {
      id: data.artist.id,
      name: data.artist.name,
      location: data.artist.location,
      locationLat: data.artist.locationLat || null,      // ✅ NEW
      locationLng: data.artist.locationLng || null,      // ✅ NEW
      // ... rest of fields
    } as Artist;
  } catch (error) {
    console.error("Error creating artist:", error);
    throw error;
  }
}
```

### 2. Update NewArtistForm Component

**File**: `src/components/events/createwizardsteps/ArtistStep/NewArtistForm.tsx`

**Changes**: Capture lat/lng from Google Places when city is selected

```typescript
const handleLocationChange = (location: string, locationType: 'national' | 'region' | 'city', placeDetails?: any) => {
  const updatedData: any = { location, locationType };

  // ✅ NEW: If city with Google Places data, store coordinates
  if (locationType === 'city' && placeDetails?.geometry?.location) {
    updatedData.locationLat = placeDetails.geometry.location.lat();
    updatedData.locationLng = placeDetails.geometry.location.lng();
  }

  setFormData({ ...formData, ...updatedData });
};
```

### 3. Update ArtistStep Search Weighting

**File**: `src/components/wizard/steps/ArtistStep.tsx`

**Changes**: Use actual Haversine distance calculation when coordinates exist

```typescript
// Calculate distance for each artist
const artistsWithDistance = artists.map((artist: Artist) => {
  let distance: number | undefined;

  if (artist.locationLat && artist.locationLng && formData.venue?.location) {
    // ✅ Use Haversine formula for actual distance
    distance = calculateDistance(
      formData.venue.location.lat,
      formData.venue.location.lng,
      artist.locationLat,
      artist.locationLng
    );
  } else if (artist.location && formData.venue?.city) {
    // ✅ Fallback: Text matching for regional/national artists
    const artistLocation = artist.location.toLowerCase().trim();
    const venueCity = formData.venue.city.toLowerCase().trim();

    if (artistLocation.includes(venueCity) || venueCity.includes(artistLocation)) {
      distance = 0;
    } else {
      distance = 999;
    }
  } else {
    distance = 999;
  }

  return { ...artist, distance } as SearchResult;
});
```

---

## TypeScript Type Updates

### Update Artist Interface

**File**: `src/lib/types.ts`

```typescript
export interface Artist {
  id: string;
  name: string;
  nameVariants?: string[];
  artist_type?: 'band' | 'solo' | 'duo' | 'group' | 'dj' | 'collective';
  artistType?: string;
  socialMediaUrls?: any[];
  genres?: string[];
  acoustic?: boolean;
  actType?: ('originals' | 'covers' | 'tribute')[];
  createdAt?: string;
  updatedAt?: string;
  profileImageUrl?: string;
  bio?: string;
  location?: string;
  locationLat?: number | null;        // ✅ NEW
  locationLng?: number | null;        // ✅ NEW
  locationType?: 'national' | 'region' | 'city';  // ✅ NEW
  // ... legacy fields
}
```

---

## Testing Checklist

### Backend Testing
- [ ] Create artist with city location (with lat/lng)
- [ ] Create artist with regional location (no lat/lng)
- [ ] Create artist with national location (no lat/lng)
- [ ] Verify search returns locationLat/locationLng fields
- [ ] Verify GET /api/artists returns new fields

### Frontend Testing
- [ ] Create new artist from wizard with city location
- [ ] Create new artist from wizard with regional location
- [ ] Verify artist search shows location-weighted results
- [ ] Verify "Near venue" badge appears for nearby artists
- [ ] Verify distance calculations are accurate

---

## Backstage Team Actions Required

The bndy-backstage application will also need updates for:

1. **Artist Profile Edit Page**: Capture lat/lng when location is edited
2. **Artist Creation Forms**: Support the same location types
3. **Admin Review Tools**: Display coordinates when present

**Recommendation**: Wait for bndy-frontstage implementation to be tested and verified before updating backstage.

---

## Deployment Order

1. ✅ Update `artists-lambda` backend (this is the blocker)
2. ✅ Update bndy-frontstage frontend
3. ✅ Test end-to-end with new wizard
4. ⏳ Update bndy-backstage (after frontstage verified)
5. ⏳ Data migration script for existing artists (optional, low priority)

---

## Migration Notes

**Existing Artists**: All existing artists will have `locationLat: null` and `locationLng: null` until:
1. They are manually updated by admin
2. Artist claims profile and updates location
3. Bulk migration script is run (optional)

**This is acceptable** because:
- Frontend gracefully handles null coordinates (falls back to text matching)
- No breaking changes to existing functionality
- Artists with coordinates will gradually improve search quality

---

## Questions?

Contact: [Your team contact info]