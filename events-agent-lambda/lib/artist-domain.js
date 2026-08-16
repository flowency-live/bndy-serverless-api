'use strict';

const { regionBucket, UNKNOWN_REGION } = require('./identity');
const {
  normaliseGenres,
  normaliseArtistType,
  normaliseActTypes
} = require('./taxonomy');

const REGION_LABELS = Object.freeze({
  'north-east': 'North East',
  'north-west': 'North West',
  'yorkshire': 'Yorkshire and the Humber',
  'east-midlands': 'East Midlands',
  'west-midlands': 'West Midlands',
  'east': 'East of England',
  'london': 'London',
  'south-east': 'South East',
  'south-west': 'South West',
  'wales': 'Wales',
  'scotland': 'Scotland',
  'northern-ireland': 'Northern Ireland'
});

function canonicalRegionLabel(value) {
  if (!value || typeof value !== 'string') return null;
  const bucket = regionBucket(value);
  if (!bucket || bucket === UNKNOWN_REGION) return null;
  return REGION_LABELS[bucket] || null;
}

function regionFromTexts(values) {
  for (const value of values || []) {
    const region = canonicalRegionLabel(value);
    if (region) return region;
  }
  return null;
}

function coordsFromVenueResolution(venueResolution) {
  const lat = venueResolution?.location?.lat
    ?? venueResolution?.enrichments?.latitude
    ?? venueResolution?.matched_venue?.latitude;
  const lng = venueResolution?.location?.lng
    ?? venueResolution?.enrichments?.longitude
    ?? venueResolution?.matched_venue?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

async function reverseGeocodeRegion(coords, { axios, googlePlacesApiKey } = {}) {
  if (!coords || !axios || !googlePlacesApiKey) return null;
  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: {
        latlng: `${coords.lat},${coords.lng}`,
        key: googlePlacesApiKey,
        result_type: 'postal_town|locality|administrative_area_level_2|administrative_area_level_1'
      },
      timeout: 8000
    });
    if (response.data?.status !== 'OK') return null;
    for (const result of response.data?.results || []) {
      const componentText = (result.address_components || [])
        .flatMap((component) => [component.long_name, component.short_name])
        .filter(Boolean)
        .join(', ');
      const region = regionFromTexts([componentText, result.formatted_address]);
      if (region) return region;
    }
  } catch (error) {
    console.warn('[artist-domain] Reverse geocode failed:', error.message);
  }
  return null;
}

/**
 * Infer the artist's broad operating region from the gig venue, per product
 * rule: unattended grassroots ingest stores a UK region rather than pretending
 * the artist is based in the venue's town/city.
 */
async function inferVenueRegion({
  venueResolution,
  venueName,
  fallbackContext,
  explicitArtistLocation,
  axios,
  googlePlacesApiKey
}) {
  // If upstream genuinely knows an artist location, collapse it to the same
  // broad region model first. Current agent payloads normally leave this null.
  const explicit = canonicalRegionLabel(explicitArtistLocation);
  if (explicit) return explicit;

  const immediate = regionFromTexts([
    venueResolution?.enrichments?.address,
    venueResolution?.matched_venue?.address,
    venueResolution?.matched_venue?.city,
    venueResolution?.matched_venue?.location,
    venueName
  ]);
  if (immediate) return immediate;

  const reverse = await reverseGeocodeRegion(coordsFromVenueResolution(venueResolution), {
    axios,
    googlePlacesApiKey
  });
  if (reverse) return reverse;

  // Source/batch location context is the final fallback. This still gives a
  // coarse operating region and is preferable to fabricating the venue town.
  return canonicalRegionLabel(fallbackContext);
}

async function googleVenueRegion({ venueName, locationContext, axios, googlePlacesApiKey }) {
  if (!venueName || !axios || !googlePlacesApiKey) return null;
  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: {
        query: `${venueName} ${locationContext || 'UK'}`,
        key: googlePlacesApiKey
      },
      timeout: 8000
    });
    const place = response.data?.results?.[0];
    if (!place) return null;
    const direct = canonicalRegionLabel(place.formatted_address);
    if (direct) return direct;
    const lat = place.geometry?.location?.lat;
    const lng = place.geometry?.location?.lng;
    return reverseGeocodeRegion(
      typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : null,
      { axios, googlePlacesApiKey }
    );
  } catch (error) {
    console.warn('[artist-domain] Google venue lookup failed:', error.message);
    return null;
  }
}

