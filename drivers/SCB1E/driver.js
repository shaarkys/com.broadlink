"use strict";

const BroadlinkDriver = require("../../lib/BroadlinkDriver");
const { BroadlinkType } = require("../../lib/DeviceInfo");

class SCB1EDriver extends BroadlinkDriver {
  onInit() {
    super.onInit({ CompatibilityID: BroadlinkType.SCB1E });
  }
}

module.exports = SCB1EDriver;
