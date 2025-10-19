import axios from 'axios';
import { BndyArtist, ScoringResult, ArtistResolution } from './schemas.js';

/**
 * ARTIST CACHE: Load all artists once at startup
 */
let allArtistsCache: BndyArtist[] | null = null;

async function loadAllArtists(): Promise<BndyArtist[]> {
  if (allArtistsCache !== null) {
    return allArtistsCache;
  }

  const BNDY_API_BASE = process.env.BNDY_API_BASE || 'https://api.bndy.co.uk';

  try {
    console.log('[Artist Cache] Loading all artists from BNDY API...');
    const response = await axios.get(`${BNDY_API_BASE}/api/artists`);
    const artists: BndyArtist[] = response.data || [];
    allArtistsCache = artists;
    console.log(`[Artist Cache] Loaded ${artists.length} artists`);
    return artists;
  } catch (error) {
    console.error('[Artist Cache] Failed to load artists:', error);
    allArtistsCache = [];
    return [];
  }
}

/**
 * NORMALIZATION: Artist name normalization
 */
export function normalizeArtistName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|band)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * SCORING: Deterministic artist matching
 */
export function scoreArtistMatch(
  extractedArtist: string,
  bndyArtist: BndyArtist,
  venueLocation: { lat: number; lng: number }
): ScoringResult {
  let score = 0;
  const reasons: string[] = [];

  // RULE 1: Name match (normalized) → +0.7 (exact) or +0.5 (partial)
  const extractedNorm = normalizeArtistName(extractedArtist);
  const bndyNorm = normalizeArtistName(bndyArtist.name);

  if (extractedNorm === bndyNorm) {
    score += 0.7;
    reasons.push('name_exact');
  } else if (extractedNorm.includes(bndyNorm) || bndyNorm.includes(extractedNorm)) {
    score += 0.5;
    reasons.push('name_partial');
  } else {
    // No name match at all - this artist is unlikely to be correct
    return { score: 0, reasons: ['name_mismatch'] };
  }

  // RULE 2: Location proximity (if artist has location set)
  // 75% perform locally, 25% tour nationally
  if (bndyArtist.locationLat && bndyArtist.locationLng) {
    const distKm = haversineKm(
      bndyArtist.locationLat, bndyArtist.locationLng,
      venueLocation.lat, venueLocation.lng
    );

    if (distKm <= 40) {  // Within 40km = local artist
      score += 0.3;
      reasons.push('geo_local');
    } else if (distKm <= 100) {  // Within 100km = regional
      score += 0.15;
      reasons.push('geo_regional');
    }
    // > 100km = touring artist, no geo bonus
  } else {
    // No location data = could be anywhere
    // Don't penalize, artist might not have location enriched yet
  }

  return { score: Math.min(1.0, score), reasons };
}

/**
 * DECISION: Convert score to action (MATCH/CREATE/REVIEW)
 */
export function decideArtistAction(scoringResult: ScoringResult): 'MATCH_EXISTING' | 'CREATE_NEW' | 'REVIEW' {
  if (scoringResult.score >= 0.9) {
    return 'MATCH_EXISTING';  // High confidence (exact name + local)
  } else if (scoringResult.score >= 0.6) {
    return 'REVIEW';           // Ambiguous (exact name but no location, or partial + local)
  } else {
    return 'CREATE_NEW';       // Low confidence or no name match
  }
}

/**
 * RESOLVE ARTIST: Main orchestration function
 */
