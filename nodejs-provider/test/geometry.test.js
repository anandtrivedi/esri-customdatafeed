const { expect } = require("chai");
const { getGeometryQuery, getExtentFromGeoJson } = require("../src/modules/geometry");

describe("geometry", () => {
  const defaultField = "geometry";
  const defaultDbSR = 4326;

  describe("getGeometryQuery", () => {
    describe("spatial relations", () => {
      const envelope = JSON.stringify({
        xmin: -180,
        ymin: -90,
        xmax: 180,
        ymax: 90,
        spatialReference: { wkid: 4326 },
      });

      it("should build ST_Intersects for esriSpatialRelIntersects", () => {
        const result = getGeometryQuery(
          envelope,
          defaultField,
          null,
          "esriSpatialRelIntersects",
          defaultDbSR,
          "GEOMETRY"
        );
        expect(result).to.include("ST_Intersects(");
      });

      it("should build ST_Contains for esriSpatialRelContains", () => {
        const result = getGeometryQuery(
          envelope,
          defaultField,
          null,
          "esriSpatialRelContains",
          defaultDbSR,
          "GEOMETRY"
        );
        expect(result).to.include("ST_Contains(");
      });

      it("should build ST_Within for esriSpatialRelWithin", () => {
        const result = getGeometryQuery(
          envelope,
          defaultField,
          null,
          "esriSpatialRelWithin",
          defaultDbSR,
          "GEOMETRY"
        );
        expect(result).to.include("ST_Within(");
      });

      it("should build ST_Touches for esriSpatialRelTouches", () => {
        const result = getGeometryQuery(
          envelope,
          defaultField,
          null,
          "esriSpatialRelTouches",
          defaultDbSR,
          "GEOMETRY"
        );
        expect(result).to.include("ST_Touches(");
      });

      it("should build DE-9IM expression for esriSpatialRelCrosses", () => {
        const result = getGeometryQuery(
          envelope,
          defaultField,
          null,
          "esriSpatialRelCrosses",
          defaultDbSR,
          "GEOMETRY"
        );
        expect(result).to.include("ST_Intersects(");
        expect(result).to.include("NOT ST_Touches(");
        expect(result).to.include("NOT ST_Contains(");
        expect(result).to.include("NOT ST_Within(");
        expect(result).to.include("ST_Dimension(ST_Intersection(");
        expect(result).to.include("GREATEST(");
      });

      it("should build DE-9IM expression for esriSpatialRelOverlaps", () => {
        const result = getGeometryQuery(
          envelope,
          defaultField,
          null,
          "esriSpatialRelOverlaps",
          defaultDbSR,
          "GEOMETRY"
        );
        expect(result).to.include("ST_Dimension(");
        expect(result).to.include("ST_Intersects(");
        expect(result).to.include("NOT ST_Covers(");
        expect(result).to.include("NOT ST_Touches(");
      });

      it("should throw for unsupported spatial relation", () => {
        expect(() =>
          getGeometryQuery(
            envelope,
            defaultField,
            null,
            "esriSpatialRelUnknown",
            defaultDbSR,
            "GEOMETRY"
          )
        ).to.throw(/Unsupported spatial relation/);
      });
    });

    describe("geometry input formats", () => {
      it("should handle comma-delimited envelope (bbox)", () => {
        const result = getGeometryQuery(
          "-180,-90,180,90",
          defaultField,
          null,
          "esriSpatialRelIntersects",
          defaultDbSR,
          "GEOMETRY"
        );
        expect(result).to.include("ST_GeomFromGeoJSON");
        expect(result).to.include("Polygon");
      });

      it("should handle comma-delimited point", () => {
        const result = getGeometryQuery(
          "-122.4,37.8",
          defaultField,
          null,
          "esriSpatialRelIntersects",
          defaultDbSR,
          "GEOMETRY"
        );
        expect(result).to.include("ST_GeomFromGeoJSON");
        expect(result).to.include("Point");
      });

      it("should handle Esri point JSON", () => {
        const point = JSON.stringify({
          x: -122.4,
          y: 37.8,
          spatialReference: { wkid: 4326 },
        });
        const result = getGeometryQuery(
          point,
          defaultField,
          null,
          "esriSpatialRelIntersects",
          defaultDbSR,
          "GEOMETRY"
        );
        expect(result).to.include("Point");
        expect(result).to.include("-122.4");
      });

      it("should handle Esri polygon JSON", () => {
        const polygon = JSON.stringify({
          rings: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
          spatialReference: { wkid: 4326 },
        });
        const result = getGeometryQuery(
          polygon,
          defaultField,
          null,
          "esriSpatialRelIntersects",
          defaultDbSR,
          "GEOMETRY"
        );
        expect(result).to.include("Polygon");
      });

      it("should handle Esri polyline JSON", () => {
        const polyline = JSON.stringify({
          paths: [
            [
              [0, 0],
              [1, 1],
            ],
          ],
          spatialReference: { wkid: 4326 },
        });
        const result = getGeometryQuery(
          polyline,
          defaultField,
          null,
          "esriSpatialRelIntersects",
          defaultDbSR,
          "GEOMETRY"
        );
        expect(result).to.include("LineString");
      });

      it("should map multi-path Esri polyline to MultiLineString", () => {
        const polyline = JSON.stringify({
          paths: [
            [
              [0, 0],
              [1, 1],
            ],
            [
              [2, 2],
              [3, 3],
            ],
          ],
          spatialReference: { wkid: 4326 },
        });
        const result = getGeometryQuery(
          polyline,
          defaultField,
          null,
          "esriSpatialRelIntersects",
          defaultDbSR,
          "GEOMETRY"
        );
        expect(result).to.include("MultiLineString");
        // Both paths must survive the conversion
        expect(result).to.include("[2,2]");
      });
    });

    describe("spatial reference transformation", () => {
      it("should not transform when inSR matches dbSR", () => {
        const envelope = JSON.stringify({
          xmin: -180,
          ymin: -90,
          xmax: 180,
          ymax: 90,
          spatialReference: { wkid: 4326 },
        });
        const result = getGeometryQuery(
          envelope,
          defaultField,
          null,
          "esriSpatialRelIntersects",
          4326,
          "GEOMETRY"
        );
        expect(result).to.not.include("ST_Transform");
      });

      it("should apply ST_Transform when inSR differs from dbSR", () => {
        const envelope = JSON.stringify({
          xmin: -20037508,
          ymin: -20048966,
          xmax: 20037508,
          ymax: 20048966,
          spatialReference: { wkid: 3857 },
        });
        const result = getGeometryQuery(
          envelope,
          defaultField,
          null,
          "esriSpatialRelIntersects",
          4326,
          "GEOMETRY"
        );
        expect(result).to.include("ST_Transform");
        expect(result).to.include("ST_SetSRID");
      });

      it("should use explicit inSR parameter over geometry SR", () => {
        const envelope = JSON.stringify({
          xmin: -180,
          ymin: -90,
          xmax: 180,
          ymax: 90,
          spatialReference: { wkid: 4326 },
        });
        const result = getGeometryQuery(
          envelope,
          defaultField,
          "3857",
          "esriSpatialRelIntersects",
          4326,
          "GEOMETRY"
        );
        expect(result).to.include("ST_Transform");
      });

      it("should parse inSR as JSON with spatialReference.wkid", () => {
        const envelope = JSON.stringify({
          xmin: -180,
          ymin: -90,
          xmax: 180,
          ymax: 90,
        });
        const result = getGeometryQuery(
          envelope,
          defaultField,
          JSON.stringify({ spatialReference: { wkid: 3857 } }),
          "esriSpatialRelIntersects",
          4326,
          "GEOMETRY"
        );
        expect(result).to.include("ST_Transform");
      });

      it("should parse inSR as JSON with top-level wkid (MapViewer format)", () => {
        const envelope = JSON.stringify({
          xmin: -7514065.628,
          ymin: 5009377.085,
          xmax: -5009377.085,
          ymax: 7514065.628,
        });
        const result = getGeometryQuery(
          envelope,
          defaultField,
          JSON.stringify({ wkid: 102100, latestWkid: 3857, xyTolerance: 0.001 }),
          "esriSpatialRelIntersects",
          4326,
          "GEOMETRY"
        );
        expect(result).to.include("ST_Transform");
        expect(result).to.include("ST_SetSRID");
        expect(result).to.include("102100");
        expect(result).to.not.include("NaN");
      });
    });
  });

  describe("getExtentFromGeoJson", () => {
    it("should calculate extent from polygon coordinates", () => {
      const polygon = {
        type: "Polygon",
        coordinates: [
          [
            [-122.5, 37.7],
            [-122.4, 37.7],
            [-122.4, 37.8],
            [-122.5, 37.8],
            [-122.5, 37.7],
          ],
        ],
      };
      const extent = getExtentFromGeoJson(polygon, 4326);
      expect(extent.xmin).to.equal(-122.5);
      expect(extent.ymin).to.equal(37.7);
      expect(extent.xmax).to.equal(-122.4);
      expect(extent.ymax).to.equal(37.8);
      expect(extent.spatialReference.wkid).to.equal(4326);
    });

    it("should handle single-point polygon (degenerate)", () => {
      const polygon = {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
          ],
        ],
      };
      const extent = getExtentFromGeoJson(polygon, 4326);
      expect(extent.xmin).to.equal(0);
      expect(extent.xmax).to.equal(0);
    });

    it("should use provided WKID", () => {
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
      const extent = getExtentFromGeoJson(polygon, 3857);
      expect(extent.spatialReference.wkid).to.equal(3857);
    });

    it("should return null for null input", () => {
      expect(getExtentFromGeoJson(null, 4326)).to.be.null;
    });

    it("should return null for undefined input", () => {
      expect(getExtentFromGeoJson(undefined, 4326)).to.be.null;
    });

    it("should return null for geometry with no coordinates", () => {
      expect(getExtentFromGeoJson({}, 4326)).to.be.null;
      expect(getExtentFromGeoJson({ coordinates: null }, 4326)).to.be.null;
      expect(getExtentFromGeoJson({ coordinates: [] }, 4326)).to.be.null;
    });
  });
});
