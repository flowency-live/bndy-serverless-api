'use strict';

jest.mock('aws-sdk', () => ({
  SES: jest.fn(() => ({ sendEmail: jest.fn(() => ({ promise: async () => ({}) })) })),
  DynamoDB: { DocumentClient: jest.fn(() => ({})) },
  SSM: jest.fn(() => ({})),
}));

const { outcomeMessage, reviewItem } = require('../lib/capture-reviews');

describe('Capture review projection', () => {
  it('keeps private Capture evidence for Godmode without leaking raw transport payloads', () => {
    const projected = reviewItem({
      id: 'capture-1',
      receivedAt: '2026-08-31T12:00:00Z',
      status: 'failed',
      sourceApp: 'chatzone',
      sharedText: 'Band at Venue',
      note: 'Private processor reason',
      rawPayload: { sender: 'must not project' },
      publicOutcome: { state: 'needs_review' },
      media: { type: 'image', mimeType: 'image/jpeg', key: 'private-key', bucket: 'private-bucket' },
    }, null);

    expect(projected.note).toBe('Private processor reason');
    expect(projected.media).toEqual({ available: true, mimeType: 'image/jpeg', originalName: null });
    expect(projected.rawPayload).toBeUndefined();
  });

  it('builds a useful resolved notification', () => {
    expect(outcomeMessage({
      state: 'added',
      result: { event: { url: 'https://bndy.live/g/event-1' } },
    })).toContain('https://bndy.live/g/event-1');
  });
});
