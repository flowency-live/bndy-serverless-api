/**
 * Venue Deduplication Logic
 *
 * Implements multi-level venue matching strategy:
 * - Level 1: Exact googlePlaceId match (100% confidence)
 * - Level 2: Location + Name fuzzy match (90% confidence)
 * - Level 3: Name + Address token overlap (70% confidence)
 * - Level 3.5: Auto-geocode if no googlePlaceId (ADR-018)
 * - Level 4: Create new venue (with guaranteed place_id)
 *
 * ADR-018: Venues MUST have google_place_id - no placeless venues allowed.
 * ADR-021: canCreate flag controls whether auto-creation is allowed.
 */

const { mergeExternalIds } = require('./external-ids');
const { findPlaceFromGoogle, validateApiKey } = require('./google-places');
const { validateVenueAdmission } = require('./venue-admission');
const {
  normalizeForSearch,
  isWithinDistance,
  calculateSimilarity,
  calculateAddressOverlap
} = require('./fuzzy-matcher');
const { scanAll } = require('./scan-all');
const { venuePlaceKey } = require('./identity');
const { hasPrivilegedIngestionFields, validateScopedIngestion, editionMetadata } = require('./edition-domain');
const { gatedPut, duplicateResponseBody } = require('./unique-gate');

/**
 * Format venue response consistently
 * @param {Object} venue - Raw venue from DynamoDB
 * @returns {Object} Formatted venue response
 */
function formatVenueResponse(venue) {
  return {
    id: venue.id,
    name: venue.name,
    address: venue.address || '',
    city: venue.city || '',
    postcode: venue.postcode || '',
    latitude: venue.latitude || null,
    longitude: venue.longitude || null,
    googlePlaceId: venue.google_place_id || null,
    website: venue.website || '',
    validated: venue.validated || false,
    externalIds: venue.external_ids || [],
    ...editionMetadata(venue)
  };
}

/**
 * Trigger venue enrichment via Lambda (async, non-blocking)
 * @param {Object} lambda - AWS Lambda client
 * @param {string} venueId - Venue ID to enrich
 */
async function triggerVenueEnrichment(lambda, venueId) {
  try {
    console.log(`[Enrichment] Triggering enrichment for venue: ${venueId}`);
    await lambda.invoke({
      FunctionName: 'venue-enrichment-lambda',
      InvocationType: 'Event', // Async - don't wait for response
      Payload: JSON.stringify({ body: JSON.stringify({ venueId }) })
    }).promise();
    console.log(`[Enrichment] Successfully triggered for: ${venueId}`);
  } catch (error) {
    console.error(`[Enrichment] Failed to trigger for ${venueId}:`, error);
    // Don't throw - enrichment failure shouldn't block venue creation
  }
}

/**
 * Find-or-create venue with multi-level deduplication
 *
 * @param {Object} deps - Dependencies { dynamodb, lambda, getCorsHeaders }
 * @param {Object} venueData - Venue data from request
 * @param {Object} event - Lambda event for CORS headers
 * @returns {Promise<Object>} Lambda response
 */
