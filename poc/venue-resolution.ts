import axios from 'axios';
import { BndyVenue, GPlace, ScoringResult, VenueResolution } from './schemas.js';

/**
 * VENUE CACHE: Load all venues once at startup
 */
let allVenuesCache: BndyVenue[] | null = null;

async function loadAllVenues(): Promise<BndyVenue[]> {
  if (allVenuesCache !== null) {
    return allVenuesCache;
  }

  const BNDY_API_BASE = process.env.BNDY_API_BASE || 'https://api.bndy.co.uk';

  try {
    console.log('[Venue Cache] Loading all venues from BNDY API...');
    const response = await axios.get(`${BNDY_API_BASE}/api/venues`);
    const venues: BndyVenue[] = response.data || [];
    allVenuesCache = venues;
    console.log(`[Venue Cache] Loaded ${venues.length} venues`);
    return venues;
  } catch (error) {
    console.error('[Venue Cache] Failed to load venues:', error);
    allVenuesCache = [];
    return [];
  }
}

/**
 * NORMALIZATION: Production-grade name normalization
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')                           // "Eagle & Child" → "eagle and child"
    .replace(/[^a-z0-9\s]/g, ' ')                   // Remove punctuation
    .replace(/\b(the|bar|pub|hotel|inn|venue)\b/g, ' ') // Remove common words
    .replace(/\s+/g, ' ')                           // Collapse whitespace
    .trim();
}

/**
 * SCORING: Deterministic venue matching (NO LLM)
 */
export function scoreVenueMatch(googlePlace: GPlace, bndyVenue: BndyVenue): ScoringResult {
  // RULE 1: Google Place ID is authoritative (99% confidence)
  if (bndyVenue.googlePlaceId && bndyVenue.googlePlaceId === googlePlace.place_id) {
    return { score: 0.99, reasons: ['place_id_match'] };
  }

  let score = 0;
  const reasons: string[] = [];

  // RULE 2: Name match (normalized) → +0.6
  const googleNorm = normalizeName(googlePlace.name);
  const bndyNorm = normalizeName(bndyVenue.name);
  if (googleNorm === bndyNorm) {
    score += 0.6;
    reasons.push('name_exact');
  } else if (googleNorm.includes(bndyNorm) || bndyNorm.includes(googleNorm)) {
    score += 0.4;
    reasons.push('name_partial');
  }

  // RULE 3: Geographic proximity
  if (bndyVenue.latitude && bndyVenue.longitude) {
    const distKm = haversineKm(
      bndyVenue.latitude, bndyVenue.longitude,
      googlePlace.geometry.location.lat,
      googlePlace.geometry.location.lng
    );

    if (!isNaN(distKm)) {
      if (distKm <= 0.5) {
        score += 0.25;
        reasons.push('dist<=0.5km');
      } else if (distKm <= 2.0) {
        score += 0.2;
        reasons.push('dist<=2km');
      }
    }
  }

  // RULE 4: Address token overlap → +0.1
  if (bndyVenue.address) {
    const addrOverlap = calculateAddressOverlap(
      bndyVenue.address,
      googlePlace.formatted_address
    );
    if (addrOverlap >= 0.5) {
      score += 0.1;
      reasons.push('addr_overlap');
    }
  }

  // RULE 5: Website domain match → +0.1
  if (sameDomain(bndyVenue.website, googlePlace.website)) {
    score += 0.1;
    reasons.push('domain_match');
  }

  return { score: Math.min(1.0, score), reasons };
}

/**
 * DECISION: Convert score to action (MATCH/CREATE/REVIEW)
 */
export function decideVenueAction(scoringResult: ScoringResult): 'MATCH_EXISTING' | 'CREATE_NEW' | 'REVIEW' {
  if (scoringResult.score >= 0.8) {
    return 'MATCH_EXISTING';  // High confidence match
  } else if (scoringResult.score >= 0.6) {
    return 'REVIEW';           // Ambiguous - needs human
  } else {
    return 'CREATE_NEW';       // No good match found
  }
}

/**
 * RESOLVE VENUE: Main orchestration function
 */
