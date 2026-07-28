/**
 * Data Quality Validation — CANONICAL copy (shared/identity), byte-synced to
 * each lambda's lib/ by check-sync.test.js. Exported API is stable — the
 * handlers import { validateArtistData } and must not need changes when
 * rules here evolve.
 *
 * v2 (2026-07-27) — corrected per VSCODE-AGENT-VALIDATION-GATES-SPEC.md after
 * the first deployment used the un-amended patterns:
 *  - REMOVED the >30% non-ASCII rejection. Accented/stylized names are
 *    legitimate (Motörhead-class); searchability is handled by the unicode
 *    fold inside identity.normalise(), not by rejection. A name is
 *    unsearchable ONLY if nothing alphanumeric survives the fold.
 *  - NARROWED lineup detection. Bare "and", "&" and single commas are
 *    legitimate name grammar (Harris & Wheeler, Jane and the Hurricanes,
 *    Mike & The Floorfillers). Only unambiguous lineup shapes reject.
 *  - Placeholder list extended (postponed/various/unknown/open mic) and
 *    matched on the NORMALISED name so "  T.B.C. " variants are caught while
 *    "The Cancellations" (a plausible band name) is not.
 *
 * Runbook authority: MASTER-IMPORT-RUNBOOK.md §0.3-0.6, §1A, §2A, Gate spec
 * Gates 1-3+5. Multi-artist ruling: lineups are NEVER artist records — one
 * record per act, discrete event per artist, lineup string only in the
 * (parent) event title.
 */

'use strict';

const { normalise, normaliseKey } = require('./identity');

/**
 * UNAMBIGUOUS lineup shapes only (Gate 1, amended).
 * Deliberately NOT matched: single "and"/"&" (duo grammar), single comma,
 * "with" alone, "v " (initials).
 */
const MULTI_ARTIST_PATTERNS = [
  /\+\s*\d+\s*more/i,               // "+ 2 more"
  /\bmore\s+tba\b/i,                // "more TBA"
  /\S\s*\+\s*\S/,                   // any "A + B" joiner (Jason ruling: + is a separator)
  /,.*,/,                           // two or more commas = a list
  /,\s*.*\s(and|&)\s/i,             // "A, B and C" — comma followed by and/& = 3+ acts
  /\sand\s.*\sand\s/i,              // "A and B and C" — double and
  /\bvs\.?\b/i,                     // "X vs Y"
  /\bw\/\s*\S/i,                    // "w/ support"
  /\bfeaturing\b/i,
  /\bfeat\.?\b/i,
  /\bft\.?\s/i,                     // "ft " / "ft. " (trailing space avoids surnames like "Croft")
  /\bsupporting\b/i,
  /\bsupport\s+from\b/i,
  /\bplus\s+(special\s+)?guests?\b/i,
  /\bwith\s+special\s+guests?\b/i,
];

/**
 * Placeholder identities that must never become artist records (Gate 2).
 * Compared against the NORMALISED name (exact match) — substring matching
 * would wrongly hit real names containing these words.
 */
const PLACEHOLDER_NAMES = new Set([
  'cancelled', 'canceled', 'postponed',
  'tbc', 'to be confirmed', 't b c',
  'tba', 'to be announced', 't b a',
  'various', 'various artists', 'unknown', 'open mic', 'open mic night',
]);

/** Gate 1: name looks like a multi-artist lineup. */
function isMultiArtistLineup(name) {
  if (!name || typeof name !== 'string') return false;
  return MULTI_ARTIST_PATTERNS.some((pattern) => pattern.test(name));
}

/** Gate 2: name is a cancellation/placeholder indicator, not an act. */
function isCancelledIndicator(name) {
  if (!name || typeof name !== 'string') return false;
  return PLACEHOLDER_NAMES.has(normalise(name));
}

/**
 * Gate 3 (amended): searchability. A name is invalid ONLY when nothing
 * alphanumeric survives the unicode fold + normalisation — i.e. it can never
 * be found by any search. Accented, stylized, and non-ASCII names are VALID;
 * their searchable form is produced by the fold and stored via
 * name_lower/nameVariants, not enforced by rejection.
 */