export async function resolveArtist(
  artistName: string,
  venueLocation: { lat: number; lng: number }
): Promise<ArtistResolution> {
  console.log(`\n=== Resolving artist: "${artistName}" ===`);

  // Load all BNDY artists (cached after first call)
  const allArtists = await loadAllArtists();

  if (allArtists.length === 0) {
    console.log('No BNDY artists in database - CREATE_NEW');
    return {
      action: 'CREATE_NEW',
      confidence: 0.8,
      reasons: ['no_bndy_artists'],
      artist_data: {
        name: artistName,
        location: inferLocationFromVenue(venueLocation)
      }
    };
  }

  // Score all artists
  console.log(`Scoring all ${allArtists.length} artists...`);
  const scored = allArtists.map(artist => ({
    artist,
    ...scoreArtistMatch(artistName, artist, venueLocation)
  }));

  // Filter out zero scores (complete name mismatches)
  const validScores = scored.filter(s => s.score > 0);

  if (validScores.length === 0) {
    console.log('No matching artists found - CREATE_NEW');
    return {
      action: 'CREATE_NEW',
      confidence: 0.8,
      reasons: ['no_name_match'],
      artist_data: {
        name: artistName,
        location: inferLocationFromVenue(venueLocation)
      }
    };
  }

  // Sort by score descending
  validScores.sort((a, b) => b.score - a.score);

  const best = validScores[0];
  const action = decideArtistAction(best);

  console.log(`Best match: "${best.artist.name}" (score: ${best.score}, reasons: ${best.reasons.join(', ')})`);
  console.log(`Decision: ${action}`);

  // Check if we have multiple high-scoring candidates (ambiguity)
  const highScorers = validScores.filter(s => s.score >= 0.6);

  if (highScorers.length > 1) {
    console.log(`WARNING: ${highScorers.length} artists with similar names - may need disambiguation`);
    logArtistScoringBreakdown(artistName, venueLocation, highScorers.slice(0, 3));

    return {
      action: 'REVIEW',
      confidence: best.score,
      reasons: [...best.reasons, 'multiple_candidates'],
      candidates: highScorers.slice(0, 3),
      suggestion: `Multiple artists named "${artistName}" - geographic disambiguation needed`
    };
  }

  // Log scoring breakdown for best match
  logArtistScoringBreakdown(artistName, venueLocation, [best]);

  if (action === 'MATCH_EXISTING') {
    return {
      action: 'MATCH_EXISTING',
      artist_id: best.artist.id,
      confidence: best.score,
      reasons: best.reasons
    };
  } else if (action === 'REVIEW') {
    return {
      action: 'REVIEW',
      confidence: best.score,
      reasons: best.reasons,
      candidates: [best],
      suggestion: best.score >= 0.7
        ? 'Exact name match but no location data for confirmation'
        : 'Partial name match - verify this is the correct artist'
    };
  } else {
    return {
      action: 'CREATE_NEW',
      confidence: 0.7,
      reasons: ['score_too_low'],
      artist_data: {
        name: artistName,
        location: inferLocationFromVenue(venueLocation)
      }
    };
  }
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

function inferLocationFromVenue(venueLocation: { lat: number; lng: number }): string {
  // For POC: Simple heuristic based on Greater Manchester area
  // In production: Use reverse geocoding to get proper city name

  // Rough Greater Manchester boundaries
  const manLatMin = 53.35;
  const manLatMax = 53.65;
  const manLngMin = -2.4;
  const manLngMax = -2.0;

  if (
    venueLocation.lat >= manLatMin && venueLocation.lat <= manLatMax &&
    venueLocation.lng >= manLngMin && venueLocation.lng <= manLngMax
  ) {
    return 'Greater Manchester, UK';
  }

  // Fallback: just say "UK" for POC
  return 'UK';
}

function logArtistScoringBreakdown(
  extractedArtist: string,
  venueLocation: { lat: number; lng: number },
  results: Array<{ artist: BndyArtist; score: number; reasons: string[] }>
): void {
  console.log(JSON.stringify({
    type: 'ARTIST_SCORING',
    extracted: extractedArtist,
    venue_location: venueLocation,
    candidates: results.map(r => ({
      id: r.artist.id,
      name: r.artist.name,
      location: r.artist.location,
      locationLat: r.artist.locationLat,
      locationLng: r.artist.locationLng,
      score: r.score,
      reasons: r.reasons
    }))
  }, null, 2));
}
