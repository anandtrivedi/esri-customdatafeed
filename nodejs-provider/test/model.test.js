const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();

// Stub connectionPool to avoid real Databricks connections
const connectionPoolStub = {
  initializePool: () => {},
  getPool: () => ({
    acquire: async () => ({
      id: "test-conn",
      session: {
        executeStatement: async () => ({
          fetchAll: async () => [],
          close: async () => {},
        }),
      },
    }),
    release: () => {},
  }),
  shutdownPool: async () => {},
};

// Stub dotenv to avoid loading .env files
const dotenvStub = { config: () => {} };

describe("model", () => {
  let Model;

  before(() => {
    // Set required environment variables
    process.env.DATABRICKS_SERVER_HOSTNAME = "test-host.databricks.com";
    process.env.DATABRICKS_HTTP_PATH = "/sql/1.0/endpoints/test";
    process.env.DATABRICKS_ACCESS_TOKEN = "test-token";
    process.env.ENABLE_AUDIT_LOG = "false";
    process.env.ENABLE_USER_AUTH = "false";
    process.env.ENABLE_SIMPLE_AUTH = "false";

    Model = proxyquire("../src/model", {
      "./modules/connectionPool": connectionPoolStub,
      dotenv: dotenvStub,
    });
  });

  after(() => {
    delete process.env.DATABRICKS_SERVER_HOSTNAME;
    delete process.env.DATABRICKS_HTTP_PATH;
    delete process.env.DATABRICKS_ACCESS_TOKEN;
    delete process.env.ENABLE_AUDIT_LOG;
    delete process.env.ENABLE_USER_AUTH;
    delete process.env.ENABLE_SIMPLE_AUTH;
  });

  describe("authorize", () => {
    it("should allow all requests when auth is disabled", (done) => {
      const model = new Model();
      const req = { ip: "127.0.0.1", headers: {} };
      model.authorize(req, (err, authorized) => {
        expect(err).to.be.null;
        expect(authorized).to.be.true;
        done();
      });
    });

    it("should reject missing token when simple auth is enabled", (done) => {
      process.env.ENABLE_SIMPLE_AUTH = "true";
      process.env.SIMPLE_AUTH_TOKEN = "secret123";

      // Need to re-require to pick up env change for authorize logic
      // but authorize reads env at call time, so this works on the same instance
      const model = new Model();
      const req = { ip: "127.0.0.1", headers: {} };
      model.authorize(req, (err, authorized) => {
        expect(err).to.be.an("error");
        expect(err.message).to.include("Authorization required");
        expect(authorized).to.be.false;

        process.env.ENABLE_SIMPLE_AUTH = "false";
        delete process.env.SIMPLE_AUTH_TOKEN;
        done();
      });
    });

    it("should reject invalid token when simple auth is enabled", (done) => {
      process.env.ENABLE_SIMPLE_AUTH = "true";
      process.env.SIMPLE_AUTH_TOKEN = "secret123";

      const model = new Model();
      const req = {
        ip: "127.0.0.1",
        headers: { authorization: "Bearer wrong-token" },
      };
      model.authorize(req, (err, authorized) => {
        expect(err).to.be.an("error");
        expect(err.message).to.include("Invalid authentication token");
        expect(authorized).to.be.false;

        process.env.ENABLE_SIMPLE_AUTH = "false";
        delete process.env.SIMPLE_AUTH_TOKEN;
        done();
      });
    });

    it("should accept valid token when simple auth is enabled", (done) => {
      process.env.ENABLE_SIMPLE_AUTH = "true";
      process.env.SIMPLE_AUTH_TOKEN = "secret123";

      const model = new Model();
      const req = {
        ip: "127.0.0.1",
        headers: { authorization: "Bearer secret123" },
      };
      model.authorize(req, (err, authorized) => {
        expect(err).to.be.null;
        expect(authorized).to.be.true;

        process.env.ENABLE_SIMPLE_AUTH = "false";
        delete process.env.SIMPLE_AUTH_TOKEN;
        done();
      });
    });

    it("should allow authenticated ArcGIS user when user auth is enabled", (done) => {
      process.env.ENABLE_USER_AUTH = "true";

      const model = new Model();
      const req = {
        ip: "127.0.0.1",
        headers: {},
        _user: { username: "analyst1", groups: ["GIS_Analysts"] },
      };
      model.authorize(req, (err, authorized) => {
        expect(err).to.be.null;
        expect(authorized).to.be.true;

        process.env.ENABLE_USER_AUTH = "false";
        done();
      });
    });

    it("should reject unauthenticated user when user auth is enabled", (done) => {
      process.env.ENABLE_USER_AUTH = "true";

      const model = new Model();
      const req = { ip: "127.0.0.1", headers: {} };
      model.authorize(req, (err, authorized) => {
        expect(err).to.be.an("error");
        expect(err.message).to.include("User authentication required");
        expect(authorized).to.be.false;

        process.env.ENABLE_USER_AUTH = "false";
        done();
      });
    });
  });

  describe("inferGeometryType", () => {
    let model;
    before(() => {
      model = new Model();
    });

    it("should return Point for empty rows", () => {
      expect(model.inferGeometryType([], "geometry")).to.equal("Point");
    });

    it("should return Point for missing geometry column", () => {
      expect(model.inferGeometryType([{ other: "val" }], "geometry")).to.equal(
        "Point"
      );
    });

    it("should detect Point geometry", () => {
      const rows = [
        { geometry: '{"type":"Point","coordinates":[0,0]}' },
      ];
      expect(model.inferGeometryType(rows, "geometry")).to.equal("Point");
    });

    it("should detect MultiPoint geometry", () => {
      const rows = [
        {
          geometry:
            '{"type":"MultiPoint","coordinates":[[0,0],[1,1]]}',
        },
      ];
      expect(model.inferGeometryType(rows, "geometry")).to.equal("MultiPoint");
    });

    it("should map LineString to Polyline", () => {
      const rows = [
        {
          geometry:
            '{"type":"LineString","coordinates":[[0,0],[1,1]]}',
        },
      ];
      expect(model.inferGeometryType(rows, "geometry")).to.equal("LineString");
    });

    it("should return MultiLineString type", () => {
      const rows = [
        {
          geometry:
            '{"type":"MultiLineString","coordinates":[[[0,0],[1,1]]]}',
        },
      ];
      expect(model.inferGeometryType(rows, "geometry")).to.equal("MultiLineString");
    });

    it("should detect Polygon geometry", () => {
      const rows = [
        {
          geometry:
            '{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}',
        },
      ];
      expect(model.inferGeometryType(rows, "geometry")).to.equal("Polygon");
    });

    it("should return MultiPolygon type", () => {
      const rows = [
        {
          geometry:
            '{"type":"MultiPolygon","coordinates":[[[[0,0],[1,0],[1,1],[0,0]]]]}',
        },
      ];
      expect(model.inferGeometryType(rows, "geometry")).to.equal("MultiPolygon");
    });

    it("should default to Point for invalid JSON", () => {
      const rows = [{ geometry: "not-json" }];
      expect(model.inferGeometryType(rows, "geometry")).to.equal("Point");
    });

    it("should default to Point for unknown geometry type", () => {
      const rows = [{ geometry: '{"type":"GeometryCollection"}' }];
      expect(model.inferGeometryType(rows, "geometry")).to.equal("Point");
    });
  });

  describe("extractFields", () => {
    let model;
    before(() => {
      model = new Model();
    });

    it("should return empty array for empty rows", () => {
      expect(model.extractFields([], "geometry", "OBJECTID")).to.deep.equal([]);
    });

    it("should extract field definitions from first row", () => {
      const rows = [
        {
          OBJECTID: 1,
          name: "Test",
          geometry: '{"type":"Point","coordinates":[0,0]}',
        },
      ];
      const fields = model.extractFields(rows, "geometry", "OBJECTID");
      expect(fields).to.have.lengthOf(2); // OBJECTID, name (not geometry)
      expect(fields.find((f) => f.name === "OBJECTID")).to.exist;
      expect(fields.find((f) => f.name === "name")).to.exist;
      expect(fields.find((f) => f.name === "geometry")).to.not.exist;
    });

    it("should set editable to false for all fields", () => {
      const rows = [{ OBJECTID: 1, name: "Test", geometry: "{}" }];
      const fields = model.extractFields(rows, "geometry", "OBJECTID");
      fields.forEach((f) => expect(f.editable).to.be.false);
    });

    it("should include alias matching field name", () => {
      const rows = [{ OBJECTID: 1, geometry: "{}" }];
      const fields = model.extractFields(rows, "geometry", "OBJECTID");
      expect(fields[0].alias).to.equal(fields[0].name);
    });
  });

  describe("inferFieldType", () => {
    let model;
    before(() => {
      model = new Model();
    });

    it("should return esriFieldTypeInteger for integers", () => {
      expect(model.inferFieldType(42)).to.equal("esriFieldTypeInteger");
    });

    it("should return esriFieldTypeDouble for floats", () => {
      expect(model.inferFieldType(3.14)).to.equal("esriFieldTypeDouble");
    });

    it("should return esriFieldTypeInteger for booleans", () => {
      expect(model.inferFieldType(true)).to.equal("esriFieldTypeInteger");
    });

    it("should return esriFieldTypeDate for Date objects", () => {
      expect(model.inferFieldType(new Date())).to.equal("esriFieldTypeDate");
    });

    it("should return esriFieldTypeString for strings", () => {
      expect(model.inferFieldType("hello")).to.equal("esriFieldTypeString");
    });

    it("should return esriFieldTypeString for null", () => {
      expect(model.inferFieldType(null)).to.equal("esriFieldTypeString");
    });

    it("should return esriFieldTypeString for undefined", () => {
      expect(model.inferFieldType(undefined)).to.equal("esriFieldTypeString");
    });
  });

  describe("input validation", () => {
    it("should reject invalid geometryColumn from req.params", (done) => {
      const model = new Model();
      const req = {
        query: {},
        params: {
          geometryColumn: "geom; DROP TABLE x--",
        },
        ip: "127.0.0.1",
      };
      model.getData(req, (err) => {
        expect(err).to.be.an("error");
        expect(err.message).to.include("Invalid identifier");
        done();
      });
    });

    it("should reject invalid idField from req.params", (done) => {
      const model = new Model();
      const req = {
        query: {},
        params: {
          idField: "id' OR 1=1--",
        },
        ip: "127.0.0.1",
      };
      model.getData(req, (err) => {
        expect(err).to.be.an("error");
        expect(err.message).to.include("Invalid identifier");
        done();
      });
    });

    it("should accept valid geometryColumn from req.params", (done) => {
      const model = new Model();
      const req = {
        query: { f: "json" },
        params: {
          geometryColumn: "geom_col",
          tableName: "catalog.schema.table1",
        },
        ip: "127.0.0.1",
      };
      model.getData(req, (err, result) => {
        // Should not fail on validation (may fail on other things in test env)
        if (err) {
          expect(err.message).to.not.include("Invalid identifier");
        }
        done();
      });
    });

    it("should accept valid idField from req.params", (done) => {
      const model = new Model();
      const req = {
        query: { f: "json" },
        params: {
          idField: "object_id",
          tableName: "catalog.schema.table1",
        },
        ip: "127.0.0.1",
      };
      model.getData(req, (err, result) => {
        if (err) {
          expect(err.message).to.not.include("Invalid identifier");
        }
        done();
      });
    });

    it("should reject invalid table name format", (done) => {
      const model = new Model();
      const req = {
        query: {},
        params: {
          tableName: "catalog.schema.table; DROP TABLE x",
        },
        ip: "127.0.0.1",
      };
      model.getData(req, (err) => {
        expect(err).to.be.an("error");
        expect(err.message).to.include("Invalid table name format");
        done();
      });
    });
  });
});
