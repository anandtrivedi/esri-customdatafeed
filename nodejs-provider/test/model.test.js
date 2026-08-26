const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();

// Stub connectionPool to avoid real Databricks connections.
// New signature: getPool(workspaceConfig, httpPath, options) — args ignored by the stub.
// Configurable: set lakehouseQueryRows for results, lakehouseExecuteError to make
// executeStatement throw; lakehouseReleaseLog records release(conn, opts) calls.
let lakehouseQueryRows = [];
let lakehouseExecuteError = null;
let lakehouseReleaseLog = [];
const connectionPoolStub = {
  getPool: () => ({
    poolLabel: () => "test-pool",
    acquire: async () => ({
      id: "test-conn",
      session: {
        executeStatement: async (sql) => {
          if (lakehouseExecuteError) throw lakehouseExecuteError;
          return {
            // DESCRIBE TABLE probe (geometry format detection) gets no rows
            fetchAll: async () => (/^\s*DESCRIBE/i.test(sql) ? [] : lakehouseQueryRows),
            close: async () => {},
          };
        },
      },
    }),
    release: (conn, opts) => {
      lakehouseReleaseLog.push(opts || {});
    },
  }),
  shutdownPool: async () => {},
  getAllPoolStats: () => [],
};

// Stub workspaceResolver so tests don't depend on .databrickscfg or env-var nuances
const workspaceResolverStub = {
  resolveWorkspace: (alias) => ({
    workspaceAlias: alias || "default",
    hostname: "test-host.databricks.com",
    authType: "pat",
    token: "test-token",
  }),
  clearProfileCache: () => {},
};