async function inferBulkArtistRegion({
  localArtistId,
  artistData,
  venues,
  events,
  locationContext,
  axios,
  googlePlacesApiKey
}) {
  const directLocation = typeof artistData?.location === 'string'
    ? artistData.location
    : artistData?.location?.region
      || artistData?.location?.town
      || artistData?.location?.city;
  const direct = canonicalRegionLabel(directLocation);
  if (direct) return direct;

  const related = Object.values(events || {}).filter((event) => event?.artist_id === localArtistId);
  for (const event of related) {
    const venue = venues?.[event.venue_id];
    if (!venue) continue;
    const textRegion = regionFromTexts([
      venue.location?.region,
      venue.location?.town,
      venue.location?.city,
      venue.address,
      venue.name
    ]);
    if (textRegion) return textRegion;

    const googleRegion = await googleVenueRegion({
      venueName: venue.name,
      locationContext: venue.location?.town || venue.location?.region || locationContext,
      axios,
      googlePlacesApiKey
    });
    if (googleRegion) return googleRegion;
  }

  return canonicalRegionLabel(locationContext);
}

function facebookUrlFromUrls(urls) {
  if (!Array.isArray(urls)) return undefined;
  return urls.find((item) => item?.kind === 'facebook' && item.url)?.url;
}

function buildCanonicalArtistPayload({ name, region, artistData = {}, source = 'agentic_ingest', dryRun = false }) {
  const genreResult = normaliseGenres(Array.isArray(artistData.genres) ? artistData.genres : []);
  const rawArtistType = artistData.artistType
    ?? artistData.artist_type
    ?? artistData.act_type
    ?? 'band';
  const artistType = normaliseArtistType(String(rawArtistType)) || 'band';

  const rawActTypes = artistData.actType
    ?? artistData.act_types
    ?? artistData.actTypes
    ?? [];
  const actResult = normaliseActTypes(rawActTypes);
  const explicitAcoustic = artistData.acoustic === true;

  const payload = {
    name,
    location: region,
    locationType: 'region',
    venueRegion: region,
    artistType,
    genres: genreResult.valid,
    source,
    dryRun: !!dryRun
  };
  if (actResult.valid.length) payload.actType = actResult.valid;
  if (explicitAcoustic || actResult.acoustic) payload.acoustic = true;

  const facebookUrl = artistData.facebookUrl || facebookUrlFromUrls(artistData.urls);
  if (facebookUrl) payload.facebookUrl = facebookUrl;
  if (artistData.bio) payload.bio = artistData.bio;

  return {
    payload,
    warnings: [
      ...genreResult.invalid.map((value) => `Invalid genre dropped: ${value}`),
      ...actResult.invalid.map((value) => `Invalid act type dropped: ${value}`)
    ]
  };
}

async function resolveArtistViaApi({
  name,
  region,
  artistData,
  source,
  dryRun = false,
  axios,
  apiBase = 'https://api.bndy.co.uk'
}) {
  const canonical = buildCanonicalArtistPayload({ name, region, artistData, source, dryRun });
  const response = await axios.post(`${apiBase}/api/community/artists/find-or-create`, canonical.payload, {
    validateStatus: () => true,
    timeout: 12000
  });
  const body = response.data && typeof response.data === 'object' ? response.data : {};
  const artist = body.artist && typeof body.artist === 'object' ? body.artist : {};
  const artistId = artist.id || body.artistId || body.existingArtistId || body.existingId;

  if (response.status === 409 && artistId) {
    return { kind: 'matched', artistId, artistName: artist.name || name, region, warnings: canonical.warnings, raw: body };
  }

  if (body.action === 'review' || response.status === 422) {
    return {
      kind: 'review',
      region,
      reason: body.reason || body.error || 'Artist needs review',
      code: body.code,
      candidates: body.candidates || [],
      warnings: canonical.warnings,
      raw: body
    };
  }

  if (dryRun && body.action === 'clear') {
    return { kind: 'clear', region, warnings: canonical.warnings, raw: body };
  }

  if (body.action === 'matched' && artistId) {
    return { kind: 'matched', artistId, artistName: artist.name || name, region, warnings: canonical.warnings, raw: body };
  }

  if (artistId && response.status >= 200 && response.status < 300) {
    return {
      kind: response.status === 201 || body.action === 'created' ? 'created' : 'matched',
      artistId,
      artistName: artist.name || name,
      region,
      warnings: canonical.warnings,
      raw: body
    };
  }

  return {
    kind: 'error',
    region,
    reason: body.error || body.message || `Artists API returned ${response.status}`,
    code: body.code,
    warnings: canonical.warnings,
    raw: body
  };
}

module.exports = {
  REGION_LABELS,
  canonicalRegionLabel,
  inferVenueRegion,
  inferBulkArtistRegion,
  buildCanonicalArtistPayload,
  resolveArtistViaApi
};