async function handleFindOrCreateVenue(deps, venueData, event) {
  const { dynamodb, lambda, getCorsHeaders } = deps;
  if (hasPrivilegedIngestionFields(venueData) && !event.__allowScopedIngestion) {
    return { statusCode: 403, headers: getCorsHeaders(event), body: JSON.stringify({ error: 'Scoped ingestion fields require MCP service authentication' }) };
  }
  if (event.__allowScopedIngestion) {
    const scopedError = validateScopedIngestion(venueData, 'venue');
    if (scopedError) return { statusCode: 400, headers: getCorsHeaders(event), body: JSON.stringify({ error: scopedError }) };
  }

  console.log('[Venues] Venues Lambda: Find-or-create venue with deduplication');
  // ADR-021: canCreate defaults true (backwards compat); runner passes false to prevent auto-create
  const canCreate = venueData.canCreate !== false;
  console.log('[Venues] Input:', {
    name: venueData.name,
    googlePlaceId: venueData.googlePlaceId,
    address: venueData.address,
    latitude: venueData.latitude,
    longitude: venueData.longitude,
    canCreate
  });

  try {
    // Scan all venues for matching — MUST be paginated: a bare scan caps at
    // 1MB and silently truncates the candidate set, which lets duplicates
    // through the ladder (2026-07-27 audit finding F2).
    const existingVenues = await scanAll(dynamodb, { TableName: 'bndy-venues' });

    console.log(`[Venues] Scanning ${existingVenues.length} existing venues for matches`);

    // === LEVEL 1: Exact googlePlaceId match (100% confidence) ===
    if (venueData.googlePlaceId) {
      const googlePlaceMatch = existingVenues.find(v =>
        v.google_place_id === venueData.googlePlaceId
      );

      if (googlePlaceMatch) {
        console.log('[SUCCESS] LEVEL 1 MATCH: Google Place ID exact match');

        // Merge incoming externalIds into existing venue
        const mergedExternalIds = mergeExternalIds(
          googlePlaceMatch.external_ids || [],
          venueData.externalIds || []
        );

        // Update venue in DynamoDB if externalIds changed
        if (venueData.externalIds && venueData.externalIds.length > 0) {
          console.log(`[Venues] Merging ${venueData.externalIds.length} externalIds into matched venue`);
          await dynamodb.update({
            TableName: 'bndy-venues',
            Key: { id: googlePlaceMatch.id },
            UpdateExpression: 'SET external_ids = :extIds, updated_at = :now',
            ExpressionAttributeValues: {
              ':extIds': mergedExternalIds,
              ':now': new Date().toISOString()
            }
          }).promise();
        }

        const formattedVenue = {
          id: googlePlaceMatch.id,
          name: googlePlaceMatch.name,
          address: googlePlaceMatch.address,
          latitude: googlePlaceMatch.latitude,
          longitude: googlePlaceMatch.longitude,
          location: googlePlaceMatch.location_object || { lat: googlePlaceMatch.latitude, lng: googlePlaceMatch.longitude },
          googlePlaceId: googlePlaceMatch.google_place_id,
          validated: googlePlaceMatch.validated,
          externalIds: mergedExternalIds,
          matchConfidence: 100,
          matchMethod: 'google_place_id',
          ...editionMetadata(googlePlaceMatch)
        };
        return {
          statusCode: 200,
          headers: getCorsHeaders(event),
          body: JSON.stringify(formattedVenue)
        };
      }
    }

    // === LEVEL 2: Location + Name fuzzy match (90% confidence) ===
    if (venueData.latitude && venueData.longitude) {
      for (const venue of existingVenues) {
        if (venue.latitude && venue.longitude) {
          const withinRadius = isWithinDistance(
            venueData.latitude,
            venueData.longitude,
            venue.latitude,
            venue.longitude,
            50 // 50 meters radius
          );

          if (withinRadius) {
            const nameSimilarity = calculateSimilarity(venueData.name, venue.name);

            if (nameSimilarity >= 80) {
              console.log(`[SUCCESS] LEVEL 2 MATCH: Location + Name (${nameSimilarity.toFixed(1)}% similarity)`);

              // Merge incoming externalIds into existing venue
              const mergedExternalIds = mergeExternalIds(
                venue.external_ids || [],
                venueData.externalIds || []
              );

              // Update venue in DynamoDB if externalIds changed
              if (venueData.externalIds && venueData.externalIds.length > 0) {
                console.log(`[Venues] Merging ${venueData.externalIds.length} externalIds into matched venue`);
                await dynamodb.update({
                  TableName: 'bndy-venues',
                  Key: { id: venue.id },
                  UpdateExpression: 'SET external_ids = :extIds, updated_at = :now',
                  ExpressionAttributeValues: {
                    ':extIds': mergedExternalIds,
                    ':now': new Date().toISOString()
                  }
                }).promise();
              }

              const formattedVenue = {
                id: venue.id,
                name: venue.name,
                address: venue.address,
                latitude: venue.latitude,
                longitude: venue.longitude,
                location: venue.location_object || { lat: venue.latitude, lng: venue.longitude },
                googlePlaceId: venue.google_place_id,
                validated: venue.validated,
                externalIds: mergedExternalIds,
                matchConfidence: 90,
                matchMethod: 'location_and_name',
                ...editionMetadata(venue),
                matchDetails: { nameSimilarity: nameSimilarity.toFixed(1) }
              };
              return {
                statusCode: 200,
                headers: getCorsHeaders(event),
                body: JSON.stringify(formattedVenue)
              };
            }
          }
        }
      }
    }

    // === LEVEL 3: Name + Address token overlap (70% confidence) ===
    for (const venue of existingVenues) {
      if (venue.name && venue.address && venueData.address) {
        const nameSimilarity = calculateSimilarity(venueData.name, venue.name);
        const addressOverlap = calculateAddressOverlap(venueData.address, venue.address);

        // Match if name is very similar AND address has decent overlap
        if (nameSimilarity >= 85 && addressOverlap >= 50) {
          console.log(`[WARNING] LEVEL 3 MATCH: Name + Address tokens (name: ${nameSimilarity.toFixed(1)}%, addr: ${addressOverlap.toFixed(1)}%)`);

          // Merge incoming externalIds into existing venue
          const mergedExternalIds = mergeExternalIds(
            venue.external_ids || [],
            venueData.externalIds || []
          );

          // Update venue in DynamoDB if externalIds changed
          if (venueData.externalIds && venueData.externalIds.length > 0) {
            console.log(`[Venues] Merging ${venueData.externalIds.length} externalIds into matched venue`);
            await dynamodb.update({
              TableName: 'bndy-venues',
              Key: { id: venue.id },
              UpdateExpression: 'SET external_ids = :extIds, updated_at = :now',
              ExpressionAttributeValues: {
                ':extIds': mergedExternalIds,
                ':now': new Date().toISOString()
              }
            }).promise();
          }

          const formattedVenue = {
            id: venue.id,
            name: venue.name,
            address: venue.address,
            latitude: venue.latitude,
            longitude: venue.longitude,
            location: venue.location_object || { lat: venue.latitude, lng: venue.longitude },
            googlePlaceId: venue.google_place_id,
            validated: venue.validated,
            externalIds: mergedExternalIds,
            matchConfidence: 70,
            matchMethod: 'name_and_address_tokens',
            ...editionMetadata(venue),
            matchDetails: {
              nameSimilarity: nameSimilarity.toFixed(1),
              addressOverlap: addressOverlap.toFixed(1)
            }
          };
          return {
            statusCode: 200,
            headers: getCorsHeaders(event),
            body: JSON.stringify(formattedVenue)
          };
        }
      }
    }

    // === LEVEL 3.5: Auto-geocode if no googlePlaceId provided (ADR-018) ===
    // Before creating, attempt to resolve place_id via Google
    // This prevents creating venues with empty place_id and lat/lng=0
    if (!venueData.googlePlaceId && venueData.name && venueData.city) {
      console.log('[Venues] No googlePlaceId provided - attempting geocode via Google Places');

      try {
        // Pass the address. A postcode pins a building, a town does not.
        // See the note on findPlaceFromGoogle, 2026-08-14.
        const placeData = await findPlaceFromGoogle(venueData.name, venueData.city, venueData.address);

        if (placeData) {
          console.log(`[Venues] Geocoded to place_id: ${placeData.placeId}`);

          // RUNBOOK §0.23: "No fixed building, no venue"
          // Validate that the resolved place is a building, not a locality
          const admissionResult = validateVenueAdmission({
            types: placeData.types,
            name: placeData.name,
            formatted_address: placeData.address,
            address_components: placeData.addressComponents,
          });

          if (!admissionResult.valid) {
            console.log(`[REJECT] Venue admission failed: ${admissionResult.code} - ${admissionResult.reason}`);
            return {
              statusCode: 422,
              headers: getCorsHeaders(event),
              body: JSON.stringify({
                error: admissionResult.reason,
                code: admissionResult.code,
                providedName: venueData.name,
                providedCity: venueData.city,
                resolvedPlaceId: placeData.placeId,
                resolvedTypes: placeData.types,
              }),
            };
          }

          // Check if this place_id already exists in our database (re-run L1 check)
          const googlePlaceMatch = existingVenues.find(
            (v) => v.google_place_id === placeData.placeId
          );

          if (googlePlaceMatch) {
            console.log('[SUCCESS] LEVEL 3.5 MATCH: Geocoded place_id matched existing venue');

            // Merge incoming externalIds into existing venue
            const mergedExternalIds = mergeExternalIds(
              googlePlaceMatch.external_ids || [],
              venueData.externalIds || []
            );

            if (venueData.externalIds && venueData.externalIds.length > 0) {
              console.log(`[Venues] Merging ${venueData.externalIds.length} externalIds into matched venue`);
              await dynamodb
                .update({
                  TableName: 'bndy-venues',
                  Key: { id: googlePlaceMatch.id },
                  UpdateExpression: 'SET external_ids = :extIds, updated_at = :now',
                  ExpressionAttributeValues: {
                    ':extIds': mergedExternalIds,
                    ':now': new Date().toISOString(),
                  },
                })
                .promise();
            }

            const formattedVenue = {
              id: googlePlaceMatch.id,
              name: googlePlaceMatch.name,
              address: googlePlaceMatch.address,
              latitude: googlePlaceMatch.latitude,
              longitude: googlePlaceMatch.longitude,
              location: googlePlaceMatch.location_object || {
                lat: googlePlaceMatch.latitude,
                lng: googlePlaceMatch.longitude,
              },
              googlePlaceId: googlePlaceMatch.google_place_id,
              validated: googlePlaceMatch.validated,
              externalIds: mergedExternalIds,
              matchConfidence: 100,
              matchMethod: 'google_place_id',
              ...editionMetadata(googlePlaceMatch),
            };
            return {
              statusCode: 200,
              headers: getCorsHeaders(event),
              body: JSON.stringify(formattedVenue),
            };
          }

          // No existing match - enrich venueData with geocoded info for L4 creation
          venueData.googlePlaceId = placeData.placeId;
          venueData.latitude = placeData.latitude;
          venueData.longitude = placeData.longitude;
          venueData.address = venueData.address || placeData.address;
          console.log('[Venues] Enriched venueData with geocoded place_id and coords');
        } else {
          // Google found nothing - refuse to create placeless venue (ADR-018 invariant)
          console.log('[REJECT] Cannot geocode venue - refusing to create placeless venue');
          return {
            statusCode: 422,
            headers: getCorsHeaders(event),
            body: JSON.stringify({
              error: 'Could not geocode venue - Google Places returned no results',
              needsReview: true,
              providedName: venueData.name,
              providedCity: venueData.city,
            }),
          };
        }
      } catch (error) {
        console.error('[ERROR] Geocode failed:', error.message);
        // On geocode error, also refuse to create (fail safe)
        return {
          statusCode: 422,
          headers: getCorsHeaders(event),
          body: JSON.stringify({
            error: 'Geocode service unavailable - cannot verify venue identity',
            needsReview: true,
          }),
        };
      }
    }

    // === LEVEL 4: Create new venue (with guaranteed place_id from geocode or caller) ===
    // At this point venueData.googlePlaceId is either:
    // - provided by caller directly, OR
    // - populated by L3.5 geocode above
    // If neither and we have name+city, L3.5 would have returned 422

    // ADR-021: If canCreate=false, return review instead of creating
    // Runner passes canCreate:false → venues need human validation before entry
    if (!canCreate) {
      console.log('[REVIEW] canCreate=false - returning for review instead of creating');
      return {
        statusCode: 200,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          action: 'review',
          reason: 'likely-new',
          queryName: venueData.name,
          queryCity: venueData.city,
          candidates: [] // No plausible match found
        })
      };
    }

    console.log('[NEW] LEVEL 4: No match found - creating new venue');

    // ADR-018 INVARIANT: Final guard - NEVER create venue without google_place_id
    // This should never trigger if L3.5 is working, but belt-and-suspenders
    if (!venueData.googlePlaceId || venueData.googlePlaceId.trim() === '') {
      console.error('[INVARIANT VIOLATION] Attempted to create venue without google_place_id');
      return {
        statusCode: 422,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          error: 'Cannot create venue without google_place_id - geocoding failed or was bypassed',
          code: 'MISSING_PLACE_ID',
          needsReview: true,
          providedName: venueData.name,
          providedCity: venueData.city
        })
      };
    }

    const now = new Date().toISOString();
    const newVenue = {
      id: require('crypto').randomUUID(),
      name: venueData.name,
      address: venueData.address,
      city: venueData.city || null,
      latitude: venueData.latitude || 0,
      longitude: venueData.longitude || 0,
      location_object: venueData.location || { lat: venueData.latitude, lng: venueData.longitude },
      google_place_id: venueData.googlePlaceId,  // Now guaranteed non-empty
      website: venueData.website || '',
      validated: false,
      name_variants: venueData.nameVariants || [],
      phone: venueData.phone || '',
      postcode: venueData.postcode || '',
      facilities: venueData.facilities || [],
      social_media_urls: venueData.socialMediaUrls || [],
      profile_image_url: venueData.profileImageUrl || null,
      external_ids: venueData.externalIds || [],
      standard_ticketed: false,
      standard_ticket_information: '',
      standard_ticket_url: '',
      createdAt: now,
      updated_at: now,
      // AI creation flags + B4: community wizard venues need review
      ai_created: venueData.ai_created || false,
      needs_review: venueData.needs_review || venueData.source === 'community_wizard' || false,
      created_source: venueData.created_source || venueData.source || 'backstage_wizard',
      ...(event.__allowScopedIngestion && {
        publicationScopes: venueData.publicationScopes,
        discoveryScopes: venueData.discoveryScopes,
        ...(venueData.venueKind !== undefined && { venueKind: venueData.venueKind })
      })
    };

    // HARD GATE (2026-07-27): venue UID = google_place_id. The sentinel
    // transaction makes a second venue with the same place_id impossible at
    // the database level, regardless of which client got here or what the
    // (advisory) ladder above concluded.
    const gateResult = await gatedPut(dynamodb, {
      tableName: 'bndy-venues',
      item: newVenue,
      keys: [venuePlaceKey(newVenue.google_place_id)],
      entityType: 'venue',
      source: newVenue.created_source || 'find-or-create'
    });

    if (!gateResult.written) {
      // Enforce mode caught a place_id collision the ladder missed (race or
      // truncated candidate set). Return the EXISTING venue — find-or-create
      // semantics — rather than a bare 409.
      const existingId = gateResult.existing && gateResult.existing.refId;
      if (existingId) {
        const existingRes = await dynamodb.get({ TableName: 'bndy-venues', Key: { id: existingId } }).promise();
        if (existingRes.Item) {
          console.log(`[Venues] Gate bounced create; returning existing venue ${existingId}`);
          return {
            statusCode: 200,
            headers: getCorsHeaders(event),
            body: JSON.stringify({ ...formatVenueResponse(existingRes.Item), matchConfidence: 100, matchMethod: 'google_place_id_gate' })
          };
        }
      }
      return {
        statusCode: 409,
        headers: getCorsHeaders(event),
        body: JSON.stringify(duplicateResponseBody('venue', gateResult.existing))
      };
    }

    // Trigger enrichment in background (async, non-blocking)
    await triggerVenueEnrichment(lambda, newVenue.id);

    const formattedNewVenue = {
      id: newVenue.id,
      name: newVenue.name,
      address: newVenue.address,
      latitude: newVenue.latitude,
      longitude: newVenue.longitude,
      location: newVenue.location_object,
      googlePlaceId: newVenue.google_place_id,
      validated: newVenue.validated,
      externalIds: newVenue.external_ids,
      matchConfidence: 0,
      matchMethod: 'new_venue_created',
      ...editionMetadata(newVenue)
    };

    return {
      statusCode: 201,
      headers: getCorsHeaders(event),
      body: JSON.stringify(formattedNewVenue)
    };

  } catch (error) {
    console.error('[ERROR] Find-or-create failed:', error);
    throw error;
  }
}

