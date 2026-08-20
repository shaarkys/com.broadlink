"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
let RM4ProDevice;

try {
  Module._load = function loadWithHomeyStub(request, parent, isMain) {
    if (request === "homey") {
      return { Device: class {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  RM4ProDevice = require("../drivers/RM4_pro/device");
} finally {
  Module._load = originalLoad;
}

test("RM4 Pro declares the standard Homey Climate classification", () => {
  const manifest = require("../drivers/RM4_pro/driver.compose.json");

  assert.equal(manifest.class, "sensor");
  assert.ok(manifest.capabilities.includes("measure_temperature"));
  assert.ok(manifest.capabilities.includes("measure_humidity"));
  assert.ok(manifest.capabilities.includes("measure_temperature_rm4"));
  assert.ok(manifest.capabilities.includes("measure_humidity_rm4"));
});

test("existing RM4 Pro devices migrate to the sensor class and standard capabilities", async () => {
  const calls = [];
  const device = {
    hasCapability: () => false,
    getClass: () => "other",
    addCapability: async (capability) => calls.push(["addCapability", capability]),
    setClass: async (deviceClass) => calls.push(["setClass", deviceClass]),
    _utils: { debugLog: () => {} },
    error: () => assert.fail("migration should not fail"),
  };

  await RM4ProDevice.prototype.migrateClimateCapabilities.call(device);

  assert.deepEqual(calls, [
    ["addCapability", "measure_humidity"],
    ["addCapability", "measure_temperature"],
    ["setClass", "sensor"],
  ]);
});

test("RM4 Pro polling updates standard and legacy climate capabilities", async () => {
  const values = [];
  const device = {
    _communicate: {
      checkTempHumidity_rm4pro: async () => ({ temperature: [21, 5], humidity: [47, 3] }),
    },
    setCapabilityValue: async (capability, value) => values.push([capability, value]),
    _utils: { debugLog: () => {} },
    error: () => assert.fail("capability update should not fail"),
  };

  await RM4ProDevice.prototype.pollTempHumidity.call(device);

  assert.deepEqual(values, [
    ["measure_temperature", 21.5],
    ["measure_humidity", 47.3],
    ["measure_temperature_rm4", 21.5],
    ["measure_humidity_rm4", 47.3],
  ]);
});
