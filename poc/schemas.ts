import { z } from 'zod';

// Zod schema for extracted events (strict validation)
export const EventSchema = z.object({
  venueName: z.string().min(1).max(100),
  artistName: z.string().min(1).max(100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be HH:mm').optional(),
  facebookUrl: z.string().url().optional(),
  notes: z.string().max(500).optional()
});

export const ExtractSchema = z.object({
  events: z.array(EventSchema).max(200) // Prevent prompt blow-up
});

export type ExtractedEvent = z.infer<typeof EventSchema>;

// Google Places API response types
export interface GPlace {
  place_id: string;
  name: string;
  formatted_address: string;
  geometry: {
    location: {
      lat: number;
      lng: number;
    };
  };
  website?: string;
}

// BNDY venue type (from our database)
export interface BndyVenue {
  id: string;
  name: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  googlePlaceId?: string;  // API returns camelCase
  website?: string;
}

// BNDY artist type (from our database)
export interface BndyArtist {
  id: string;
  name: string;
  location?: string;
  locationLat?: number | null;
  locationLng?: number | null;
  bio?: string;
  genres?: string[];
  facebookUrl?: string;
  instagramUrl?: string;
  websiteUrl?: string;
}

// Scoring result
export interface ScoringResult {
  score: number;        // 0.0 - 1.0
  reasons: string[];    // Audit trail
}

// Venue resolution
export interface VenueResolution {
  action: 'MATCH_EXISTING' | 'CREATE_NEW' | 'REVIEW';
  venue_id?: string;
  confidence: number;
  reasons: string[];
  enrichments?: {
    website?: string;
    google_place_id?: string;
    latitude?: number;
    longitude?: number;
    address?: string;
  };
  location?: {
    lat: number;
    lng: number;
  };
}

// Artist resolution
export interface ArtistResolution {
  action: 'MATCH_EXISTING' | 'CREATE_NEW' | 'REVIEW';
  artist_id?: string;
  confidence: number;
  reasons: string[];
  artist_data?: {
    name: string;
    location?: string;
  };
  candidates?: Array<{
    artist: BndyArtist;
    score: number;
    reasons: string[];
  }>;
  suggestion?: string;
}
