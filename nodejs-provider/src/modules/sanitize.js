/**
 * sanitize.js
 * Centralized input validation and sanitization utilities
 * for SQL injection prevention
 */

const FIELD_NAME_PATTERN = /^[a-zA-Z0-9_*]+$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9_]+$/;

// DDL/DML keywords that should never appear in a WHERE clause from user input
const DANGEROUS_KEYWORDS = [
  'DROP', 'DELETE', 'TRUNCATE', 'ALTER', 'CREATE', 'INSERT',
  'UPDATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'MERGE'
];

const DANGEROUS_KEYWORD_REGEX = new RegExp(
  `\\b(${DANGEROUS_KEYWORDS.join('|')})\\b`, 'i'
);

/**
 * Validate a field name (used for outFields).
 * Allows alphanumeric, underscore, and asterisk (*).
 * Throws on anything else.
 *
 * @param {string} name - Field name to validate
 * @returns {string} The validated field name
 * @throws {Error} If the field name contains invalid characters
 */
function validateFieldName(name) {
  const trimmed = name.trim();
  if (!FIELD_NAME_PATTERN.test(trimmed)) {
    throw new Error(`Invalid field name: "${trimmed}". Only alphanumeric characters, underscores, and * are allowed.`);
  }
  return trimmed;
}

/**
 * Validate an identifier (used for column names like geometryColumn, idField).
 * Allows alphanumeric and underscore only (no asterisk).
 * Throws on anything else.
 *
 * @param {string} name - Identifier to validate
 * @returns {string} The validated identifier
 * @throws {Error} If the identifier contains invalid characters
 */
function validateIdentifier(name) {
  const trimmed = name.trim();
  if (!IDENTIFIER_PATTERN.test(trimmed)) {
    throw new Error(`Invalid identifier: "${trimmed}". Only alphanumeric characters and underscores are allowed.`);
  }
  return trimmed;
}

/**
 * Escape single quotes in a string value for safe SQL interpolation.
 * Doubles single quotes: O'Brien -> O''Brien
 *
 * @param {string} value - String value to escape
 * @returns {string} The escaped string
 */
function escapeSqlString(value) {
  if (typeof value !== 'string') {
    value = String(value);
  }
  return value.replace(/'/g, "''");
}

/**
 * Check a WHERE clause for dangerous DDL/DML keywords.
 * Uses word-boundary matching to avoid false positives on column/table names.
 * Throws if a dangerous keyword is found.
 *
 * @param {string} clause - The WHERE clause to check
 * @returns {string} The clause if safe
 * @throws {Error} If a dangerous keyword is detected
 */
function checkWhereClauseSafety(clause) {
  if (!clause || typeof clause !== 'string') {
    return clause;
  }

  const match = DANGEROUS_KEYWORD_REGEX.exec(clause);
  if (match) {
    throw new Error(`Potentially dangerous SQL keyword detected in WHERE clause: "${match[1]}"`);
  }

  return clause;
}

/**
 * Validate and parse an integer value.
 * Returns the parsed integer or the fallback value if invalid.
 *
 * @param {*} value - Value to validate as integer
 * @param {number} [fallback=0] - Fallback value if parsing fails
 * @returns {number} The parsed integer or fallback
 */
function validateInteger(value, fallback = 0) {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? fallback : parsed;
}

module.exports = {
  validateFieldName,
  validateIdentifier,
  escapeSqlString,
  checkWhereClauseSafety,
  validateInteger,
};
