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

// Configurable lakebase pool stub for edit/read tests
let lakebaseQueryResult = { rows: [] };
let lakebaseQueryLog = [];
const lakebasePoolStub = {
  getLakebasePool: () => ({
    query: async (sql, params) => {
      lakebaseQueryLog.push({ sql, params });
      // Support rowCount for UPDATE/DELETE verification
      const result = { ...lakebaseQueryResult };
      if (result.rowCount === undefined) {
        // Default: assume all rows affected (for backward compat with existing tests)
        result.rowCount = result.rows ? result.rows.length : 0;
      }
      return result;
    },
  }),
  shutdownLakebasePools: async () => {},
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
    process.env.LAKEBASE_PASSWORD = "test-lakebase-password";
    process.env.ENABLE_AUDIT_LOG = "false";
    process.env.ENABLE_USER_AUTH = "false";
    process.env.ENABLE_SIMPLE_AUTH = "false";

    Model = proxyquire("../src/model", {
      "./modules/connectionPool": connectionPoolStub,
      "./modules/lakebasePool": lakebasePoolStub,
      dotenv: dotenvStub,
    });
  });

  beforeEach(() => {
    lakebaseQueryResult = { rows: [] };
    lakebaseQueryLog = [];
  });

  after(() => {
    delete process.env.DATABRICKS_SERVER_HOSTNAME;
    delete process.env.DATABRICKS_HTTP_PATH;
    delete process.env.DATABRICKS_ACCESS_TOKEN;
    delete process.env.LAKEBASE_PASSWORD;
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

    it("should set editable to false for all fields by default", () => {
      const rows = [{ OBJECTID: 1, name: "Test", geometry: "{}" }];
      const fields = model.extractFields(rows, "geometry", "OBJECTID");
      fields.forEach((f) => expect(f.editable).to.be.false);
    });

    it("should set editable to true for non-id fields when isEditable is true", () => {
      const rows = [{ OBJECTID: 1, name: "Test", height: 50, geometry: "{}" }];
      const fields = model.extractFields(rows, "geometry", "OBJECTID", true);
      const idField = fields.find((f) => f.name === "OBJECTID");
      const nameField = fields.find((f) => f.name === "name");
      const heightField = fields.find((f) => f.name === "height");
      expect(idField.editable).to.be.false; // ID never editable
      expect(nameField.editable).to.be.true;
      expect(heightField.editable).to.be.true;
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

  describe("getDataFromLakebase", () => {
    it("should route to Lakebase when lakebaseHost is set", (done) => {
      lakebaseQueryResult = {
        rows: [
          { id: 1, name: "Tower A", geometry: '{"type":"Point","coordinates":[-77,38]}' },
        ],
      };

      const model = new Model();
      const req = {
        query: { f: "json" },
        params: {
          lakebaseHost: "lakebase.example.com",
          lakebasePort: "5432",
          lakebaseDatabase: "testdb",
          lakebaseSchema: "public",
          lakebaseTable: "cell_towers",
          geometryColumn: "geometry",
          idField: "id",
        },
        ip: "127.0.0.1",
      };

      model.getData(req, (err, result) => {
        expect(err).to.be.null;
        expect(result.type).to.equal("FeatureCollection");
        expect(result.features).to.have.lengthOf(1);
        expect(result.features[0].properties.id).to.equal(1);
        expect(result.metadata).to.exist;
        expect(result.metadata.idField).to.equal("id");
        expect(result.crs.type).to.equal("EPSG:4326");
        // Lakebase services should have editable fields
        const nameField = result.metadata.fields.find((f) => f.name === "name");
        const idFieldDef = result.metadata.fields.find((f) => f.name === "id");
        expect(nameField.editable).to.be.true;
        expect(idFieldDef.editable).to.be.false; // ID never editable
        done();
      });
    });

    it("should return empty FeatureCollection for no results", (done) => {
      lakebaseQueryResult = { rows: [] };

      const model = new Model();
      const req = {
        query: {},
        params: {
          lakebaseHost: "lakebase.example.com",
          lakebaseDatabase: "testdb",
          lakebaseTable: "cell_towers",
        },
        ip: "127.0.0.1",
      };

      model.getData(req, (err, result) => {
        expect(err).to.be.null;
        expect(result.type).to.equal("FeatureCollection");
        expect(result.features).to.have.lengthOf(0);
        done();
      });
    });

    it("should handle returnCountOnly from Lakebase", (done) => {
      lakebaseQueryResult = { rows: [{ count: 42 }] };

      const model = new Model();
      const req = {
        query: { returnCountOnly: "true" },
        params: {
          lakebaseHost: "lakebase.example.com",
          lakebaseDatabase: "testdb",
          lakebaseTable: "cell_towers",
        },
        ip: "127.0.0.1",
      };

      model.getData(req, (err, result) => {
        expect(err).to.be.null;
        expect(result.count).to.equal(42);
        done();
      });
    });

    it("should fail when lakebaseTable is missing", (done) => {
      const model = new Model();
      const req = {
        query: {},
        params: {
          lakebaseHost: "lakebase.example.com",
          lakebaseDatabase: "testdb",
          // lakebaseTable missing
        },
        ip: "127.0.0.1",
      };

      model.getData(req, (err) => {
        expect(err).to.be.an("error");
        expect(err.message).to.include("lakebaseTable");
        done();
      });
    });

    it("should reject invalid geometryColumn for Lakebase path", (done) => {
      const model = new Model();
      const req = {
        query: {},
        params: {
          lakebaseHost: "lakebase.example.com",
          lakebaseDatabase: "testdb",
          lakebaseTable: "cell_towers",
          geometryColumn: "geom; DROP TABLE--",
        },
        ip: "127.0.0.1",
      };

      model.getData(req, (err) => {
        expect(err).to.be.an("error");
        expect(err.message).to.include("Invalid identifier");
        done();
      });
    });
  });

  describe("editData", () => {
    it("should process adds and return objectIds", (done) => {
      lakebaseQueryResult = { rows: [{ id: 100 }] };

      const model = new Model();
      const req = {
        params: {
          lakebaseHost: "lakebase.example.com",
          lakebaseDatabase: "testdb",
          lakebaseTable: "cell_towers",
          lakebaseSchema: "public",
          geometryColumn: "geometry",
          idField: "id",
        },
        ip: "127.0.0.1",
      };

      const data = {
        adds: [
          {
            attributes: { name: "New Tower", height: 50 },
            geometry: { x: -77.0, y: 38.9 },
          },
        ],
      };

      model.editData(req, data, (err, result) => {
        expect(err).to.be.null;
        expect(result.addResults).to.have.lengthOf(1);
        expect(result.addResults[0].success).to.be.true;
        expect(result.addResults[0].objectId).to.equal(100);
        expect(lakebaseQueryLog).to.have.lengthOf(1);
        expect(lakebaseQueryLog[0].sql).to.include("INSERT INTO");
        expect(lakebaseQueryLog[0].sql).to.include("RETURNING id");
        done();
      });
    });

    it("should process updates", (done) => {
      lakebaseQueryResult = { rows: [], rowCount: 1 };

      const model = new Model();
      const req = {
        params: {
          lakebaseHost: "lakebase.example.com",
          lakebaseDatabase: "testdb",
          lakebaseTable: "cell_towers",
          lakebaseSchema: "public",
          geometryColumn: "geometry",
          idField: "id",
        },
        ip: "127.0.0.1",
      };

      const data = {
        updates: [
          {
            attributes: { id: 42, name: "Updated Tower" },
            geometry: { x: -78.0, y: 39.0 },
          },
        ],
      };

      model.editData(req, data, (err, result) => {
        expect(err).to.be.null;
        expect(result.updateResults).to.have.lengthOf(1);
        expect(result.updateResults[0].success).to.be.true;
        expect(result.updateResults[0].objectId).to.equal(42);
        expect(lakebaseQueryLog[0].sql).to.include("UPDATE");
        done();
      });
    });

    it("should process deletes", (done) => {
      lakebaseQueryResult = { rows: [], rowCount: 3 };

      const model = new Model();
      const req = {
        params: {
          lakebaseHost: "lakebase.example.com",
          lakebaseDatabase: "testdb",
          lakebaseTable: "cell_towers",
          lakebaseSchema: "public",
          geometryColumn: "geometry",
          idField: "id",
        },
        ip: "127.0.0.1",
      };

      const data = {
        deletes: [1, 2, 3],
      };

      model.editData(req, data, (err, result) => {
        expect(err).to.be.null;
        expect(result.deleteResults).to.have.lengthOf(3);
        result.deleteResults.forEach((r) => expect(r.success).to.be.true);
        expect(lakebaseQueryLog[0].sql).to.include("DELETE FROM");
        expect(lakebaseQueryLog[0].sql).to.include("IN ($1, $2, $3)");
        done();
      });
    });

    it("should process mixed adds, updates, and deletes", (done) => {
      // INSERT returns new ID + rowCount=1, UPDATE returns rowCount=1, DELETE returns rowCount=1
      lakebaseQueryResult = { rows: [{ id: 200 }], rowCount: 1 };

      const model = new Model();
      const req = {
        params: {
          lakebaseHost: "lakebase.example.com",
          lakebaseDatabase: "testdb",
          lakebaseTable: "cell_towers",
          lakebaseSchema: "public",
          geometryColumn: "geometry",
          idField: "id",
        },
        ip: "127.0.0.1",
      };

      const data = {
        adds: [{ attributes: { name: "New" }, geometry: { x: -77, y: 38 } }],
        updates: [{ attributes: { id: 10, name: "Up" } }],
        deletes: [5],
      };

      model.editData(req, data, (err, result) => {
        expect(err).to.be.null;
        expect(result.addResults).to.have.lengthOf(1);
        expect(result.updateResults).to.have.lengthOf(1);
        expect(result.deleteResults).to.have.lengthOf(1);
        expect(result.addResults[0].success).to.be.true;
        expect(result.updateResults[0].success).to.be.true;
        expect(result.deleteResults[0].success).to.be.true;
        // 3 queries total: INSERT, UPDATE, DELETE
        expect(lakebaseQueryLog).to.have.lengthOf(3);
        done();
      });
    });

    it("should fail when lakebaseHost is missing", (done) => {
      const model = new Model();
      const req = {
        params: {
          lakebaseTable: "cell_towers",
          geometryColumn: "geometry",
          idField: "id",
        },
        ip: "127.0.0.1",
      };

      model.editData(req, { adds: [] }, (err) => {
        expect(err).to.be.an("error");
        expect(err.message).to.include("lakebaseHost");
        done();
      });
    });

    it("should fail when lakebaseTable is missing", (done) => {
      const model = new Model();
      const req = {
        params: {
          lakebaseHost: "lakebase.example.com",
          lakebaseDatabase: "testdb",
          geometryColumn: "geometry",
          idField: "id",
        },
        ip: "127.0.0.1",
      };

      model.editData(req, { adds: [] }, (err) => {
        expect(err).to.be.an("error");
        expect(err.message).to.include("lakebaseTable");
        done();
      });
    });

    it("should reject invalid identifiers in edit params", (done) => {
      const model = new Model();
      const req = {
        params: {
          lakebaseHost: "lakebase.example.com",
          lakebaseDatabase: "testdb",
          lakebaseTable: "cell_towers",
          geometryColumn: "geom; DROP TABLE--",
          idField: "id",
        },
        ip: "127.0.0.1",
      };

      model.editData(req, { adds: [] }, (err) => {
        expect(err).to.be.an("error");
        expect(err.message).to.include("Invalid identifier");
        done();
      });
    });

    it("should report failure when update targets non-existent ID", (done) => {
      lakebaseQueryResult = { rows: [], rowCount: 0 };

      const model = new Model();
      const req = {
        params: {
          lakebaseHost: "lakebase.example.com",
          lakebaseDatabase: "testdb",
          lakebaseTable: "cell_towers",
          lakebaseSchema: "public",
          geometryColumn: "geometry",
          idField: "id",
        },
        ip: "127.0.0.1",
      };

      const data = {
        updates: [
          { attributes: { id: 999999, name: "Ghost Tower" } },
        ],
      };

      model.editData(req, data, (err, result) => {
        expect(err).to.be.null;
        expect(result.updateResults).to.have.lengthOf(1);
        expect(result.updateResults[0].success).to.be.false;
        expect(result.updateResults[0].objectId).to.equal(999999);
        expect(result.updateResults[0].error.description).to.include("not found");
        done();
      });
    });

    it("should return empty results when no edits are provided", (done) => {
      const model = new Model();
      const req = {
        params: {
          lakebaseHost: "lakebase.example.com",
          lakebaseDatabase: "testdb",
          lakebaseTable: "cell_towers",
          lakebaseSchema: "public",
          geometryColumn: "geometry",
          idField: "id",
        },
        ip: "127.0.0.1",
      };

      model.editData(req, {}, (err, result) => {
        expect(err).to.be.null;
        expect(result.addResults).to.have.lengthOf(0);
        expect(result.updateResults).to.have.lengthOf(0);
        expect(result.deleteResults).to.have.lengthOf(0);
        done();
      });
    });
  });
});
