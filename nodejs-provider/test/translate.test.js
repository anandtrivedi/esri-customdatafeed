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
  });
});
