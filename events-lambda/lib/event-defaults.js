// Event time defaults — RUNBOOK §5.6 (Jason ruling, v1.7, 2026-07-29)
//
// THE RULE: an agent NEVER asks a human for a gig start time, and NEVER
// invents one. If the source gives no explicit time, the default below
// applies. The default is deterministic, so every caller produces the same
// answer for the same date.
//
//   Friday, Saturday  -> 21:00
//   Sunday            -> 19:00
//   Other weekdays    -> 20:00
//   Afternoon gig     -> 14:00  (only when the source indicates afternoon)
//
// Keep this file identical in shared/, events-lambda/lib/ and
// events-agent-lambda/lib/. Same copy pattern as identity.js.

const DEFAULT_END_TIME = '00:00';

const START_TIME_RULE =
  'RUNBOOK §5.6: Fri/Sat 21:00, Sun 19:00, other weekdays 20:00, afternoon 14:00.';

/**
 * Resolve the default start time for a gig date.
 * @param {string} date YYYY-MM-DD
 * @param {boolean} [afternoon] true only when the source indicates an afternoon gig
 * @returns {string} HH:MM, 24-hour
 */
function defaultStartTime(date, afternoon = false) {
  if (afternoon) return '14:00';

  // Midday UTC avoids any timezone rollover across the date boundary.
  const day = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday

  if (Number.isNaN(day)) return '20:00'; // Malformed date. Validation rejects it later.
  if (day === 5 || day === 6) return '21:00'; // Friday, Saturday
  if (day === 0) return '19:00'; // Sunday
  return '20:00';
}

/**
 * Apply the default only when the caller supplied nothing.
 * @returns {{startTime: string, defaulted: boolean}}
 */
function resolveStartTime(date, startTime, afternoon = false) {
  if (startTime && String(startTime).trim()) {
    return { startTime: String(startTime).trim(), defaulted: false };
  }
  return { startTime: defaultStartTime(date, afternoon), defaulted: true };
}

module.exports = {
  DEFAULT_END_TIME,
  START_TIME_RULE,
  defaultStartTime,
  resolveStartTime
};