/**
 * Handle POST /api/integration/venues
 * Searches BNDY first (cost optimization), then falls back to Google Places
 * Requires x-api-key header for authentication
 *
 * @param {Object} deps - Dependencies { dynamodb, lambda, getCorsHeaders }
 * @param {Object} body - Request body
 * @param {Object} event - Lambda event
 * @returns {Promise<Object>} Lambda response
 */
async function handleIntegrationCreateVenue(deps, body, event) {
  const { dynamodb, getCorsHeaders } = deps;

  console.log('[Integration] Processing venue creation request');

  // 1. Validate API key
  if (!validateApiKey(event)) {
    console.log('[Integration] API key validation failed');
    return {
      statusCode: 401,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Invalid or missing API key' })
    };
  }

  // 2. Validate input
  const { name, city, facebookUrl, instagramUrl, websiteUrl, socialMediaUrls } = body;
  if (!name || !city) {
    return {
      statusCode: 400,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'name and city are required' })
    };
  }

  try {
    // 3. BNDY-FIRST: Search existing venues before calling Google (cost optimization)
    console.log(`[Integration] Searching BNDY database for: "${name}" in "${city}"`);
    // Paginated — see audit finding F2 (bare scan silently truncates at 1MB)
    const existingVenues = await scanAll(dynamodb, { TableName: 'bndy-venues' });

    // Filter by city (case-insensitive) and find best name match
    const normalizedCity = city.toLowerCase().trim();

    let bestMatch = null;
    let bestScore = 0;

    for (const venue of existingVenues) {
      // Skip venues without name
      if (!venue.name) continue;

      // Check city match (case-insensitive, handles null/undefined)
      const venueCity = (venue.city || '').toLowerCase().trim();
      if (!venueCity.includes(normalizedCity) && !normalizedCity.includes(venueCity)) {
        continue; // Skip venues in different cities
      }

      // Calculate name similarity
      const similarity = calculateSimilarity(name, venue.name);
      if (similarity >= 80 && similarity > bestScore) {
        bestMatch = venue;
        bestScore = similarity;
      }
    }

    // If we found a good BNDY match, return it WITHOUT calling Google
    if (bestMatch) {
      console.log(`[Integration] BNDY match found: "${bestMatch.name}" (${bestScore.toFixed(1)}% similarity)`);
      const formattedVenue = {
        id: bestMatch.id,
        name: bestMatch.name,
        address: bestMatch.address,
        city: bestMatch.city,
        latitude: bestMatch.latitude,
        longitude: bestMatch.longitude,
        location: bestMatch.location_object || { lat: bestMatch.latitude, lng: bestMatch.longitude },
        googlePlaceId: bestMatch.google_place_id,
        validated: bestMatch.validated,
        matchConfidence: Math.round(bestScore),
        matchMethod: 'bndy_name_city_match'
      };

      return {
        statusCode: 200,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          success: true,
          venue: formattedVenue,
          isNew: false,
          matchMethod: 'bndy_name_city_match'
        })
      };
    }

    // 4. No BNDY match - NOW call Google Places
    console.log(`[Integration] No BNDY match, calling Google Places for: "${name}, ${city}"`);
    const placeData = await findPlaceFromGoogle(name, city);
    if (!placeData) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          error: `Venue "${name}" not found in BNDY or Google Places`,
          suggestion: 'Try a more specific name or check spelling'
        })
      };
    }

    // 5. Build social media URLs array from individual URLs or provided array
    const urls = Array.isArray(socialMediaUrls) ? [...socialMediaUrls] : [];
    if (facebookUrl) urls.push({ platform: 'facebook', url: facebookUrl });
    if (instagramUrl) urls.push({ platform: 'instagram', url: instagramUrl });
    if (websiteUrl) urls.push({ platform: 'website', url: websiteUrl });

    // 6. Call existing find-or-create logic (handles googlePlaceId dedup)
    const venueData = {
      name: placeData.name,
      address: placeData.address,
      googlePlaceId: placeData.placeId,
      latitude: placeData.latitude,
      longitude: placeData.longitude,
      city: city,
      socialMediaUrls: urls,
      ai_created: true,
      needs_review: true,
      created_source: 'integration_api'
    };

    const result = await handleFindOrCreateVenue(deps, venueData, event);

    // 7. Wrap response with integration-friendly format
    const resultBody = JSON.parse(result.body);
    const isNew = resultBody.matchMethod === 'new_venue_created';

    console.log(`[Integration] Venue ${isNew ? 'created' : 'matched via Google'}: ${resultBody.id}`);

    return {
      statusCode: result.statusCode,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        success: true,
        venue: resultBody,
        isNew: isNew,
        matchMethod: resultBody.matchMethod
      })
    };
  } catch (error) {
    console.error('[Integration] Error:', error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
}

module.exports = {
  formatVenueResponse,
  triggerVenueEnrichment,
  handleFindOrCreateVenue,
  handleIntegrationCreateVenue
};
