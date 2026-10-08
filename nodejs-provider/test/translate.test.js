const { expect } = require("chai");
const { translateToGeoJSON } = require("../src/modules/translate");

describe("translate", () => {
  const defaultConfig = {
    idField: "OBJECTID",
    geometryColumn: "geometry",
  };

  describe("translateToGeoJSON", () => {
    it("should return empty FeatureCollection for null data", () => {
      const result = translateToGeoJSON(null, defaultConfig);
      expect(result.type).to.equal("FeatureCollection");
      expect(result.features).to.be.an("array").that.is.empty;
    });

    it("should return empty FeatureCollection for empty array", () => {
      const result = translateToGeoJSON([], defaultConfig);
      expect(result.type).to.equal("FeatureCollection");
      expect(result.features).to.be.an("array").that.is.empty;
    });

    it("should translate rows to GeoJSON features", () => {
      const data = [
        {
          OBJECTID: 1,
          name: "Test",
          geometry: '{"type":"Point","coordinates":[-122.4,37.8]}',
        },
      ];
      const result = translateToGeoJSON(data, defaultConfig);
      expect(result.type).to.equal("FeatureCollection");
      expect(result.features).to.have.lengthOf(1);
      expect(result.features[0].type).to.equal("Feature");
      expect(result.features[0].geometry.type).to.equal("Point");
      expect(result.features[0].properties.name).to.equal("Test");
      expect(result.features[0].properties.OBJECTID).to.equal(1);
    });

    it("should handle multiple features", () => {
      const data = [
        {
          OBJECTID: 1,
          name: "A",
          geometry: '{"type":"Point","coordinates":[0,0]}',
        },
        {
          OBJECTID: 2,
          name: "B",
          geometry: '{"type":"Point","coordinates":[1,1]}',
        },
      ];
      const result = translateToGeoJSON(data, defaultConfig);
      expect(result.features).to.have.lengthOf(2);
      expect(result.features[0].properties.name).to.equal("A");
      expect(result.features[1].properties.name).to.equal("B");
    });

    it("should place geometry in feature.geometry, not properties", () => {
      const data = [
        {
          OBJECTID: 1,
          geometry: '{"type":"Point","coordinates":[0,0]}',
        },
      ];
      const result = translateToGeoJSON(data, defaultConfig);
      expect(result.features[0].geometry).to.deep.equal({
        type: "Point",
        coordinates: [0, 0],
      });
      expect(result.features[0].properties).to.not.have.property("geometry");
    });

    it("should handle invalid geometry JSON gracefully", () => {
      const data = [
        {
          OBJECTID: 1,
          name: "Bad",
          geometry: "not-valid-json",
        },
      ];
      const result = translateToGeoJSON(data, defaultConfig);
      expect(result.features[0].geometry).to.be.null;
      expect(result.features[0].properties.name).to.equal("Bad");
    });

    it("should handle Polygon geometry", () => {
      const polygon = {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
      };
      const data = [
        {
          OBJECTID: 1,
          geometry: JSON.stringify(polygon),
        },
      ];
      const result = translateToGeoJSON(data, defaultConfig);
      expect(result.features[0].geometry.type).to.equal("Polygon");
    });

    it("should handle extra properties beyond OBJECTID and geometry", () => {
      const data = [
        {
          OBJECTID: 1,
          name: "Test",
          status: "active",
          count: 42,
          geometry: '{"type":"Point","coordinates":[0,0]}',
        },
      ];
      const result = translateToGeoJSON(data, defaultConfig);
      const props = result.features[0].properties;
      expect(props.name).to.equal("Test");
      expect(props.status).to.equal("active");
      expect(props.count).to.equal(42);
    });

    it("should use custom geometryColumn from config", () => {
      const data = [
        {
          OBJECTID: 1,
          geom: '{"type":"Point","coordinates":[0,0]}',
        },
      ];
      const result = translateToGeoJSON(data, {
        ...defaultConfig,
        geometryColumn: "geom",
      });
      expect(result.features[0].geometry.type).to.equal("Point");
      expect(result.features[0].properties).to.not.have.property("geom");
    });

    it("warns once per idField (not per feature) for ids over the 32-bit OBJECTID range", () => {
      // AIS bigid is 64-bit; without throttling this fired one console.warn per row (~8,900/view).
      const rows = [
        { biggy: "9000000001", geom: '{"type":"Point","coordinates":[0,0]}' },
        { biggy: "9000000002", geom: '{"type":"Point","coordinates":[1,1]}' },
        { biggy: "9000000003", geom: '{"type":"Point","coordinates":[2,2]}' },
      ];
      const orig = console.warn; let calls = 0;
      console.warn = () => { calls++; };
      try {
        translateToGeoJSON(rows, { idField: "biggy", geometryColumn: "geom", dbWKID: 4326 });
      } finally { console.warn = orig; }
      expect(calls).to.equal(1); // one warning for three overflowing-id rows, not three
    });
  });
});

