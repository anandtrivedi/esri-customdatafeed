const { expect } = require("chai");
const { generateFiltersApplied } = require("../src/modules/filters");

describe("filters", () => {
  describe("generateFiltersApplied", () => {
    it("should return empty object when no filters applied", () => {
      const result = generateFiltersApplied({}, "OBJECTID", "geometry");
      expect(result).to.deep.equal({});
    });

    it("should set where flag when where is present", () => {
      const result = generateFiltersApplied(
        { where: "status = 'active'" },
        "OBJECTID",
        "geometry"
      );
      expect(result.where).to.be.true;
    });

    it("should set objectIds flag when objectIds and idField are present", () => {
      const result = generateFiltersApplied(
        { objectIds: "1,2,3" },
        "OBJECTID",
        "geometry"
      );
      expect(result.objectIds).to.be.true;
    });

    it("should not set objectIds flag when idField is missing", () => {
      const result = generateFiltersApplied(
        { objectIds: "1,2,3" },
        null,
        "geometry"
      );
      expect(result.objectIds).to.be.undefined;
    });

    it("should set offset flag when resultOffset is present", () => {
      const result = generateFiltersApplied(
        { resultOffset: 10 },
        "OBJECTID",
        "geometry"
      );
      expect(result.offset).to.be.true;
    });

    it("should set resultOffset flag (CDF 12.0 param name) when resultOffset is present", () => {
      // The 12.0 featureserver removes already-applied params by geoservice
      // name — without this key it re-applies the offset and drops features
      const result = generateFiltersApplied(
        { resultOffset: 10 },
        "OBJECTID",
        "geometry"
      );
      expect(result.resultOffset).to.be.true;
    });

    it("should set orderByFields flag when orderByFields is present", () => {
      const result = generateFiltersApplied(
        { orderByFields: "name ASC" },
        "OBJECTID",
        "geometry"
      );
      expect(result.orderByFields).to.be.true;
    });

    it("should set geometry flag when geometry and geometryField are present", () => {
      const result = generateFiltersApplied(
        { geometry: "-180,-90,180,90" },
        "OBJECTID",
        "geometry"
      );
      expect(result.geometry).to.be.true;
    });

    it("should not set geometry flag when geometryField is missing", () => {
      const result = generateFiltersApplied(
        { geometry: "-180,-90,180,90" },
        "OBJECTID",
        null
      );
      expect(result.geometry).to.be.undefined;
    });

    it("should set limit flag when resultRecordCount is present", () => {
      const result = generateFiltersApplied(
        { resultRecordCount: 100 },
        "OBJECTID",
        "geometry"
      );
      expect(result.limit).to.be.true;
    });

    it("should set resultRecordCount flag (CDF 12.0 param name) when resultRecordCount is present", () => {
      const result = generateFiltersApplied(
        { resultRecordCount: 100 },
        "OBJECTID",
        "geometry"
      );
      expect(result.resultRecordCount).to.be.true;
    });

    it("should set time flag when time is present", () => {
      const result = generateFiltersApplied(
        { time: "1704067200000,1704153600000" },
        "OBJECTID",
        "geometry"
      );
      expect(result.time).to.be.true;
    });

    it("should set multiple flags for combined filters", () => {
      const result = generateFiltersApplied(
        {
          where: "status = 'active'",
          objectIds: "1,2",
          resultOffset: 10,
          geometry: "-180,-90,180,90",
        },
        "OBJECTID",
        "geometry"
      );
      expect(result.where).to.be.true;
      expect(result.objectIds).to.be.true;
      expect(result.offset).to.be.true;
      expect(result.geometry).to.be.true;
    });

    describe("returnDistinctValues bypass", () => {
      it("should return empty object when returnDistinctValues is true", () => {
        const result = generateFiltersApplied(
          {
            returnDistinctValues: true,
            where: "status = 'active'",
            objectIds: "1,2",
            geometry: "-180,-90,180,90",
          },
          "OBJECTID",
          "geometry"
        );
        expect(result).to.deep.equal({});
      });

      it("should apply filters when returnDistinctValues is false", () => {
        const result = generateFiltersApplied(
          {
            returnDistinctValues: false,
            where: "status = 'active'",
          },
          "OBJECTID",
          "geometry"
        );
        expect(result.where).to.be.true;
      });
    });
  });
});
