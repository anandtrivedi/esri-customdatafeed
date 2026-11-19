const { expect } = require("chai");
const cdconfig = require("../cdconfig.json");

describe("cdconfig.json service parameters", function () {
  it("keeps each 'label (description):' short enough for Server Manager's publish form", () => {
    // Server Manager renders every parameter as one nowrap line, "label (description):", with the input after it. Long
    // descriptions widened the dialog to ~4,200 px and pushed every input off-screen; details belong in the README.
    const tooLong = cdconfig.properties.serviceParameters
      .map((p) => `${p.label} (${p.description}):`)
      .filter((line) => line.length > 115);
    expect(tooLong).to.deep.equal([]);
  });
});
