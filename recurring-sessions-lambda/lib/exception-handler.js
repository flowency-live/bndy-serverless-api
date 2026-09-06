/**
 * Exception Handler
 *
 * Apply exceptions (skip, cancel, move, override) to computed occurrences.
 * Exceptions are stored on the Series and applied during projection.
 */

const { generateOccurrenceKey } = require('./occurrence-key');

const EXCEPTION_TYPES = ['skip', 'cancel', 'move', 'override'];

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates an exception object.
 *
 * @param {Object} exception
 * @returns {string | null} Error message or null if valid
 */
function validateException(exception) {
  if (!exception || typeof exception !== 'object') {
    return 'exception is required';
  }

  if (!EXCEPTION_TYPES.includes(exception.type)) {
    return 'invalid exception type';
  }

  if (!exception.scheduledLocalDate) {
    return 'scheduledLocalDate is required';
  }

  if (!ISO_DATE_REGEX.test(exception.scheduledLocalDate)) {
    return 'invalid date format';
  }

  if (exception.type === 'move' && !exception.movedToDate) {
    return 'movedToDate is required for move exceptions';
  }

  if (exception.type === 'override' && (!exception.overrides || typeof exception.overrides !== 'object')) {
    return 'overrides object is required for override exceptions';
  }

  return null;
}

/**
 * Apply exceptions to a list of occurrences.
 *
 * @param {Array<Object>} occurrences - The computed occurrences
 * @param {Array<Object>} exceptions - The exceptions to apply
 * @returns {{ occurrences: Array<Object>, applied: Array<Object>, notApplied: Array<Object> }}
 */
function applyExceptions(occurrences, exceptions) {
  // Work on copies to maintain immutability
  let result = occurrences.map(occ => ({ ...occ }));
  const applied = [];
  const notApplied = [];

  for (const exception of exceptions) {
    const targetIndex = result.findIndex(
      occ => occ.scheduledLocalDate === exception.scheduledLocalDate
    );

    if (targetIndex === -1) {
      notApplied.push(exception);
      continue;
    }

    applied.push(exception);

    switch (exception.type) {
      case 'skip':
        // Remove the occurrence entirely
        result = result.filter((_, i) => i !== targetIndex);
        break;

      case 'cancel':
        // Mark as cancelled but keep in list
        result[targetIndex] = {
          ...result[targetIndex],
          status: 'cancelled',
          cancelReason: exception.reason
        };
        break;

      case 'move':
        // Change the date
        const movedOcc = result[targetIndex];
        const seriesId = movedOcc.occurrenceKey.split(':')[0];

        result[targetIndex] = {
          ...movedOcc,
          scheduledLocalDate: exception.movedToDate,
          occurrenceKey: generateOccurrenceKey(seriesId, exception.movedToDate),
          originalOccurrenceKey: movedOcc.occurrenceKey,
          movedFrom: exception.scheduledLocalDate,
          moveReason: exception.reason
        };
        break;

      case 'override':
        // Apply field overrides
        const overriddenFields = Object.keys(exception.overrides);
        result[targetIndex] = {
          ...result[targetIndex],
          ...exception.overrides,
          overriddenFields
        };
        break;
    }
  }

  return {
    occurrences: result,
    applied,
    notApplied
  };
}

module.exports = {
  applyExceptions,
  validateException,
  EXCEPTION_TYPES
};