// Configurable lakebase pool stub for edit/read tests
// Set to an object for a single result, or an array for a queue of results
let lakebaseQueryResult = { rows: [] };
let lakebaseQueryLog = [];
const queryFn = async (sql, params) => {
  lakebaseQueryLog.push({ sql, params });
  let raw;
  if (Array.isArray(lakebaseQueryResult)) {
    raw = lakebaseQueryResult.shift() || { rows: [] };
  } else {
    raw = lakebaseQueryResult;
  }
  const result = { ...raw };
  if (result.rowCount === undefined) {
    result.rowCount = result.rows ? result.rows.length : 0;
  }
  return result;
};
const lakebasePoolStub = {
  getLakebasePool: async () => ({
    query: queryFn,
    // pool.connect() returns a client with query/release for transactions
    connect: async () => ({
      query: queryFn,
      release: () => {},
    }),
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
      "./modules/workspaceResolver": workspaceResolverStub,
      dotenv: dotenvStub,
    });
  });

  beforeEach(() => {
    lakebaseQueryResult = { rows: [] };
    lakebaseQueryLog = [];
    lakehouseQueryRows = [];
    lakehouseExecuteError = null;
    lakehouseReleaseLog = [];
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
    it("should allow all requests when auth is disabled", async () => {
      const model = new Model();
      const req = { ip: "127.0.0.1", headers: {} };
      // async authorize() returns (no throw) to allow
      await model.authorize(req);
    });

    it("should reject missing token when simple auth is enabled", async () => {
      process.env.ENABLE_SIMPLE_AUTH = "true";
      process.env.SIMPLE_AUTH_TOKEN = "secret123";

      const model = new Model();
      const req = { ip: "127.0.0.1", headers: {} };
      try {
        await model.authorize(req);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).to.be.an("error");
        expect(err.message).to.include("Authorization required");
      } finally {
        process.env.ENABLE_SIMPLE_AUTH = "false";
        delete process.env.SIMPLE_AUTH_TOKEN;
      }
    });

    it("should reject invalid token when simple auth is enabled", async () => {
      process.env.ENABLE_SIMPLE_AUTH = "true";
      process.env.SIMPLE_AUTH_TOKEN = "secret123";

      const model = new Model();
      const req = {
        ip: "127.0.0.1",
        headers: { authorization: "Bearer wrong-token" },
      };
      try {
        await model.authorize(req);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).to.be.an("error");
        expect(err.message).to.include("Invalid authentication token");
      } finally {
        process.env.ENABLE_SIMPLE_AUTH = "false";
        delete process.env.SIMPLE_AUTH_TOKEN;
      }
    });

    it("should accept valid token when simple auth is enabled", async () => {
      process.env.ENABLE_SIMPLE_AUTH = "true";
      process.env.SIMPLE_AUTH_TOKEN = "secret123";

      const model = new Model();
      const req = {
        ip: "127.0.0.1",
        headers: { authorization: "Bearer secret123" },
      };
      await model.authorize(req);

      process.env.ENABLE_SIMPLE_AUTH = "false";
      delete process.env.SIMPLE_AUTH_TOKEN;
    });

    it("should allow authenticated ArcGIS user when user auth is enabled", async () => {
      process.env.ENABLE_USER_AUTH = "true";

      const model = new Model();
      const req = {
        ip: "127.0.0.1",
        headers: {},
        _user: { username: "analyst1", groups: ["GIS_Analysts"] },
      };
      await model.authorize(req);

      process.env.ENABLE_USER_AUTH = "false";
    });

    it("should reject unauthenticated user when user auth is enabled", async () => {
      process.env.ENABLE_USER_AUTH = "true";

      const model = new Model();
      const req = { ip: "127.0.0.1", headers: {} };
      try {
        await model.authorize(req);
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).to.be.an("error");
        expect(err.message).to.include("User authentication required");
      } finally {
        process.env.ENABLE_USER_AUTH = "false";
      }
    });

    // 11.4 callback compatibility tests
    it("should work with callback pattern (11.4 compat)", (done) => {
      const model = new Model();
      const req = { ip: "127.0.0.1", headers: {} };
      model.authorize(req, (err, authorized) => {
        expect(err).to.be.null;
        expect(authorized).to.be.true;
        done();
      });
    });

    it("should pass error to callback on rejection (11.4 compat)", (done) => {
      process.env.ENABLE_SIMPLE_AUTH = "true";
      process.env.SIMPLE_AUTH_TOKEN = "secret123";

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

    it("should return LineString type", () => {
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

  describe("pagination / exceededTransferLimit", () => {
    // SQL fetches resultRecordCount + 1 rows; the provider must pop the extra
    // row and set exceededTransferLimit by comparing against the REQUESTED page
    // size, not maxRecordCount. (Regression test for double-pagination bug.)
    const makeRows = (n) =>
      Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        name: `feature ${i + 1}`,
        geometry: '{"type":"Point","coordinates":[-77,38]}',
      }));

    const lakehouseReq = (query) => ({
      query,
      params: {
        tableName: "catalog.schema.towers",
        geometryColumn: "geometry",
        idField: "id",
        geometryFormat: "GEOMETRY",
      },
      ip: "127.0.0.1",
    });

    const lakebaseReq = (query) => ({
      query,
      params: {
        lakebaseHost: "lakebase.example.com",
        lakebaseDatabase: "testdb",
        lakebaseTable: "cell_towers",
        geometryColumn: "geometry",
        idField: "id",
      },
      ip: "127.0.0.1",
    });

    it("Lakehouse: pops extra row and sets exceededTransferLimit when resultRecordCount < maxRecordCount", (done) => {
      lakehouseQueryRows = makeRows(6); // LIMIT was fetchSize + 1 = 6
      const model = new Model();
      model.getData(lakehouseReq({ f: "json", resultRecordCount: "5" }), (err, result) => {
        expect(err).to.be.null;
        expect(result.features).to.have.lengthOf(5);
        expect(result.metadata.exceededTransferLimit).to.be.true;
        done();
      });
    });

    it("Lakehouse: no pop and exceededTransferLimit false when fewer rows than requested", (done) => {
      lakehouseQueryRows = makeRows(3);
      const model = new Model();
      model.getData(lakehouseReq({ f: "json", resultRecordCount: "5" }), (err, result) => {
        expect(err).to.be.null;
        expect(result.features).to.have.lengthOf(3);
        expect(result.metadata.exceededTransferLimit).to.be.false;
        done();
      });
    });

    it("Lakehouse: declares resultRecordCount/resultOffset in filtersApplied", (done) => {
      lakehouseQueryRows = makeRows(2);
      const model = new Model();
      model.getData(
        lakehouseReq({ f: "json", resultRecordCount: "5", resultOffset: "5" }),
        (err, result) => {
          expect(err).to.be.null;
          expect(result.filtersApplied.resultRecordCount).to.be.true;
          expect(result.filtersApplied.resultOffset).to.be.true;
          expect(result.filtersApplied.limit).to.be.true;
          expect(result.filtersApplied.offset).to.be.true;
          done();
        }
      );
    });

    it("Lakebase: pops extra row and sets exceededTransferLimit when resultRecordCount < maxRecordCount", (done) => {
      lakebaseQueryResult = { rows: makeRows(6) };
      const model = new Model();
      model.getData(lakebaseReq({ f: "json", resultRecordCount: "5" }), (err, result) => {
        expect(err).to.be.null;
        expect(result.features).to.have.lengthOf(5);
        expect(result.metadata.exceededTransferLimit).to.be.true;
        done();
      });
    });

    it("Lakebase: no pop and exceededTransferLimit false when fewer rows than requested", (done) => {
      lakebaseQueryResult = { rows: makeRows(3) };
      const model = new Model();
      model.getData(lakebaseReq({ f: "json", resultRecordCount: "5" }), (err, result) => {
        expect(err).to.be.null;
        expect(result.features).to.have.lengthOf(3);
        expect(result.metadata.exceededTransferLimit).to.be.false;
        done();
      });
    });
  });

  describe("connection release on error", () => {
    it("destroys the connection when the query fails", (done) => {
      lakehouseExecuteError = new Error("session expired");
      const model = new Model();
      const req = {
        query: { f: "json", resultRecordCount: "5" },
        params: { tableName: "catalog.schema.towers", geometryFormat: "GEOMETRY" },
        ip: "127.0.0.1",
      };
      model.getData(req, (err) => {
        expect(err).to.be.an("error");
        // release() runs in the finally block after the callback — defer the assert
        setImmediate(() => {
          expect(lakehouseReleaseLog).to.have.lengthOf(1);
          expect(lakehouseReleaseLog[0].destroy).to.be.true;
          done();
        });
      });
    });

    it("releases the connection normally when the query succeeds", (done) => {
      lakehouseQueryRows = [
        { id: 1, geometry: '{"type":"Point","coordinates":[-77,38]}' },
      ];
      const model = new Model();
      const req = {
        query: { f: "json", resultRecordCount: "5" },
        params: { tableName: "catalog.schema.towers", geometryFormat: "GEOMETRY" },
        ip: "127.0.0.1",
      };
      model.getData(req, (err) => {
        expect(err).to.be.null;
        setImmediate(() => {
          expect(lakehouseReleaseLog).to.have.lengthOf(1);
          expect(lakehouseReleaseLog[0].destroy).to.be.false;
          done();
        });
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
        // Lakebase metadata should include editing templates
        expect(result.metadata.templates).to.be.an("array").with.lengthOf(1);
        expect(result.metadata.templates[0].name).to.equal("New Feature");
        expect(result.metadata.templates[0].drawingTool).to.equal("esriFeatureEditToolPoint");
        expect(result.metadata.templates[0].prototype.attributes).to.have.property("name");
        expect(result.metadata.templates[0].prototype.attributes).to.not.have.property("id");
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

    it("should fail when lakebaseDatabase is missing", (done) => {
      const model = new Model();
      const req = {
        query: {},
        params: {
          lakebaseHost: "lakebase.example.com",
          lakebaseTable: "cell_towers",
          // lakebaseDatabase missing
        },
        ip: "127.0.0.1",
      };

      model.getData(req, (err) => {
        expect(err).to.be.an("error");
        expect(err.message).to.include("lakebaseDatabase");
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

  describe("getMetadata", () => {
    it("should return idField and inputCrs", async () => {
      const model = new Model();
      const metadata = await model.getMetadata();
      expect(metadata).to.have.property("idField");
      expect(metadata).to.have.property("inputCrs");
      expect(metadata.idField).to.be.a("string");
      expect(metadata.inputCrs).to.be.a("number");
    });

    it("should return default idField of 'id'", async () => {
      const model = new Model();
      const metadata = await model.getMetadata();
      expect(metadata.idField).to.equal("id");
    });

    it("should return default inputCrs of 4326", async () => {
      const model = new Model();
      const metadata = await model.getMetadata();
      expect(metadata.inputCrs).to.equal(4326);
    });

    it("should use the per-service idField from req.params", async () => {
      const model = new Model();
      const metadata = await model.getMetadata({ params: { idField: "OBJECTID" } });
      expect(metadata.idField).to.equal("OBJECTID");
    });

    it("should use the per-service srid from req.params as inputCrs", async () => {
      const model = new Model();
      const metadata = await model.getMetadata({ params: { srid: "3857" } });
      expect(metadata.inputCrs).to.equal(3857);
    });
  });

  describe("editData", () => {
    it("should process adds and return objectIds", async () => {
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

      const result = await model.editData(req, data);
      expect(result.addResults).to.have.lengthOf(1);
      expect(result.addResults[0].success).to.be.true;
      expect(result.addResults[0].objectId).to.equal(100);
      expect(lakebaseQueryLog).to.have.lengthOf(1);
      expect(lakebaseQueryLog[0].sql).to.include("INSERT INTO");
      expect(lakebaseQueryLog[0].sql).to.include("RETURNING id");
    });

    it("should process updates", async () => {
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

      const result = await model.editData(req, data);
      expect(result.updateResults).to.have.lengthOf(1);
      expect(result.updateResults[0].success).to.be.true;
      expect(result.updateResults[0].objectId).to.equal(42);
      expect(lakebaseQueryLog[0].sql).to.include("UPDATE");
    });

    it("should process deletes", async () => {
      lakebaseQueryResult = { rows: [{ id: 1 }, { id: 2 }, { id: 3 }], rowCount: 3 };

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

      const result = await model.editData(req, data);
      expect(result.deleteResults).to.have.lengthOf(3);
      result.deleteResults.forEach((r) => expect(r.success).to.be.true);
      expect(lakebaseQueryLog[0].sql).to.include("DELETE FROM");
      expect(lakebaseQueryLog[0].sql).to.include("IN ($1, $2, $3)");
    });

    it("should process mixed adds, updates, and deletes", async () => {
      // Queue: INSERT returns new ID, UPDATE returns rowCount=1, DELETE returns deleted row
      lakebaseQueryResult = [
        { rows: [{ id: 200 }], rowCount: 1 },   // INSERT RETURNING
        { rows: [], rowCount: 1 },               // UPDATE
        { rows: [{ id: 5 }], rowCount: 1 },      // DELETE RETURNING
      ];

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

      const result = await model.editData(req, data);
      expect(result.addResults).to.have.lengthOf(1);
      expect(result.updateResults).to.have.lengthOf(1);
      expect(result.deleteResults).to.have.lengthOf(1);
      expect(result.addResults[0].success).to.be.true;
      expect(result.updateResults[0].success).to.be.true;
      expect(result.deleteResults[0].success).to.be.true;
      // 3 queries total: INSERT, UPDATE, DELETE
      expect(lakebaseQueryLog).to.have.lengthOf(3);
    });

    it("should fail when lakebaseHost is missing", async () => {
      const model = new Model();
      const req = {
        params: {
          lakebaseTable: "cell_towers",
          geometryColumn: "geometry",
          idField: "id",
        },
        ip: "127.0.0.1",
      };

      try {
        await model.editData(req, { adds: [] });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).to.be.an("error");
        expect(err.message).to.include("lakebaseHost");
      }
    });

    it("should fail when lakebaseTable is missing", async () => {
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

      try {
        await model.editData(req, { adds: [] });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).to.be.an("error");
        expect(err.message).to.include("lakebaseTable");
      }
    });

    it("should fail when lakebaseDatabase is missing", async () => {
      const model = new Model();
      const req = {
        params: {
          lakebaseHost: "lakebase.example.com",
          lakebaseTable: "cell_towers",
          geometryColumn: "geometry",
          idField: "id",
        },
        ip: "127.0.0.1",
      };

      try {
        await model.editData(req, { adds: [] });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).to.be.an("error");
        expect(err.message).to.include("lakebaseDatabase");
      }
    });

    it("should reject invalid identifiers in edit params", async () => {
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

      try {
        await model.editData(req, { adds: [] });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).to.be.an("error");
        expect(err.message).to.include("Invalid identifier");
      }
    });

    it("should report failure when update targets non-existent ID", async () => {
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

      const result = await model.editData(req, data);
      expect(result.updateResults).to.have.lengthOf(1);
      expect(result.updateResults[0].success).to.be.false;
      expect(result.updateResults[0].objectId).to.equal(999999);
      expect(result.updateResults[0].error.code).to.equal(1019);
      expect(result.updateResults[0].error.description).to.include("not found");
    });

    it("should report per-row delete failures for non-existent IDs", async () => {
      // DELETE RETURNING only returns id=1, so id=999 was not found
      lakebaseQueryResult = { rows: [{ id: 1 }], rowCount: 1 };

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

      const result = await model.editData(req, { deletes: [1, 999] });
      expect(result.deleteResults).to.have.lengthOf(2);
      expect(result.deleteResults[0]).to.deep.include({ objectId: 1, success: true });
      expect(result.deleteResults[1].success).to.be.false;
      expect(result.deleteResults[1].objectId).to.equal(999);
      expect(result.deleteResults[1].error.code).to.equal(1018);
    });

    it("should rollback all operations when rollbackOnFailure is true and one fails", async () => {
      // Queue: BEGIN, INSERT succeeds, UPDATE fails (not found), ROLLBACK
      lakebaseQueryResult = [
        { rows: [] },                            // BEGIN
        { rows: [{ id: 300 }], rowCount: 1 },   // INSERT succeeds
        { rows: [], rowCount: 0 },               // UPDATE fails (not found)
        { rows: [] },                            // ROLLBACK
      ];

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
        rollbackOnFailure: true,
        adds: [{ attributes: { name: "New" }, geometry: { x: -77, y: 38 } }],
        updates: [{ attributes: { id: 999, name: "Ghost" } }],
      };

      const result = await model.editData(req, data);
      // Both should be marked as failed due to rollback
      expect(result.addResults[0].success).to.be.false;
      expect(result.addResults[0].error.code).to.equal(1003);
      expect(result.updateResults[0].success).to.be.false;
      expect(result.updateResults[0].error.code).to.equal(1003);
      // Should have BEGIN and ROLLBACK in the query log
      const sqls = lakebaseQueryLog.map(q => q.sql);
      expect(sqls[0]).to.equal("BEGIN");
      expect(sqls[sqls.length - 1]).to.equal("ROLLBACK");
    });

    it("should commit when rollbackOnFailure is true and all succeed", async () => {
      lakebaseQueryResult = [
        { rows: [] },                           // BEGIN
        { rows: [{ id: 400 }], rowCount: 1 },   // INSERT succeeds
        { rows: [] },                           // COMMIT
      ];

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
        rollbackOnFailure: true,
        adds: [{ attributes: { name: "New" }, geometry: { x: -77, y: 38 } }],
      };

      const result = await model.editData(req, data);
      expect(result.addResults[0].success).to.be.true;
      const sqls = lakebaseQueryLog.map(q => q.sql);
      expect(sqls[0]).to.equal("BEGIN");
      expect(sqls[sqls.length - 1]).to.equal("COMMIT");
    });

    it("should process adds via async/await", async () => {
      lakebaseQueryResult = { rows: [{ id: 500 }] };

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
        adds: [{ attributes: { name: "Async Tower" }, geometry: { x: -77, y: 38 } }],
      };

      const result = await model.editData(req, data);
      expect(result.addResults).to.have.lengthOf(1);
      expect(result.addResults[0].success).to.be.true;
      expect(result.addResults[0].objectId).to.equal(500);
    });

    it("should throw on error", async () => {
      const model = new Model();
      const req = {
        params: {
          // Missing lakebaseHost — should throw
          lakebaseTable: "cell_towers",
          geometryColumn: "geometry",
          idField: "id",
        },
        ip: "127.0.0.1",
      };

      try {
        await model.editData(req, { adds: [] });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err.message).to.include("lakebaseHost");
      }
    });

    it("should return empty results when no edits are provided", async () => {
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

      const result = await model.editData(req, {});
      expect(result.addResults).to.have.lengthOf(0);
      expect(result.updateResults).to.have.lengthOf(0);
      expect(result.deleteResults).to.have.lengthOf(0);
    });

    // 11.4 callback compatibility tests
    it("should work with callback pattern (11.4 compat)", (done) => {
      lakebaseQueryResult = { rows: [{ id: 600 }] };

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

      model.editData(req, {
        adds: [{ attributes: { name: "CB Tower" }, geometry: { x: -77, y: 38 } }],
      }, (err, result) => {
        expect(err).to.be.null;
        expect(result.addResults).to.have.lengthOf(1);
        expect(result.addResults[0].success).to.be.true;
        expect(result.addResults[0].objectId).to.equal(600);
        done();
      });
    });

    it("should pass error to callback on failure (11.4 compat)", (done) => {
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
  });
});