export async function resolveVenue(
  venueName: string,
  locationContext: string
): Promise<VenueResolution> {
  console.log(`\n=== Resolving venue: "${venueName}" in ${locationContext} ===`);

  // Step 1: Search Google Places
  const googlePlaces = await searchGooglePlaces(venueName, locationContext);

  if (googlePlaces.length === 0) {
    console.log('No Google Places results found');
    return {
      action: 'REVIEW',
      confidence: 0.0,
      reasons: ['no_google_results'],
    };
  }

  const topGooglePlace = googlePlaces[0];
  console.log(`Top Google result: "${topGooglePlace.name}" at ${topGooglePlace.formatted_address}`);
  console.log(`Google Place ID: ${topGooglePlace.place_id}`);

  // Step 2: Load all BNDY venues (cached after first call)
  const allVenues = await loadAllVenues();

  if (allVenues.length === 0) {
    console.log('No BNDY venues in database - CREATE_NEW');
    return {
      action: 'CREATE_NEW',
      confidence: 0.8,
      reasons: ['no_bndy_match'],
      enrichments: {
        google_place_id: topGooglePlace.place_id,
        website: topGooglePlace.website,
        latitude: topGooglePlace.geometry.location.lat,
        longitude: topGooglePlace.geometry.location.lng,
        address: topGooglePlace.formatted_address
      },
      location: {
        lat: topGooglePlace.geometry.location.lat,
        lng: topGooglePlace.geometry.location.lng
      }
    };
  }

  // Step 3: Check for Google Place ID match first (99% confidence)
  const placeIdMatch = allVenues.find(v => v.googlePlaceId === topGooglePlace.place_id);

  if (placeIdMatch) {
    console.log(`INSTANT MATCH via Place ID: "${placeIdMatch.name}"`);
    return {
      action: 'MATCH_EXISTING',
      venue_id: placeIdMatch.id,
      confidence: 0.99,
      reasons: ['place_id_match'],
      enrichments: {
        google_place_id: topGooglePlace.place_id,
        website: topGooglePlace.website
      },
      location: {
        lat: placeIdMatch.latitude || topGooglePlace.geometry.location.lat,
        lng: placeIdMatch.longitude || topGooglePlace.geometry.location.lng
      }
    };
  }

  // Step 4: No place_id match - score all venues
  console.log(`No place_id match found, scoring all ${allVenues.length} venues...`);
  const scored = allVenues.map(venue => ({
    venue,
    ...scoreVenueMatch(topGooglePlace, venue)
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  const action = decideVenueAction(best);

  console.log(`Best match: "${best.venue.name}" (score: ${best.score}, reasons: ${best.reasons.join(', ')})`);
  console.log(`Decision: ${action}`);

  // Log scoring breakdown
  logScoringBreakdown(venueName, topGooglePlace, best.venue, best);

  if (action === 'MATCH_EXISTING') {
    return {
      action: 'MATCH_EXISTING',
      venue_id: best.venue.id,
      confidence: best.score,
      reasons: best.reasons,
      enrichments: {
        website: topGooglePlace.website,
        google_place_id: topGooglePlace.place_id
      },
      location: {
        lat: best.venue.latitude || topGooglePlace.geometry.location.lat,
        lng: best.venue.longitude || topGooglePlace.geometry.location.lng
      }
    };
  } else if (action === 'REVIEW') {
    return {
      action: 'REVIEW',
      confidence: best.score,
      reasons: best.reasons,
      enrichments: {
        google_place_id: topGooglePlace.place_id,
        website: topGooglePlace.website,
        latitude: topGooglePlace.geometry.location.lat,
        longitude: topGooglePlace.geometry.location.lng,
        address: topGooglePlace.formatted_address
      }
    };
  } else {
    return {
      action: 'CREATE_NEW',
      confidence: 0.7,
      reasons: ['score_too_low'],
      enrichments: {
        google_place_id: topGooglePlace.place_id,
        website: topGooglePlace.website,
        latitude: topGooglePlace.geometry.location.lat,
        longitude: topGooglePlace.geometry.location.lng,
        address: topGooglePlace.formatted_address
      },
      location: {
        lat: topGooglePlace.geometry.location.lat,
        lng: topGooglePlace.geometry.location.lng
      }
    };
  }
}

/**
 * GOOGLE PLACES API: Search for venues
 */
const placesCache = new Map<string, GPlace[]>();

async function searchGooglePlaces(
  venueName: string,
  location: string,
  options = { maxResults: 5 }
): Promise<GPlace[]> {
  const cacheKey = `${venueName}|${location}`;

  if (placesCache.has(cacheKey)) {
    console.log(`Cache hit: ${cacheKey}`);
    return placesCache.get(cacheKey)!;
  }

  const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

  const params = {
    query: `${venueName} ${location}`,
    key: GOOGLE_API_KEY,
  };

  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    try {
      const response = await axios.get(
        'https://maps.googleapis.com/maps/api/place/textsearch/json',
        { params }
      );

      if (response.data.status === 'OK') {
        const results = response.data.results.slice(0, options.maxResults);
        placesCache.set(cacheKey, results);
        return results;
      } else if (response.data.status === 'OVER_QUERY_LIMIT') {
        // Rate limited - exponential backoff
        const delay = Math.pow(2, attempt) * 1000;
        console.warn(`Google Places rate limit hit, retrying in ${delay}ms...`);
        await sleep(delay);
        attempt++;
        continue;
      } else {
        console.error(`Google Places API error: ${response.data.status}`);
        return [];
      }
    } catch (error) {
      console.error('Google Places request failed:', error);
      return [];
    }
  }

  console.error('Google Places max retries exceeded');
  return [];
}

// === HELPER FUNCTIONS ===

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function sameDomain(url1?: string, url2?: string): boolean {
  try {
    if (!url1 || !url2) return false;
    const d1 = new URL(url1).hostname.replace(/^www\./, '');
    const d2 = new URL(url2).hostname.replace(/^www\./, '');
    return d1 === d2;
  } catch {
    return false;
  }
}

function calculateAddressOverlap(addr1: string, addr2: string): number {
  const tokens1 = new Set(addr1.toLowerCase().split(/\s+/));
  const tokens2 = new Set(addr2.toLowerCase().split(/\s+/));

  let intersection = 0;
  for (const token of tokens1) {
    if (tokens2.has(token)) intersection++;
  }

  const union = tokens1.size + tokens2.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logScoringBreakdown(
  venueName: string,
  googlePlace: GPlace,
  bndyVenue: BndyVenue,
  result: ScoringResult
): void {
  console.log(JSON.stringify({
    type: 'VENUE_SCORING',
    extracted: venueName,
    google: {
      name: googlePlace.name,
      place_id: googlePlace.place_id,
      address: googlePlace.formatted_address
    },
    bndy: {
      id: bndyVenue.id,
      name: bndyVenue.name,
      google_place_id: bndyVenue.googlePlaceId
    },
    score: result.score,
    reasons: result.reasons,
    decision: result.score >= 0.8 ? 'MATCH' : result.score >= 0.6 ? 'REVIEW' : 'CREATE'
  }, null, 2));
}