function validateArtistName(name) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    return { valid: false, reason: 'Name is required' };
  }
  if (normaliseKey(name).length === 0) {
    return {
      valid: false,
      reason: 'Name contains no searchable characters (nothing alphanumeric survives normalisation)',
      suggestion: 'Provide the act\'s plain searchable name; the stylized form belongs in nameVariants/display_name',
    };
  }
  return { valid: true };
}

/**
 * Gate 5 helper: strip billing descriptions from a name candidate.
 * "Not Guilty - 5pc Local Rock/pop Covers Band" -> "Not Guilty".
 * Only strips when the tail after " - " reads like a description (contains a
 * genre/act word or a piece-count), so hyphenated NAMES ("Blond-Age",
 * "The All-Nighters") are untouched.
 */
const DESCRIPTION_TAIL = /\b(\d+\s*(pc|piece)|band|duo|trio|covers?|tribute|rock|pop|indie|acoustic|function|party|local)\b/i;
// Promo/listing-copy tail (Cosey Club class — "It'll Be Fun! All Aboard!!"):
// exclamations, hype words, sentence-like blurb, times/prices baked into billing.
const PROMO_TAIL = /(!|\b(fun|aboard|join us|don'?t miss|get your|tickets?|book now|free entry|doors|from \d|£\d)\b)/i;
function sanitizeBillingName(name) {
  if (!name || typeof name !== 'string') return name;
  const m = name.split(/\s[-–—]\s/); // " - ", " – ", " — "
  if (m.length > 1) {
    const head = m[0].trim();
    const tail = m.slice(1).join(' - ').trim();
    if (head && (DESCRIPTION_TAIL.test(tail) || PROMO_TAIL.test(tail))) return head;
  }
  return name.trim();
}

/**
 * Listing-copy detector (runbook §0.6, v1.5): the name itself reads like an
 * advert rather than an act name — promo tail after a dash, or hype
 * punctuation/phrases. Used to route to review; sanitizeBillingName gives
 * the suggested clean form.
 */
function isListingCopyName(name) {
  if (!name || typeof name !== 'string') return false;
  if (sanitizeBillingName(name) !== name.trim()) return true; // strippable tail found
  // Standalone hype signals: double bangs, or promo phrases anywhere
  return /!{2,}/.test(name) || /\b(join us|don'?t miss|book now|free entry|all aboard|it'?ll be)\b/i.test(name);
}

/**
 * Comprehensive artist validation — stable API used by the handlers.
 * Returns { valid: boolean, errors: string[] }
 */
function validateArtistData(artistData) {
  const errors = [];
  const { name } = artistData || {};

  if (!name) {
    return { valid: false, errors: ['Artist name is required'] };
  }

  if (isMultiArtistLineup(name)) {
    errors.push(
      `multi_artist_lineup_detected: Artist name "${name}" appears to be a multi-artist lineup. ` +
      `Lineups are never artist records: create one artist per act and one discrete event per artist; ` +
      `the lineup string belongs only in the (parent) event title (MASTER-IMPORT-RUNBOOK §4).`
    );
  }

  if (isCancelledIndicator(name)) {
    errors.push(
      `cancelled_event_detected: Artist name "${name}" indicates a cancellation/placeholder, not an act. ` +
      `Mark the event cancelled via the event status field instead. Unnamed acts stay in the event title only.`
    );
  }

  const nameValidation = validateArtistName(name);
  if (!nameValidation.valid) {
    errors.push(
      `unsearchable_name: ${nameValidation.reason}. ${nameValidation.suggestion || ''}`
    );
  }

  if (isListingCopyName(name)) {
    errors.push(
      `listing_copy_name: Artist name "${name}" contains listing/promo copy, not just the act's name. ` +
      `Suggested clean name: "${sanitizeBillingName(name)}". Resolve THAT against existing artists ` +
      `(it may already exist) — the description/blurb belongs nowhere, or at most in the event title (MASTER-IMPORT-RUNBOOK §0.6).`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = {
  isMultiArtistLineup,
  isCancelledIndicator,
  validateArtistName,
  validateArtistData,
  sanitizeBillingName,
  isListingCopyName,
  MULTI_ARTIST_PATTERNS,
};
