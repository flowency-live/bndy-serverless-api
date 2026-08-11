/**
 * Tests for venue admission validation (RUNBOOK §0.23)
 *
 * A venue must be a building, not a locality/city/town.
 * Rejects place types that represent geographic areas rather than premises.
 */

'use strict';

const {
  isLocalityType,
  isAddressOnlyName,
  validateVenueAdmission,
  LOCALITY_TYPES
} = require('./venue-admission');

describe('venue-admission', () => {
  describe('LOCALITY_TYPES constant', () => {
    it('should include all administrative and geographic types', () => {
      expect(LOCALITY_TYPES).toContain('locality');
      expect(LOCALITY_TYPES).toContain('postal_town');
      expect(LOCALITY_TYPES).toContain('administrative_area_level_1');
      expect(LOCALITY_TYPES).toContain('administrative_area_level_2');
      expect(LOCALITY_TYPES).toContain('administrative_area_level_3');
      expect(LOCALITY_TYPES).toContain('administrative_area_level_4');
      expect(LOCALITY_TYPES).toContain('sublocality');
      expect(LOCALITY_TYPES).toContain('route');
      expect(LOCALITY_TYPES).toContain('neighborhood');
      expect(LOCALITY_TYPES).toContain('political');
    });
  });

  describe('isLocalityType', () => {
    it('should return true for locality type', () => {
      expect(isLocalityType(['locality', 'political', 'geocode'])).toBe(true);
    });

    it('should return true for postal_town type', () => {
      expect(isLocalityType(['postal_town', 'political', 'geocode'])).toBe(true);
    });

    it('should return true for administrative_area types', () => {
      expect(isLocalityType(['administrative_area_level_1', 'political'])).toBe(true);
      expect(isLocalityType(['administrative_area_level_2', 'political'])).toBe(true);
      expect(isLocalityType(['administrative_area_level_3', 'political'])).toBe(true);
      expect(isLocalityType(['administrative_area_level_4', 'political'])).toBe(true);
    });

    it('should return true for route/neighborhood types', () => {
      expect(isLocalityType(['route'])).toBe(true);
      expect(isLocalityType(['neighborhood', 'political'])).toBe(true);
    });

    it('should return true for sublocality', () => {
      expect(isLocalityType(['sublocality', 'political'])).toBe(true);
      expect(isLocalityType(['sublocality_level_1', 'political'])).toBe(true);
    });

    it('should return false for establishment types', () => {
      expect(isLocalityType(['establishment', 'point_of_interest', 'bar'])).toBe(false);
    });

    it('should return false for premise types', () => {
      expect(isLocalityType(['premise', 'establishment'])).toBe(false);
    });

    it('should return false for empty or null types', () => {
      expect(isLocalityType([])).toBe(false);
      expect(isLocalityType(null)).toBe(false);
      expect(isLocalityType(undefined)).toBe(false);
    });

    it('should return false for bar/restaurant types', () => {
      expect(isLocalityType(['bar', 'point_of_interest', 'establishment'])).toBe(false);
      expect(isLocalityType(['restaurant', 'food', 'point_of_interest', 'establishment'])).toBe(false);
    });
  });

  describe('isAddressOnlyName', () => {
    it('should return true when name equals address stripped of UK suffix', () => {
      expect(isAddressOnlyName('Derby', 'Derby, UK', [])).toBe(true);
      expect(isAddressOnlyName('Ripley', 'Ripley, UK', [])).toBe(true);
      expect(isAddressOnlyName('Holyhead', 'Holyhead, United Kingdom', [])).toBe(true);
    });

    it('should return false when address has postcode', () => {
      const addressComponents = [
        { types: ['postal_code'], long_name: 'DE1 1AA' }
      ];
      expect(isAddressOnlyName('Derby', 'Derby, UK', addressComponents)).toBe(false);
    });

    it('should return false when address has street number', () => {
      const addressComponents = [
        { types: ['street_number'], long_name: '42' }
      ];
      expect(isAddressOnlyName('The Pub', 'The Pub, UK', addressComponents)).toBe(false);
    });

    it('should return false when name differs from stripped address', () => {
      expect(isAddressOnlyName('The Blue Bell', 'Derby, UK', [])).toBe(false);
    });

    it('should handle case-insensitive comparison', () => {
      expect(isAddressOnlyName('DERBY', 'Derby, UK', [])).toBe(true);
      expect(isAddressOnlyName('derby', 'DERBY, UK', [])).toBe(true);
    });

    it('should strip ", United Kingdom" suffix', () => {
      expect(isAddressOnlyName('Manchester', 'Manchester, United Kingdom', [])).toBe(true);
    });

    it('should return false for valid venue addresses', () => {
      const addressComponents = [
        { types: ['street_number'], long_name: '123' },
        { types: ['route'], long_name: 'High Street' },
        { types: ['postal_code'], long_name: 'DE1 2AB' }
      ];
      expect(isAddressOnlyName('The Blue Bell', '123 High Street, Derby, DE1 2AB, UK', addressComponents)).toBe(false);
    });
  });

  describe('validateVenueAdmission', () => {
    const mockPlaceData = (types, name, address, addressComponents = []) => ({
      types,
      name,
      formatted_address: address,
      address_components: addressComponents
    });

    describe('locality type rejection', () => {
      it('should reject Derby, UK (locality)', () => {
        const place = mockPlaceData(
          ['locality', 'political', 'geocode'],
          'Derby',
          'Derby, UK'
        );
        const result = validateVenueAdmission(place);
        expect(result.valid).toBe(false);
        expect(result.code).toBe('LOCALITY_NOT_VENUE');
        expect(result.reason).toContain('locality');
      });

      it('should reject Ripley, UK (postal_town)', () => {
        const place = mockPlaceData(
          ['postal_town', 'political'],
          'Ripley',
          'Ripley, UK'
        );
        const result = validateVenueAdmission(place);
        expect(result.valid).toBe(false);
        expect(result.code).toBe('LOCALITY_NOT_VENUE');
      });

      it('should reject administrative areas', () => {
        const place = mockPlaceData(
          ['administrative_area_level_2', 'political'],
          'Derbyshire',
          'Derbyshire, UK'
        );
        const result = validateVenueAdmission(place);
        expect(result.valid).toBe(false);
        expect(result.code).toBe('LOCALITY_NOT_VENUE');
      });

      it('should reject routes (streets without premises)', () => {
        const place = mockPlaceData(
          ['route'],
          'Chapel Street',
          'Chapel Street, Derby, UK'
        );
        const result = validateVenueAdmission(place);
        expect(result.valid).toBe(false);
        expect(result.code).toBe('LOCALITY_NOT_VENUE');
      });
    });

    describe('address-only name rejection', () => {
      it('should reject when name equals stripped address with no street/postcode', () => {
        const place = mockPlaceData(
          ['establishment'], // Not a locality type, but...
          'Clovelly',
          'Clovelly, UK',
          [] // No postcode, no street number
        );
        const result = validateVenueAdmission(place);
        expect(result.valid).toBe(false);
        expect(result.code).toBe('ADDRESS_ONLY_NAME');
      });

      it('should reject "The Square" with no real address components', () => {
        const place = mockPlaceData(
          ['point_of_interest'],
          'The Square',
          'The Square, UK',
          []
        );
        const result = validateVenueAdmission(place);
        expect(result.valid).toBe(false);
        expect(result.code).toBe('ADDRESS_ONLY_NAME');
      });
    });

    describe('valid venue acceptance', () => {
      it('should accept a normal pub with street address', () => {
        const place = mockPlaceData(
          ['bar', 'point_of_interest', 'establishment'],
          'The Blue Bell',
          '123 High Street, Derby, DE1 2AB, UK',
          [
            { types: ['street_number'], long_name: '123' },
            { types: ['route'], long_name: 'High Street' },
            { types: ['postal_town'], long_name: 'Derby' },
            { types: ['postal_code'], long_name: 'DE1 2AB' }
          ]
        );
        const result = validateVenueAdmission(place);
        expect(result.valid).toBe(true);
      });

      it('should accept a social club', () => {
        const place = mockPlaceData(
          ['establishment', 'point_of_interest'],
          'Working Mens Club',
          '42 Market Street, Buxton, SK17 6HY, UK',
          [
            { types: ['street_number'], long_name: '42' },
            { types: ['route'], long_name: 'Market Street' },
            { types: ['postal_code'], long_name: 'SK17 6HY' }
          ]
        );
        const result = validateVenueAdmission(place);
        expect(result.valid).toBe(true);
      });

      it('should accept a venue even with just a postcode (no street number)', () => {
        const place = mockPlaceData(
          ['establishment'],
          'The Village Hall',
          'The Village Hall, Ashbourne, DE6 1AA, UK',
          [
            { types: ['postal_code'], long_name: 'DE6 1AA' }
          ]
        );
        const result = validateVenueAdmission(place);
        expect(result.valid).toBe(true);
      });

      it('should accept a venue even with just a street number (no postcode)', () => {
        const place = mockPlaceData(
          ['establishment'],
          'The Cottage',
          '15 Main Road, Somewhere, UK',
          [
            { types: ['street_number'], long_name: '15' }
          ]
        );
        const result = validateVenueAdmission(place);
        expect(result.valid).toBe(true);
      });

      it('should accept park/field with genuine place_id (judgement call by caller)', () => {
        // Parks and fields with real Google place_ids are allowed
        // because the caller made a deliberate choice
        const place = mockPlaceData(
          ['park', 'point_of_interest', 'establishment'],
          'Victoria Park',
          'Victoria Park, Derby, DE23 8DB, UK',
          [
            { types: ['postal_code'], long_name: 'DE23 8DB' }
          ]
        );
        const result = validateVenueAdmission(place);
        expect(result.valid).toBe(true);
      });

      it('should accept a restaurant', () => {
        const place = mockPlaceData(
          ['restaurant', 'food', 'point_of_interest', 'establishment'],
          'The Curry House',
          '88 London Road, Derby, DE1 2QS, UK',
          [
            { types: ['street_number'], long_name: '88' },
            { types: ['postal_code'], long_name: 'DE1 2QS' }
          ]
        );
        const result = validateVenueAdmission(place);
        expect(result.valid).toBe(true);
      });
    });

    describe('edge cases', () => {
      it('should handle missing address_components gracefully', () => {
        const place = {
          types: ['bar', 'establishment'],
          name: 'The Pub',
          formatted_address: '1 High St, Derby, UK'
          // address_components intentionally missing
        };
        const result = validateVenueAdmission(place);
        // Should not crash; will use fallback logic
        expect(result).toBeDefined();
      });

      it('should handle missing types gracefully', () => {
        const place = {
          name: 'The Pub',
          formatted_address: '1 High St, Derby, UK',
          address_components: []
        };
        const result = validateVenueAdmission(place);
        // No types = not a locality, but check address-only-name rule
        expect(result).toBeDefined();
      });
    });
  });
});
