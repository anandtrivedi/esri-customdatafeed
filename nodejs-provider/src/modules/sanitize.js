/**
 * sanitize.js
 * Centralized input validation and sanitization utilities
 * for SQL injection prevention
 */

const FIELD_NAME_PATTERN = /^[a-zA-Z0-9_*]+$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9_]+$/;

// DDL/DML/data-exfiltration keywords that should never appear in a WHERE clause
const DANGEROUS_KEYWORDS = [
  'DROP', 'DELETE', 'TRUNCATE', 'ALTER', 'CREATE', 'INSERT',
  'UPDATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'MERGE',
  'UNION', 'SELECT', 'INTO'
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
 * Check a WHERE clause for dangerous DDL/DML keywords, subqueries, multiple statements, comments, string forms the
 * scanner can't follow, and unbalanced parentheses. Throws if any is found.
 *
 * The keyword, subquery, ; and comment checks look only at SQL code, not inside quoted strings or identifiers, so a
 * value like contact_name = 'X (delete me)' or remarks = 'Exit; see -- notes' is allowed (v1.2.4: such a value was
 * rejected as "dangerous keyword delete"). A literal can't run as SQL, and the scanner follows each backend's own
 * quoting rules (backslashEscapes), so it ends a literal exactly where the database does.
 *
 * @param {string} clause - The WHERE clause to check
 * @param {{backslashEscapes?: boolean}} [opts] - true for Databricks SQL (\' escapes a quote); false for Postgres
 * @returns {string} The clause if safe
 * @throws {Error} If the clause is unsafe
 */
function checkWhereClauseSafety(clause, { backslashEscapes = false } = {}) {
  if (!clause || typeof clause !== 'string') {
    return clause;
  }

  // One pass over the clause: track quoting and parenthesis depth, and build `code`, the clause with the contents of
  // string literals and quoted identifiers blanked out (quote marks kept). Parentheses must balance outside literals:
  // both builders wrap the client WHERE as (where) before ANDing the geometry/time/objectId filters, and
  // "1=1) OR (1=1" would close that wrapper early and drop those filters. A string form the scanner can't follow, or
  // a ) that closes the wrapper, stops the scan; the unscanned rest then counts as code, so nothing is hidden.
  let depth = 0;
  let quote = null; // ' or " (string literal / quoted identifier) or ` (Databricks identifier)
  let scanError = null;
  let code = '';
  let i = 0;
  for (; i < clause.length; i++) {
    const ch = clause[i];
    if (quote) {
      if (backslashEscapes && ch === '\\' && quote !== '`') {
        // Databricks SQL: \' escapes a quote. NOT Postgres (standard_conforming_strings): there \ is an ordinary
        // character, so honouring it on the Lakebase path would let 'a\' ...) OR (1=1 slip past this check.
        code += i + 1 < clause.length ? '  ' : ' ';
        i++;
      } else if (ch === quote) {
        if (clause[i + 1] === quote) { code += '  '; i++; } // doubled quote escapes itself
        else { quote = null; code += ch; }
      } else {
        code += ' ';
      }
    } else if (ch === "'" || ch === '"' || ch === '`') {
      // String forms whose escaping this scanner doesn't follow, so a ( or ) it counts as code could really be
      // inside a string, or the reverse: Databricks raw strings r'...' (backslash is literal) and Postgres E'...'
      // (backslash escapes). A prefix only counts at a word start: name'x' is not a prefix.
      const prefix = /[A-Za-z0-9_$]/.test(clause[i - 2] || '') ? '' : (clause[i - 1] || '');
      if (ch !== '`' && /[rR]/.test(prefix)) { scanError = 'Raw string literals (r\'...\') are not allowed in WHERE clause'; break; }
      if (ch === "'" && /[eE]/.test(prefix)) { scanError = 'Escape string literals (E\'...\') are not allowed in WHERE clause'; break; }
      quote = ch;
      code += ch;
    } else if (ch === '$' && !/[A-Za-z0-9_$]/.test(clause[i - 1] || '') && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(clause.slice(i))) {
      // Postgres dollar quoting ($$...$$, $tag$...$tag$): a string the scanner would read as code. Right after a name
      // character the $ is part of the identifier (a$b$c), as in Postgres.
      scanError = 'Dollar-quoted strings ($$...$$) are not allowed in WHERE clause';
      break;
    } else {
      if (ch === '(') depth++;
      if (ch === ')' && --depth < 0) break;
      code += ch;
    }
  }
  if (i < clause.length) code += clause.slice(i); // stopped early: check the rest as code

  const match = DANGEROUS_KEYWORD_REGEX.exec(code);
  if (match) {
    throw new Error(`Potentially dangerous SQL keyword detected in WHERE clause: "${match[1]}"`);
  }

  // Block subqueries via parenthesized SELECT
  if (/\(\s*SELECT\b/i.test(code)) {
    throw new Error('Subqueries are not allowed in WHERE clause');
  }

  // Block multiple statements via semicolons
  if (/;/.test(code)) {
    throw new Error('Multiple statements (;) are not allowed in WHERE clause');
  }

  // Block SQL comments that could hide injected code
  if (/--/.test(code) || /\/\*/.test(code)) {
    throw new Error('SQL comments are not allowed in WHERE clause');
  }

  if (scanError) {
    throw new Error(scanError);
  }
  if (quote) {
    // The scanner and the database disagree about where the string ends, so its parenthesis count can't be trusted.
    throw new Error('Unterminated string or quoted identifier in WHERE clause');
  }
  if (depth !== 0) {
    throw new Error('Unbalanced parentheses in WHERE clause');
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
