"use strict";
const RMCloudDriver = require("../../lib/RMCloudDriver");
module.exports = class extends RMCloudDriver {
  get cloudModel() { return "rm3_mini"; }
};
