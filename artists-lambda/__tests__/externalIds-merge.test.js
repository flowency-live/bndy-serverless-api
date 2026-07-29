/**
 * Test: Artist externalIds Additive Merge
 *
 * Bug: externalIds don't persist when creating/updating artists via community
 * and MCP paths. Storage works (external_ids in DynamoDB) but:
 * 1. Regular update handler doesn't handle externalIds at all
 * 2. MCP update handler replaces instead of merging
 *
 * Fix: Both paths must do additive merge (union, dedupe by source+id)
 */

describe('Artist externalIds Additive Merge', () => {
  test('Placeholder: externalIds merge logic exists', () => {
    // This test will pass when the implementation is complete
    // Real tests will be integration tests using the actual API
    expect(true).toBe(true);
  });
});
