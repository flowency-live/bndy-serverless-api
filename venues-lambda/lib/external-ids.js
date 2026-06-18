/**
 * External ID Merge Utilities
 *
 * Handles merging external IDs from multiple sources.
 * Used when matching venues to preserve all source references.
 */

/**
 * Additively merge new externalIds into existing externalIds.
 * For each source, only keeps one entry (new overwrites existing).
 * @param {Array<{source: string, id: string}>} existing - Current externalIds
 * @param {Array<{source: string, id: string}>} incoming - New externalIds to add
 * @returns {Array<{source: string, id: string}>} Merged array
 */
function mergeExternalIds(existing, incoming) {
  if (!incoming || incoming.length === 0) return existing || [];
  if (!existing || existing.length === 0) return incoming;

  // Create map keyed by source, existing first, then overwrite with incoming
  const bySource = new Map();
  for (const ext of existing) {
    if (ext.source && ext.id) {
      bySource.set(ext.source, ext);
    }
  }
  for (const ext of incoming) {
    if (ext.source && ext.id) {
      bySource.set(ext.source, ext);
    }
  }
  return Array.from(bySource.values());
}

module.exports = {
  mergeExternalIds
};
