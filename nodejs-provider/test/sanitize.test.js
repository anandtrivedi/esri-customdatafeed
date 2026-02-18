const { expect } = require("chai");
const {
  validateFieldName,
  validateIdentifier,
  escapeSqlString,
  checkWhereClauseSafety,
  validateInteger,
} = require("../src/modules/sanitize");

describe("sanitize", () => {
  describe("validateFieldName", () => {
    it("should accept simple field names", () => {
      expect(validateFieldName("name")).to.equal("name");
      expect(validateFieldName("field_1")).to.equal("field_1");
      expect(validateFieldName("OBJECTID")).to.equal("OBJECTID");
    });

    it("should accept asterisk wildcard", () => {
      expect(validateFieldName("*")).to.equal("*");
    });

    it("should trim whitespace", () => {
      expect(validateFieldName("  name  ")).to.equal("name");
    });

    it("should reject field names with semicolons", () => {
      expect(() => validateFieldName("name;")).to.throw(/Invalid field name/);
    });

    it("should reject field names with single quotes", () => {
      expect(() => validateFieldName("name'")).to.throw(/Invalid field name/);
    });

    it("should reject field names with SQL comments", () => {
      expect(() => validateFieldName("name--")).to.throw(/Invalid field name/);
    });

    it("should reject field names with parentheses", () => {
      expect(() => validateFieldName("(SELECT 1)")).to.throw(
        /Invalid field name/
      );
    });

    it("should reject field names with spaces", () => {
      expect(() => validateFieldName("na me")).to.throw(/Invalid field name/);
    });

    it("should reject empty string", () => {
      expect(() => validateFieldName("")).to.throw(/Invalid field name/);
    });
  });

  describe("validateIdentifier", () => {
    it("should accept simple identifiers", () => {
      expect(validateIdentifier("geometry")).to.equal("geometry");
      expect(validateIdentifier("id_field")).to.equal("id_field");
      expect(validateIdentifier("col1")).to.equal("col1");
    });

    it("should reject asterisk (unlike validateFieldName)", () => {
      expect(() => validateIdentifier("*")).to.throw(/Invalid identifier/);
    });

    it("should reject identifiers with dots", () => {
      expect(() => validateIdentifier("schema.table")).to.throw(
        /Invalid identifier/
      );
    });

    it("should reject identifiers with semicolons", () => {
      expect(() => validateIdentifier("col;")).to.throw(/Invalid identifier/);
    });

    it("should reject identifiers with quotes", () => {
      expect(() => validateIdentifier("col'")).to.throw(/Invalid identifier/);
    });

    it("should reject identifiers with SQL comments", () => {
      expect(() => validateIdentifier("col--")).to.throw(/Invalid identifier/);
    });

    it("should reject identifiers with subqueries", () => {
      expect(() =>
        validateIdentifier("(SELECT password FROM users)")
      ).to.throw(/Invalid identifier/);
    });

    it("should trim whitespace", () => {
      expect(validateIdentifier("  col  ")).to.equal("col");
    });
  });

  describe("escapeSqlString", () => {
    it("should escape single quotes", () => {
      expect(escapeSqlString("O'Brien")).to.equal("O''Brien");
    });

    it("should handle multiple quotes", () => {
      expect(escapeSqlString("it's a 'test'")).to.equal("it''s a ''test''");
    });

    it("should handle strings without quotes", () => {
      expect(escapeSqlString("hello")).to.equal("hello");
    });

    it("should handle empty string", () => {
      expect(escapeSqlString("")).to.equal("");
    });

    it("should convert non-string input to string", () => {
      expect(escapeSqlString(123)).to.equal("123");
    });

    it("should handle SQL injection attempt with quotes", () => {
      expect(escapeSqlString("'; DROP TABLE x--")).to.equal(
        "''; DROP TABLE x--"
      );
    });
  });

  describe("checkWhereClauseSafety", () => {
    it("should allow normal WHERE clauses", () => {
      expect(checkWhereClauseSafety("status = 'active'")).to.equal(
        "status = 'active'"
      );
      expect(checkWhereClauseSafety("id > 10 AND name LIKE '%test%'")).to.equal(
        "id > 10 AND name LIKE '%test%'"
      );
    });

    it("should allow 1=1 (common ArcGIS default)", () => {
      expect(checkWhereClauseSafety("1=1")).to.equal("1=1");
    });

    it("should reject DROP keyword", () => {
      expect(() =>
        checkWhereClauseSafety("DROP TABLE users")
      ).to.throw(/dangerous SQL keyword.*DROP/i);
    });

    it("should reject DELETE keyword", () => {
      expect(() =>
        checkWhereClauseSafety("DELETE FROM users WHERE 1=1")
      ).to.throw(/dangerous SQL keyword.*DELETE/i);
    });

    it("should reject TRUNCATE keyword", () => {
      expect(() =>
        checkWhereClauseSafety("TRUNCATE TABLE users")
      ).to.throw(/dangerous SQL keyword.*TRUNCATE/i);
    });

    it("should reject ALTER keyword", () => {
      expect(() =>
        checkWhereClauseSafety("ALTER TABLE users ADD col INT")
      ).to.throw(/dangerous SQL keyword.*ALTER/i);
    });

    it("should reject CREATE keyword", () => {
      expect(() =>
        checkWhereClauseSafety("CREATE TABLE hack(x INT)")
      ).to.throw(/dangerous SQL keyword.*CREATE/i);
    });

    it("should reject INSERT keyword", () => {
      expect(() =>
        checkWhereClauseSafety("INSERT INTO users VALUES(1)")
      ).to.throw(/dangerous SQL keyword.*INSERT/i);
    });

    it("should reject UPDATE keyword", () => {
      expect(() =>
        checkWhereClauseSafety("UPDATE users SET admin=1")
      ).to.throw(/dangerous SQL keyword.*UPDATE/i);
    });

    it("should reject GRANT keyword", () => {
      expect(() =>
        checkWhereClauseSafety("GRANT ALL TO public")
      ).to.throw(/dangerous SQL keyword.*GRANT/i);
    });

    it("should reject REVOKE keyword", () => {
      expect(() =>
        checkWhereClauseSafety("REVOKE ALL FROM user1")
      ).to.throw(/dangerous SQL keyword.*REVOKE/i);
    });

    it("should reject EXEC keyword", () => {
      expect(() =>
        checkWhereClauseSafety("EXEC xp_cmdshell 'dir'")
      ).to.throw(/dangerous SQL keyword.*EXEC/i);
    });

    it("should reject EXECUTE keyword", () => {
      expect(() =>
        checkWhereClauseSafety("EXECUTE sp_configure")
      ).to.throw(/dangerous SQL keyword.*EXECUTE/i);
    });

    it("should reject MERGE keyword", () => {
      expect(() =>
        checkWhereClauseSafety("MERGE INTO target USING source ON 1=1")
      ).to.throw(/dangerous SQL keyword.*MERGE/i);
    });

    it("should be case-insensitive", () => {
      expect(() => checkWhereClauseSafety("drop table users")).to.throw(
        /dangerous SQL keyword/i
      );
      expect(() => checkWhereClauseSafety("Drop Table users")).to.throw(
        /dangerous SQL keyword/i
      );
    });

    it("should reject UNION keyword", () => {
      expect(() =>
        checkWhereClauseSafety("1=1 UNION SELECT password FROM users")
      ).to.throw(/dangerous SQL keyword.*UNION/i);
    });

    it("should reject SELECT keyword", () => {
      expect(() =>
        checkWhereClauseSafety("id IN (SELECT id FROM admin)")
      ).to.throw(/dangerous SQL keyword.*SELECT/i);
    });

    it("should reject INTO keyword", () => {
      expect(() =>
        checkWhereClauseSafety("1=1 INTO OUTFILE '/tmp/data'")
      ).to.throw(/dangerous SQL keyword.*INTO/i);
    });

    it("should reject subqueries with parenthesized SELECT", () => {
      expect(() =>
        checkWhereClauseSafety("id = (SELECT MAX(id) FROM users)")
      ).to.throw(/dangerous SQL keyword|Subqueries/i);
    });

    it("should reject semicolons (multiple statements)", () => {
      expect(() =>
        checkWhereClauseSafety("id = 1; WAITFOR DELAY '00:00:05'")
      ).to.throw(/Multiple statements/i);
    });

    it("should reject SQL comments (double dash)", () => {
      expect(() =>
        checkWhereClauseSafety("1=1 -- comment")
      ).to.throw(/SQL comments/i);
    });

    it("should reject SQL comments (block comments)", () => {
      expect(() =>
        checkWhereClauseSafety("1=1 /* comment */")
      ).to.throw(/SQL comments/i);
    });

    it("should handle null/undefined input gracefully", () => {
      expect(checkWhereClauseSafety(null)).to.be.null;
      expect(checkWhereClauseSafety(undefined)).to.be.undefined;
    });

    it("should not flag substrings (word boundary check)", () => {
      // 'updated_at' contains 'update' but should not trigger
      expect(checkWhereClauseSafety("updated_at > '2024-01-01'")).to.equal(
        "updated_at > '2024-01-01'"
      );
      // 'merge_key' contains 'merge' but should not trigger
      expect(checkWhereClauseSafety("merge_key = 'abc'")).to.equal(
        "merge_key = 'abc'"
      );
      // 'selection' contains 'select' but should not trigger
      expect(checkWhereClauseSafety("selection = 'yes'")).to.equal(
        "selection = 'yes'"
      );
      // 'union_type' contains 'union' but should not trigger
      expect(checkWhereClauseSafety("union_type = 'A'")).to.equal(
        "union_type = 'A'"
      );
    });
  });

  describe("validateInteger", () => {
    it("should parse valid integers", () => {
      expect(validateInteger("10")).to.equal(10);
      expect(validateInteger("0")).to.equal(0);
      expect(validateInteger(42)).to.equal(42);
    });

    it("should return fallback for NaN", () => {
      expect(validateInteger("abc")).to.equal(0);
      expect(validateInteger("abc", 5)).to.equal(5);
    });

    it("should return fallback for undefined", () => {
      expect(validateInteger(undefined)).to.equal(0);
    });

    it("should return fallback for null", () => {
      expect(validateInteger(null)).to.equal(0);
    });

    it("should truncate floating point strings", () => {
      expect(validateInteger("10.5")).to.equal(10);
    });

    it("should reject SQL injection in offset", () => {
      // "10; DROP TABLE users" -> parseInt returns 10
      expect(validateInteger("10; DROP TABLE users")).to.equal(10);
    });
  });

  describe("SQL injection protection", () => {
    it("should block field injection via semicolons", () => {
      expect(() => validateFieldName("name; DROP TABLE users--")).to.throw();
    });

    it("should block subquery injection in field names", () => {
      expect(() =>
        validateFieldName("(SELECT password FROM users)")
      ).to.throw();
    });

    it("should block UNION injection in field names", () => {
      expect(() =>
        validateFieldName("name UNION SELECT password FROM users")
      ).to.throw();
    });

    it("should escape objectId quote injection attempts", () => {
      const result = escapeSqlString("'; DROP TABLE x--");
      expect(result).to.equal("''; DROP TABLE x--");
      // When used in SQL: '''' DROP TABLE x--' — broken syntax, not executable
    });

    it("should block DDL in WHERE clauses", () => {
      expect(() =>
        checkWhereClauseSafety("DROP TABLE sensitive_data")
      ).to.throw();
    });

    it("should block comment-based injection in identifiers", () => {
      expect(() => validateIdentifier("col/**/")).to.throw();
    });
  });
});