describe("normalizeAntimeridian", () => {
  const { normalizeAntimeridian } = require("../src/modules/translate");
  const span = (ring) => Math.max(...ring.map((p) => p[0])) - Math.min(...ring.map((p) => p[0]));
  // an H3 r5 cell straddling 180° as stored (-180..180): vertices jump between +179.9x and -179.9x
  const wrapped = [[179.98, 51.1], [-179.95, 51.2], [-179.93, 51.4], [179.99, 51.5], [179.9, 51.3], [179.98, 51.1]];

  it("unwraps a polygon crossing 180° into a small shape (negative longitudes +360)", () => {
    const g = normalizeAntimeridian({ type: "Polygon", coordinates: [wrapped] }, 4326);
    expect(span(g.coordinates[0])).to.be.below(1);
    expect(g.coordinates[0][1][0]).to.be.closeTo(180.05, 1e-9);
  });

  it("shifts a polygon's holes with its outer ring", () => {
    const hole = [[179.97, 51.25], [-179.96, 51.3], [179.97, 51.35], [179.97, 51.25]];
    const g = normalizeAntimeridian({ type: "Polygon", coordinates: [wrapped, hole] }, 4326);
    expect(span(g.coordinates[1])).to.be.below(1);
  });

  it("handles MultiPolygon parts independently", () => {
    const normal = [[-75, 38], [-74, 38], [-74, 39], [-75, 38]];
    const g = normalizeAntimeridian({ type: "MultiPolygon", coordinates: [[wrapped], [normal]] }, 4326);
    expect(span(g.coordinates[0][0])).to.be.below(1);
    expect(g.coordinates[1][0]).to.deep.equal(normal);
  });

  it("unwraps a LineString crossing 180°", () => {
    const g = normalizeAntimeridian({ type: "LineString", coordinates: [[179.5, 52], [-179.5, 52.2]] }, 4326);
    expect(g.coordinates).to.deep.equal([[179.5, 52], [180.5, 52.2]]);
  });

  it("leaves ordinary polygons, points, polar rings and non-4326 geometry alone", () => {
    const normal = { type: "Polygon", coordinates: [[[-75, 38], [-74, 38], [-74, 39], [-75, 38]]] };
    expect(normalizeAntimeridian(normal, 4326)).to.deep.equal(normal);
    const pt = { type: "Point", coordinates: [-179.9, 51] };
    expect(normalizeAntimeridian(pt, 4326)).to.deep.equal(pt);
    const polar = { type: "Polygon", coordinates: [[[-170, 88], [10, 88], [100, 89], [-170, 88]]] };
    expect(normalizeAntimeridian(polar, 4326)).to.deep.equal(polar);
    const merc = { type: "Polygon", coordinates: [wrapped] };
    expect(normalizeAntimeridian(merc, 3857)).to.deep.equal(merc);
    expect(normalizeAntimeridian(null, 4326)).to.equal(null);
  });

  it("leaves a wide polygon through Greenwich alone (no edge actually jumps the dateline)", () => {
    // Bbox span > 180° but sampled finely so no consecutive edge exceeds 180°, and it crosses 0 not 180. The old
    // bbox-span heuristic would have shifted (corrupted) this; the edge-jump test correctly leaves it untouched.
    const wide = { type: "Polygon", coordinates: [[
      [-100, 10], [-50, 10], [0, 10], [50, 10], [100, 10],
      [100, 20], [50, 20], [0, 20], [-50, 20], [-100, 20], [-100, 10],
    ]] };
    expect(span(wide.coordinates[0])).to.be.above(180); // would trip the old detector
    expect(normalizeAntimeridian(wide, 4326)).to.deep.equal(wide);
  });

  it("is applied by translateToGeoJSON", () => {
    const fc = translateToGeoJSON(
      [{ id: 1, geometry: JSON.stringify({ type: "Polygon", coordinates: [wrapped] }) }],
      { idField: "id", geometryColumn: "geometry", dbWKID: 4326 },
    );
    expect(span(fc.features[0].geometry.coordinates[0])).to.be.below(1);
  });
});
