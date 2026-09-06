/**
 * Venue rules: the special-venue register on the canonical venue record.
 *
 * Owner ruling 06/09/2026 (Backline ADR-119 follow-on). Backline's billing stage
 * reads these at run start; the Godmode "Venue rules" page writes them. Only a
 * platform admin may write the field, and the shape is closed: a typo in a rule
 * or a surface must fail here, not sit in the record as a value nothing reads.
 *
 *   {
 *     rules:   ['promo-tail', 'lineup', ...],        // how this venue bills acts
 *     aliases: ['the-sugarmill', 'sugarmill'],       // source spellings, slug form
 *     region:  'Staffordshire',                      // optional
 *     listing: { url, surface, sourceId }            // optional; the venue's own gig page
 *   }
 */

const VENUE_BILLING_RULES = ['promo-tail', 'session-tag', 'tribute-subject', 'genre-bleed', 'lineup'];
const LISTING_SURFACES = ['static-html', 'wix-load-more', 'browser'];
const TOP_LEVEL_KEYS = ['rules', 'aliases', 'region', 'listing'];
const LISTING_KEYS = ['url', 'surface', 'sourceId'];

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

const fail = (error) => ({ ok: false, error });

function validateListing(listing) {
  if (!isPlainObject(listing)) return fail('listing must be an object');
  const unknown = Object.keys(listing).find((key) => !LISTING_KEYS.includes(key));
  if (unknown) return fail(`listing.${unknown} is not a recognised field`);
  if (!isNonEmptyString(listing.url) || !/^https?:\/\//i.test(listing.url)) return fail('listing.url must be an http(s) URL');
  if (!LISTING_SURFACES.includes(listing.surface)) return fail(`listing.surface must be one of: ${LISTING_SURFACES.join(', ')}`);
  if (listing.sourceId !== undefined && !isNonEmptyString(listing.sourceId)) return fail('listing.sourceId must be a non-empty string');
  return { ok: true };
}

/**
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
function validateVenueRules(value) {
  if (!isPlainObject(value)) return fail('venueRules must be an object');
  const unknown = Object.keys(value).find((key) => !TOP_LEVEL_KEYS.includes(key));
  if (unknown) return fail(`${unknown} is not a recognised venueRules field`);
  if (!Array.isArray(value.rules)) return fail('rules must be an array');
  const badRule = value.rules.find((rule) => !VENUE_BILLING_RULES.includes(rule));
  if (badRule !== undefined) return fail(`rules contains "${badRule}"; allowed: ${VENUE_BILLING_RULES.join(', ')}`);
  if (!Array.isArray(value.aliases)) return fail('aliases must be an array');
  if (value.aliases.some((alias) => !isNonEmptyString(alias))) return fail('aliases must be non-empty strings');
  if (value.region !== undefined && !isNonEmptyString(value.region)) return fail('region must be a non-empty string');
  if (value.listing !== undefined) {
    const listing = validateListing(value.listing);
    if (!listing.ok) return listing;
  }
  return { ok: true, value };
}

/** Every venue read projection uses this so the field cannot drift between routes. */
function venueRulesOf(item) {
  return item && item.venue_rules ? item.venue_rules : null;
}

module.exports = { VENUE_BILLING_RULES, LISTING_SURFACES, validateVenueRules, venueRulesOf };
