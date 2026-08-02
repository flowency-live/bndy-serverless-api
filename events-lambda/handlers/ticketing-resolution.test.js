/**
 * Tests for ticketing resolution logic
 *
 * Resolution precedence:
 * 1. Event ticketed explicitly set (true OR false) → wins outright
 * 2. Event ticketed unset → inherit venue.standardTicketed
 * 3. Neither set → isTicketed: false, source: 'none'
 */

const { resolveTicketing } = require('./ticketing-resolution');

describe('resolveTicketing', () => {
  // ─── TICKETED FLAG RESOLUTION ───────────────────────────────────────────────

  describe('ticketed flag precedence', () => {
    it('should return event ticketed=true when event explicitly set, venue true', () => {
      const event = { ticketed: true };
      const venue = { standardTicketed: true };

      const result = resolveTicketing(event, venue);

      expect(result.isTicketed).toBe(true);
      expect(result.source).toBe('event');
    });

    it('should return event ticketed=false when event explicitly set, venue true (override)', () => {
      const event = { ticketed: false };
      const venue = { standardTicketed: true };

      const result = resolveTicketing(event, venue);

      expect(result.isTicketed).toBe(false);
      expect(result.source).toBe('event');
    });

    it('should inherit venue ticketed=true when event unset', () => {
      const event = {}; // ticketed not set
      const venue = { standardTicketed: true };

      const result = resolveTicketing(event, venue);

      expect(result.isTicketed).toBe(true);
      expect(result.source).toBe('venue');
    });

    it('should inherit venue ticketed=false when event unset', () => {
      const event = {}; // ticketed not set
      const venue = { standardTicketed: false };

      const result = resolveTicketing(event, venue);

      expect(result.isTicketed).toBe(false);
      expect(result.source).toBe('venue');
    });

    it('should return event ticketed=true when event set, venue false', () => {
      const event = { ticketed: true };
      const venue = { standardTicketed: false };

      const result = resolveTicketing(event, venue);

      expect(result.isTicketed).toBe(true);
      expect(result.source).toBe('event');
    });

    it('should return isTicketed=false, source=none when neither set', () => {
      const event = {};
      const venue = {};

      const result = resolveTicketing(event, venue);

      expect(result.isTicketed).toBe(false);
      expect(result.source).toBe('none');
    });

    it('should treat event ticketed=null as unset (inherit venue)', () => {
      const event = { ticketed: null };
      const venue = { standardTicketed: true };

      const result = resolveTicketing(event, venue);

      expect(result.isTicketed).toBe(true);
      expect(result.source).toBe('venue');
    });

    it('should treat event ticketed=undefined as unset (inherit venue)', () => {
      const event = { ticketed: undefined };
      const venue = { standardTicketed: true };

      const result = resolveTicketing(event, venue);

      expect(result.isTicketed).toBe(true);
      expect(result.source).toBe('venue');
    });
  });

  // ─── PRICE RESOLUTION ───────────────────────────────────────────────────────

  describe('price resolution', () => {
    it('should use event price when present', () => {
      const event = { ticketed: true, price: '£5' };
      const venue = { standardTicketed: true, standardPrice: '£10' };

      const result = resolveTicketing(event, venue);

      expect(result.price).toBe('£5');
    });

    it('should use venue standardPrice when event price absent', () => {
      const event = { ticketed: true };
      const venue = { standardTicketed: true, standardPrice: '£10' };

      const result = resolveTicketing(event, venue);

      expect(result.price).toBe('£10');
    });

    it('should omit price key (not empty string) when both absent', () => {
      const event = { ticketed: true };
      const venue = { standardTicketed: true };

      const result = resolveTicketing(event, venue);

      expect(result).not.toHaveProperty('price');
    });

    it('should omit price when event price is empty string', () => {
      const event = { ticketed: true, price: '' };
      const venue = { standardTicketed: true };

      const result = resolveTicketing(event, venue);

      expect(result).not.toHaveProperty('price');
    });

    it('should omit price when venue price is empty string and event absent', () => {
      const event = { ticketed: true };
      const venue = { standardTicketed: true, standardPrice: '' };

      const result = resolveTicketing(event, venue);

      expect(result).not.toHaveProperty('price');
    });
  });

  // ─── TICKET URL RESOLUTION ──────────────────────────────────────────────────

  describe('ticketUrl resolution', () => {
    it('should use event ticketUrl when present', () => {
      const event = { ticketed: true, ticketUrl: 'https://event.tickets.com' };
      const venue = { standardTicketed: true, standardTicketUrl: 'https://venue.tickets.com' };

      const result = resolveTicketing(event, venue);

      expect(result.ticketUrl).toBe('https://event.tickets.com');
    });

    it('should use venue standardTicketUrl when event ticketUrl absent', () => {
      const event = { ticketed: true };
      const venue = { standardTicketed: true, standardTicketUrl: 'https://venue.tickets.com' };

      const result = resolveTicketing(event, venue);

      expect(result.ticketUrl).toBe('https://venue.tickets.com');
    });

    it('should omit ticketUrl key when both absent', () => {
      const event = { ticketed: true };
      const venue = { standardTicketed: true };

      const result = resolveTicketing(event, venue);

      expect(result).not.toHaveProperty('ticketUrl');
    });

    it('should omit ticketUrl when event url is empty string', () => {
      const event = { ticketed: true, ticketUrl: '' };
      const venue = { standardTicketed: true, standardTicketUrl: 'https://venue.tickets.com' };

      const result = resolveTicketing(event, venue);

      // Empty string means "no URL for this event", should NOT fall back to venue
      expect(result).not.toHaveProperty('ticketUrl');
    });
  });

  // ─── TICKET INFORMATION RESOLUTION ──────────────────────────────────────────

  describe('ticketInformation resolution', () => {
    it('should use event ticketInformation when present', () => {
      const event = { ticketed: true, ticketInformation: 'Doors 7pm' };
      const venue = { standardTicketed: true, standardTicketInformation: 'Box office open from 6pm' };

      const result = resolveTicketing(event, venue);

      expect(result.ticketInformation).toBe('Doors 7pm');
    });

    it('should use venue standardTicketInformation when event absent', () => {
      const event = { ticketed: true };
      const venue = { standardTicketed: true, standardTicketInformation: 'Box office open from 6pm' };

      const result = resolveTicketing(event, venue);

      expect(result.ticketInformation).toBe('Box office open from 6pm');
    });

    it('should omit ticketInformation key when both absent', () => {
      const event = { ticketed: true };
      const venue = { standardTicketed: true };

      const result = resolveTicketing(event, venue);

      expect(result).not.toHaveProperty('ticketInformation');
    });
  });

  // ─── EDGE CASES ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should handle null venue gracefully', () => {
      const event = { ticketed: true, price: '£5' };

      const result = resolveTicketing(event, null);

      expect(result.isTicketed).toBe(true);
      expect(result.source).toBe('event');
      expect(result.price).toBe('£5');
    });

    it('should handle undefined venue gracefully', () => {
      const event = { ticketed: true };

      const result = resolveTicketing(event, undefined);

      expect(result.isTicketed).toBe(true);
      expect(result.source).toBe('event');
    });

    it('should handle null event gracefully', () => {
      const venue = { standardTicketed: true };

      const result = resolveTicketing(null, venue);

      expect(result.isTicketed).toBe(true);
      expect(result.source).toBe('venue');
    });

    it('should return safe defaults when both null', () => {
      const result = resolveTicketing(null, null);

      expect(result.isTicketed).toBe(false);
      expect(result.source).toBe('none');
    });

    it('should preserve falsy ticketed=false on venue (not drop as falsy)', () => {
      const event = {};
      const venue = { standardTicketed: false };

      const result = resolveTicketing(event, venue);

      // This is the critical test - false must be treated as explicit false, not as unset
      expect(result.isTicketed).toBe(false);
      expect(result.source).toBe('venue');
    });

    it('should preserve falsy ticketed=false on event (not drop as falsy)', () => {
      const event = { ticketed: false };
      const venue = { standardTicketed: true };

      const result = resolveTicketing(event, venue);

      // Event's explicit false overrides venue's true
      expect(result.isTicketed).toBe(false);
      expect(result.source).toBe('event');
    });
  });

  // ─── REAL-WORLD SCENARIOS ───────────────────────────────────────────────────

  describe('real-world scenarios', () => {
    it('The Hairy Dog: event with no ticketed, venue has standardTicketed=true', () => {
      const event = {
        id: 'event-123',
        title: 'Live Band Night'
        // ticketed not set
      };
      const venue = {
        id: '3a5b4ca3-c4d8-4326-a0c8-c5dc585a52b7',
        name: 'The Hairy Dog',
        standardTicketed: true,
        standardTicketUrl: 'https://www.thehairydogderby.co.uk/gig-guide'
      };

      const result = resolveTicketing(event, venue);

      expect(result.isTicketed).toBe(true);
      expect(result.source).toBe('venue');
      expect(result.ticketUrl).toBe('https://www.thehairydogderby.co.uk/gig-guide');
    });

    it('Free gig at ticketed venue: event ticketed=false overrides venue', () => {
      const event = {
        id: 'event-456',
        title: 'Free Entry Night',
        ticketed: false
      };
      const venue = {
        id: '3a5b4ca3-c4d8-4326-a0c8-c5dc585a52b7',
        name: 'The Hairy Dog',
        standardTicketed: true,
        standardTicketUrl: 'https://www.thehairydogderby.co.uk/gig-guide'
      };

      const result = resolveTicketing(event, venue);

      expect(result.isTicketed).toBe(false);
      expect(result.source).toBe('event');
      // Venue banner should still show on venue page, but this event has no ticket marker
    });

    it('Ticketed gig at non-ticketed venue: event ticketed=true wins', () => {
      const event = {
        id: 'event-789',
        title: 'Special Ticketed Show',
        ticketed: true,
        price: '£15',
        ticketUrl: 'https://eventbrite.com/special-show'
      };
      const venue = {
        id: 'venue-xyz',
        name: 'Local Pub',
        standardTicketed: false
      };

      const result = resolveTicketing(event, venue);

      expect(result.isTicketed).toBe(true);
      expect(result.source).toBe('event');
      expect(result.price).toBe('£15');
      expect(result.ticketUrl).toBe('https://eventbrite.com/special-show');
    });

    it('Grassroots venue with no ticketing info: no marker, no banner', () => {
      const event = {
        id: 'event-abc',
        title: 'Open Mic Night'
      };
      const venue = {
        id: 'venue-def',
        name: 'The Corner Pub'
        // No standardTicketed set
      };

      const result = resolveTicketing(event, venue);

      expect(result.isTicketed).toBe(false);
      expect(result.source).toBe('none');
      expect(result).not.toHaveProperty('price');
      expect(result).not.toHaveProperty('ticketUrl');
      expect(result).not.toHaveProperty('ticketInformation');
    });
  });
});
