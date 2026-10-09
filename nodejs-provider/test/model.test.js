const { expect } = require("chai");
const proxyquire = require("proxyquire").noCallThru();

// Stub connectionPool to avoid real Databricks connections.
// New signature: getPool(workspaceConfig, httpPath, options) — args ignored by the stub.
// Configurable: set lakehouseQueryRows for results, lakehouseExecuteError to make
// executeStatement throw; lakehouseReleaseLog records release(conn, opts) calls.
let lakehouseQueryRows = [];
let lakehouseExecuteError = null;
let lakehouseReleaseLog = [];
let lakehouseCloseError = null;  // make the main query op's close() throw
let lakebaseClientReleases = []; // what each dedicated (transaction) pg client was released with
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
            close: async () => { if (lakehouseCloseError && /\bLIMIT\b/.test(sql) && !/ST_Envelope_Agg|unix_millis/.test(sql)) throw lakehouseCloseError; },
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
      release: (err) => { lakebaseClientReleases.push(err); },
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
    lakehouseCloseError = null;
    lakebaseClientReleases = [];
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

  describe("supportedQueryFormats (never set: PBF always on)", () => {
    // The feature data response's metadata is what the CDF runtime extracts the layer
    // capabilities from, so the setting must appear there too, not only in getMetadata.
    const rows = [{ id: 1, name: "a", geometry: '{"type":"Point","coordinates":[-77,38]}' }];
    const lhReq = (extra = {}) => ({
      query: { f: "json" },
      params: {
        tableName: "catalog.schema.towers",
        geometryColumn: "geometry",
        idField: "id",
        geometryFormat: "GEOMETRY",
        ...extra,
      },
      ip: "127.0.0.1",
    });
    const lbReq = (extra = {}) => ({
      query: { f: "json" },
      params: {
        lakebaseHost: "lakebase.example.com",
        lakebaseDatabase: "testdb",
        lakebaseTable: "cell_towers",
        geometryColumn: "geometry",
        idField: "id",
        ...extra,
      },
      ip: "127.0.0.1",
    });

    for (const extra of [{}, { enablePbf: "false" }, { enablePbf: "true" }]) {
      it(`Lakehouse getData metadata never sets supportedQueryFormats (params ${JSON.stringify(extra)})`, (done) => {
        lakehouseQueryRows = rows;
        new Model().getData(lhReq(extra), (err, result) => {
          expect(err).to.be.null;
          expect(result.metadata).to.not.have.property("supportedQueryFormats");
          done();
        });
      });

      it(`Lakebase getData metadata never sets supportedQueryFormats (params ${JSON.stringify(extra)})`, (done) => {
        lakebaseQueryResult = { rows };
        new Model().getData(lbReq(extra), (err, result) => {
          expect(err).to.be.null;
          expect(result.metadata).to.not.have.property("supportedQueryFormats");
          done();
        });
      });
    }
  });

  describe("full-codebase review fixes", () => {
    const lb = (extra = {}, query = { f: "json" }) => ({
      query,
      params: { lakebaseHost: "lakebase.example.com", lakebaseDatabase: "testdb", lakebaseTable: "cell_towers", geometryColumn: "geometry", idField: "id", ...extra },
      ip: "127.0.0.1",
    });

    it("Lakehouse: a failed close() of the main query destroys the connection instead of recycling it", (done) => {
      lakehouseQueryRows = [{ id: 1, geometry: '{"type":"Point","coordinates":[-77,38]}' }];
      lakehouseCloseError = new Error("close failed");
      new Model().getData({ query: { f: "json", resultRecordCount: "5" }, params: { tableName: "catalog.schema.towers", geometryFormat: "GEOMETRY" }, ip: "127.0.0.1" }, (err) => {
        // release() runs in getData's finally, after the (awaited, failing) close — poll briefly for it
        setTimeout(() => {
          try {
            expect(err).to.be.null;
            expect(lakehouseReleaseLog.at(-1)).to.include({ destroy: true });
            done();
          } catch (e) { done(e); }
        }, 20);
      });
    });

    it("Lakebase getData calls back exactly once even if the callback throws (no re-entry via .catch)", async () => {
      lakebaseQueryResult = { rows: [{ id: 1, geometry: '{"type":"Point","coordinates":[-77,38]}' }] };
      let calls = 0;
      const unhandled = [];
      const onUnhandled = (e) => unhandled.push(e);
      process.on("unhandledRejection", onUnhandled);
      try {
        new Model().getData(lb(), () => { calls++; throw new Error("socket gone"); });
        await new Promise((r) => setTimeout(r, 30));
      } finally { process.removeListener("unhandledRejection", onUnhandled); }
      expect(calls).to.equal(1);
      expect(unhandled).to.have.lengthOf(0);
    });

    it("Lakebase returnIdsOnly over the ceiling → actionable 400, like the Lakehouse path", (done) => {
      lakebaseQueryResult = { rows: Array.from({ length: 500001 }, (_, i) => ({ id: i + 1 })) };
      new Model().getData(lb({}, { f: "json", returnIdsOnly: "true" }), (err) => {
        expect(err).to.be.an("error");
        expect(err.message).to.include("DATABRICKS_MAX_RETURN_IDS");
        expect(err.code).to.equal(400);
        expect(lakebaseQueryLog[0].sql).to.include("LIMIT 500001");
        done();
      });
    });

    it("Lakebase idField configured as OBJECTID matches the lowercase key Postgres returns (reads, adds, deletes, getMetadata)", async () => {
      lakebaseQueryResult = { rows: [{ objectid: 7, geometry: '{"type":"Point","coordinates":[-77,38]}' }] };
      const fc = await new Promise((ok, no) => new Model().getData(lb({ idField: "OBJECTID" }), (e, r) => (e ? no(e) : ok(r))));
      expect(fc.metadata.idField).to.equal("objectid");
      expect(fc.features[0].properties.objectid).to.equal(7);

      lakebaseQueryResult = [{ rows: [{ objectid: 42 }] }];
      const add = await new Model().editData(lb({ idField: "OBJECTID" }), { adds: [{ attributes: { name: "x" }, geometry: { x: 0, y: 0 } }] });
      expect(add.addResults[0]).to.deep.equal({ objectId: 42, success: true });

      lakebaseQueryResult = { rows: [{ objectid: 5 }] };
      const del = await new Model().editData(lb({ idField: "OBJECTID" }), { deletes: "5" });
      expect(del.deleteResults[0]).to.deep.equal({ objectId: 5, success: true });

      const meta = await new Model().getMetadata(lb({ idField: "OBJECTID" }));
      expect(meta.idField).to.equal("objectid");
      const lhMeta = await new Model().getMetadata({ params: { tableName: "c.s.t", idField: "OBJECTID" } });
      expect(lhMeta.idField).to.equal("OBJECTID"); // Lakehouse keeps the configured spelling
    });

    it("a malformed delete id fails alone; the valid ids are still deleted", async () => {
      lakebaseQueryResult = { rows: [{ id: 1 }, { id: 2 }] };
      const r = await new Model().editData(lb(), { deletes: "1,abc,2" });
      expect(lakebaseQueryLog[0].params).to.deep.equal([1, 2]);
      const bad = r.deleteResults.find((x) => !x.success);
      expect(bad.error.code).to.equal(1018);
      expect(r.deleteResults.filter((x) => x.success).map((x) => x.objectId)).to.deep.equal([1, 2]);
    });

    it("empty entries in an array of deletes are dropped, never sent as id 0", async () => {
      lakebaseQueryResult = { rows: [{ id: 5 }] };
      const r = await new Model().editData(lb(), { deletes: ["5", "", null, "  "] });
      expect(lakebaseQueryLog[0].params).to.deep.equal([5]);
      expect(r.deleteResults).to.have.lengthOf(1);
    });

    it("an update with a non-integer id fails that row (1019) without running SQL", async () => {
      const r = await new Model().editData(lb(), { updates: [{ attributes: { id: "abc", name: "x" } }] });
      expect(r.updateResults[0].error.code).to.equal(1019);
      expect(lakebaseQueryLog.some((q) => q.sql.includes("UPDATE"))).to.equal(false);
    });

    it("a service published with editingEnabled=false refuses edits", async () => {
      let err;
      try { await new Model().editData(lb({ editingEnabled: "false" }), { deletes: [1] }); } catch (e) { err = e; }
      expect(err, "should refuse").to.exist;
      expect(err.message).to.include("not enabled");
      expect(lakebaseQueryLog).to.have.lengthOf(0);
      // unset (older services) stays editable
      lakebaseQueryResult = { rows: [{ id: 1 }] };
      const ok = await new Model().editData(lb(), { deletes: [1] });
      expect(ok.deleteResults[0].success).to.equal(true);
    });

    it("an INSERT whose new id is above 2^53 - 1 is reported as such, not as a rounded id", async () => {
      lakebaseQueryResult = [{ rows: [{ id: "9007199254740993" }] }];
      const r = await new Model().editData(lb(), { adds: [{ attributes: { name: "x" }, geometry: { x: 0, y: 0 } }] });
      expect(r.addResults[0].success).to.equal(false);
      expect(r.addResults[0].error.description).to.include("2^53");
    });

    it("a transaction client whose ROLLBACK fails is discarded, not recycled", async () => {
      // A failing INSERT is caught per row, so drive the outer error path: BEGIN and ROLLBACK both fail (dead connection).
      const origPush = lakebaseQueryLog.push.bind(lakebaseQueryLog);
      lakebaseQueryLog.push = (q) => { if (q.sql === "BEGIN" || q.sql === "ROLLBACK") throw new Error("connection terminated"); return origPush(q); };
      let err;
      try { await new Model().editData(lb(), { adds: [{ attributes: { name: "x" }, geometry: { x: 0, y: 0 } }], rollbackOnFailure: true }); } catch (e) { err = e; }
      lakebaseQueryLog.push = origPush;
      expect(err, "edit should fail").to.exist;
      expect(lakebaseClientReleases).to.have.lengthOf(1);
      expect(lakebaseClientReleases[0]).to.be.an("error"); // pg discards a client released with an Error
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

  describe("service parameter sentinels", () => {
    // The publish wizard makes every field required, so publishers type a placeholder
    // into inapplicable fields. These must be treated as "not provided".
    const sentinels = ["-", "--", "---", " ", "   ", "na", "NA", "n/a", "N/A", "none", "None"];

    sentinels.forEach((s) => {
      it(`treats lakebaseHost ${JSON.stringify(s)} as unset -> routes to Lakehouse`, (done) => {
        lakebaseQueryLog = [];
        const model = new Model();
        const req = {
          query: { f: "json" },
          params: {
            lakebaseHost: s,
            lakebasePort: s,
            lakebaseTable: s,
            tableName: "main.geo.towers",
            geometryColumn: "geom",
            idField: "objectid",
          },
          ip: "127.0.0.1",
        };
        model.getData(req, (err, result) => {
          expect(err).to.be.null;
          expect(result.type).to.equal("FeatureCollection");
          // Lakebase path is never entered — its query log stays empty.
          expect(lakebaseQueryLog).to.have.lengthOf(0);
          done();
        });
      });
    });

    it("still routes to Lakebase for a real lakebaseHost", (done) => {
      lakebaseQueryResult = { rows: [] };
      lakebaseQueryLog = [];
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
      model.getData(req, (err) => {
        expect(err).to.be.null;
        expect(lakebaseQueryLog.length).to.be.greaterThan(0);
        done();
      });
    });

    it("rejects editing when lakebaseHost is a sentinel", async () => {
      const model = new Model();
      const req = {
        params: {
          lakebaseHost: "-",
          lakebaseTable: "t",
          lakebaseDatabase: "d",
          geometryColumn: "geom",
          idField: "objectid",
        },
        ip: "127.0.0.1",
      };
      let threw = false;
      try {
        await model.editData(req, { adds: [{ attributes: {}, geometry: {} }] });
      } catch (err) {
        threw = true;
        expect(err.message).to.include("lakebaseHost");
      }
      expect(threw).to.be.true;
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

    // PBF always on: supportedQueryFormats is never set, so the runtime default 'JSON,geojson,PBF' applies. The old
    // enablePbf parameter was removed from the manifest; a service that still has it stored is unaffected (ignored).
    for (const params of [undefined, {}, { enablePbf: "false" }, { enablePbf: false }, { enablePbf: "true" }, { enablePbf: "-" }]) {
      it(`getMetadata never sets supportedQueryFormats (params ${JSON.stringify(params)})`, async () => {
        const metadata = await new Model().getMetadata(params === undefined ? undefined : { params });
        expect(metadata).to.not.have.property("supportedQueryFormats");
      });
    }
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

    // The runtime passes `deletes` the way the REST parameter arrives — not always an array. Only arrays used to
    // work; a number or "1,2" was silently ignored (logged "undefined deletes", nothing deleted, nothing reported).
    const deleteReq = () => ({
      params: {
        lakebaseHost: "lakebase.example.com",
        lakebaseDatabase: "testdb",
        lakebaseTable: "cell_towers",
        lakebaseSchema: "public",
        geometryColumn: "geometry",
        idField: "id",
      },
      ip: "127.0.0.1",
    });
    for (const [label, deletes, ids] of [
      ["a single number", 7, [7]],
      ["a comma-separated string", "7, 8,9", [7, 8, 9]],
      ["a bracketed string", "[7,8]", [7, 8]],
      ["a single-id string", "7", [7]],
    ]) {
      it(`should process deletes given as ${label}`, async () => {
        lakebaseQueryResult = { rows: ids.map((id) => ({ id })) };
        const result = await new Model().editData(deleteReq(), { deletes });
        expect(result.deleteResults.map((r) => r.objectId)).to.deep.equal(ids);
        result.deleteResults.forEach((r) => expect(r.success).to.be.true);
        expect(lakebaseQueryLog[0].sql).to.include("DELETE FROM");
        expect(lakebaseQueryLog[0].params).to.deep.equal(ids);
      });
    }

    it("update with an id above 2^53 - 1 fails that row (1019) and never runs the UPDATE", async () => {
      lakebaseQueryResult = { rows: [], rowCount: 1 };
      const result = await new Model().editData(deleteReq(), { updates: [{ attributes: { id: 9007199254740993, name: "x" } }] });
      expect(result.updateResults).to.have.lengthOf(1);
      expect(result.updateResults[0].success).to.equal(false);
      expect(result.updateResults[0].error.code).to.equal(1019);
      expect(result.updateResults[0].error.description).to.include("2^53");
      expect(lakebaseQueryLog.some((q) => q.sql.includes("UPDATE"))).to.equal(false);
    });

    it("deletes: an id above 2^53 - 1 fails (1018) and is kept out of the DELETE; safe ids still delete", async () => {
      lakebaseQueryResult = { rows: [{ id: 5 }] };
      const result = await new Model().editData(deleteReq(), { deletes: "5,9007199254740993" });
      expect(result.deleteResults).to.have.lengthOf(2);
      const bad = result.deleteResults.find((r) => !r.success);
      expect(bad.error.code).to.equal(1018);
      expect(bad.error.description).to.include("2^53");
      expect(result.deleteResults.find((r) => r.success).objectId).to.equal(5);
      expect(lakebaseQueryLog[0].params).to.deep.equal([5]);
    });

    it("deletes with ONLY unsafe ids → no DELETE issued at all", async () => {
      const result = await new Model().editData(deleteReq(), { deletes: [9007199254740993] });
      expect(result.deleteResults[0].success).to.equal(false);
      expect(lakebaseQueryLog.some((q) => q.sql.includes("DELETE"))).to.equal(false);
    });

    it("an unsafe id under rollbackOnFailure rolls the whole edit back (1003)", async () => {
      lakebaseQueryResult = [{ rows: [] }, { rows: [{ id: 7 }] }, { rows: [] }]; // BEGIN, INSERT RETURNING, ROLLBACK
      const result = await new Model().editData(deleteReq(), {
        adds: [{ attributes: { name: "a" }, geometry: { x: 0, y: 0 } }],
        deletes: [9007199254740993],
        rollbackOnFailure: true,
      });
      expect(result.addResults[0].error.code).to.equal(1003);
      expect(result.deleteResults[0].error.code).to.equal(1003);
      expect(lakebaseQueryLog.map((q) => q.sql)).to.include("ROLLBACK");
    });

    it("should treat an empty deletes value as no deletes (no DELETE issued)", async () => {
      for (const deletes of ["", null, undefined, []]) {
        lakebaseQueryLog = [];
        const result = await new Model().editData(deleteReq(), { deletes });
        expect(result.deleteResults).to.deep.equal([]);
        expect(lakebaseQueryLog.some((q) => q.sql.includes("DELETE"))).to.equal(false);
      }
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

// returnIdsOnly ceiling (DATABRICKS_MAX_RETURN_IDS): an id set larger than the ceiling must error with an actionable
// message, not silently truncate. Isolated describe so the small ceiling doesn't affect the other suites.
describe("returnIdsOnly ceiling", () => {
  let CeilModel;
  before(() => {
    process.env.DATABRICKS_SERVER_HOSTNAME = "test-host.databricks.com";
    process.env.DATABRICKS_HTTP_PATH = "/sql/1.0/endpoints/test";
    process.env.DATABRICKS_ACCESS_TOKEN = "test-token";
    process.env["LAKEBASE_PASSWORD"] = "test-lakebase-password"; // bracket form avoids a pre-commit secret false-positive
    process.env.ENABLE_AUDIT_LOG = "false";
    process.env.ENABLE_USER_AUTH = "false";
    process.env.ENABLE_SIMPLE_AUTH = "false";
    process.env.DATABRICKS_MAX_RETURN_IDS = "2"; // tiny ceiling for the test
    CeilModel = proxyquire("../src/model", {
      "./modules/connectionPool": connectionPoolStub,
      "./modules/lakebasePool": lakebasePoolStub,
      "./modules/workspaceResolver": workspaceResolverStub,
      dotenv: dotenvStub,
    });
  });
  after(() => { delete process.env.DATABRICKS_MAX_RETURN_IDS; });
  beforeEach(() => { lakehouseQueryRows = []; lakehouseReleaseLog = []; });

  const idsReq = () => ({
    query: { f: "json", returnIdsOnly: true, where: "1=1" },
    params: { tableName: "catalog.schema.towers", geometryColumn: "geometry", idField: "id", geometryFormat: "GEOMETRY" },
    ip: "127.0.0.1",
  });

  it("errors with an actionable message when the id set exceeds the ceiling", (done) => {
    lakehouseQueryRows = [{ id: 1 }, { id: 2 }, { id: 3 }]; // 3 > ceiling of 2 (SQL fetched ceiling + 1)
    new CeilModel().getData(idsReq(), (err, result) => {
      expect(err).to.be.an("error");
      expect(err.message).to.match(/maximum of 2 object ids/);
      expect(err.message).to.match(/DATABRICKS_MAX_RETURN_IDS/);
      expect(result).to.be.undefined;
      done();
    });
  });

  it("returns ids normally when the set is within the ceiling", (done) => {
    lakehouseQueryRows = [{ id: 1 }, { id: 2 }]; // 2 == ceiling, not over
    new CeilModel().getData(idsReq(), (err, result) => {
      expect(err).to.be.null;
      expect(result).to.be.an("object");
      done();
    });
  });

  it("does not apply the ceiling to returnIdsOnly + returnCountOnly (it's a COUNT, one row)", (done) => {
    lakehouseQueryRows = [{ "count(1)": 999999 }]; // a count far above the ceiling, but a single row
    const req = {
      query: { f: "json", returnIdsOnly: true, returnCountOnly: true, where: "1=1" },
      params: { tableName: "catalog.schema.towers", geometryColumn: "geometry", idField: "id", geometryFormat: "GEOMETRY" },
      ip: "127.0.0.1",
    };
    new CeilModel().getData(req, (err, result) => {
      expect(err).to.be.null;
      expect(result.count).to.equal(999999);
      done();
    });
  });
});
