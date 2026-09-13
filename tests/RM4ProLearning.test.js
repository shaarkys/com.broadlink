"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const vm = require("node:vm");
const Communicate = require("../lib/Communicate");

const originalLoad = Module._load;
let RM4ProDevice;
let BroadlinkApp;
try {
  Module._load = function (request, parent, isMain) {
    if (request === "homey") return { Device: class {}, App: class {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  RM4ProDevice = require("../drivers/RM4_pro/device");
  BroadlinkApp = require("../app");
} finally {
  Module._load = originalLoad;
}

function communication() {
  const logs = [];
  const comm = new Communicate();
  comm.homey = { __: (key) => key };
  comm._utils = {
    debugLog: (_source, ...args) => logs.push(args.join(" ")),
    arrToHex: (bytes) => Buffer.from(bytes).toString("hex"),
  };
  return { comm, logs };
}

test("manual RF frequencies encode in kHz, including 433.92 and 315 MHz", () => {
  const { comm } = communication();
  assert.deepEqual([...comm.encodeRFFrequency_rm4pro(433.92)], [0, 159, 6, 0]);
  assert.equal(comm.encodeRFFrequency_rm4pro(315).readUInt32LE(), 315000);
  assert.equal(comm.encodeRFFrequency_rm4pro(433.925).readUInt32LE(), 433925);
  for (const frequency of [undefined, null, 0]) assert.equal(comm.encodeRFFrequency_rm4pro(frequency), null);
  for (const frequency of [-1, 304, 336, 429, 441, 868, NaN, Infinity, "433.92", {}, true]) {
    assert.throws(() => comm.encodeRFFrequency_rm4pro(frequency), /RF frequency/);
  }
});

test("RF capture sends the full frequency frame once, then separate read commands", async () => {
  const { comm } = communication();
  const packets = [];
  comm._check_data = async (packet) => {
    packets.push([...packet]);
    return packets.length < 3 ? new Uint8Array(12) : Uint8Array.from([0, 0, 0xb2, 0, 2, 0, 0x12, 0x34]);
  };
  const data = await comm.checkRFData2_rm4pro(comm.encodeRFFrequency_rm4pro(433.92));
  assert.deepEqual(packets, [
    [8, 0, 0x1b, 0, 0, 0, 0, 159, 6, 0],
    [4, 0, 4, 0, 0, 0],
    [4, 0, 4, 0, 0, 0],
  ]);
  assert.deepEqual([...data], [0xb2, 0, 2, 0, 0x12, 0x34]);
});

test("RF capture stops after ten empty reads", async () => {
  const { comm } = communication();
  let calls = 0;
  comm._check_data = async () => { calls++; return new Uint8Array(12); };
  await assert.rejects(comm.checkRFData2_rm4pro(comm.encodeRFFrequency_rm4pro(315)), /no_rf_data/);
  assert.equal(calls, 11);
});

async function runLearning(t, frequency, captureError) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originalImmediate = global.setImmediate;
  let scheduled;
  global.setImmediate = (fn) => { scheduled = fn; };
  const calls = [];
  const { comm } = communication();
  const device = Object.assign(Object.create(RM4ProDevice.prototype), {
    _utils: comm._utils,
    _communicate: {
      encodeRFFrequency_rm4pro: comm.encodeRFFrequency_rm4pro.bind(comm),
      enterRFSweep_rm4pro: async () => calls.push("sweep"),
      checkRFData_rm4pro: async () => { calls.push("findFrequency"); return comm.encodeRFFrequency_rm4pro(315); },
      checkRFData2_rm4pro: async (bytes) => {
        calls.push(["capture", Buffer.from(bytes).readUInt32LE()]);
        if (captureError) throw new Error("capture failed");
        return Uint8Array.from([0xb2, 0, 1, 0, 0x20]);
      },
      cancelRFSweep_rm4pro: async () => calls.push("stop"),
    },
    getData: () => ({ devtype: 0x520b }),
    isSpeechOutputAvailable: () => true,
    homey: { __: (key) => key, speechOutput: { say: async (message) => calls.push(message) } },
    setCapabilityValue: async (key, value) => calls.push([key, value]),
    setWarning: async () => {},
    unsetWarning: async () => {},
    dataStore: { dataArray: [], addCommand: (name) => calls.push(["store", name]) },
    storeCmdSetting: async () => {},
    error: (err) => assert.fail(String(err)),
  });
  try {
    assert.equal(await device.startRfLearning(frequency), true);
    assert.equal(device.learn, true);
    const done = scheduled();
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
      t.mock.timers.tick(2000);
    }
    await done;
    assert.equal(device.learn, false);
    assert.ok(calls.includes("stop"));
    assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "learningStateRF" && call[1] === false));
    return calls;
  } finally {
    global.setImmediate = originalImmediate;
  }
}

test("manual learning bypasses sweeping and long-press prompts and stores RF data", async (t) => {
  const calls = await runLearning(t, 433.92);
  assert.ok(!calls.includes("sweep"));
  assert.ok(!calls.includes("findFrequency"));
  assert.ok(!calls.includes("rf_learn.long_press"));
  assert.ok(calls.includes("rf_learn.multi_presses"));
  assert.ok(calls.some((call) => call[0] === "capture" && call[1] === 433920));
  assert.ok(calls.some((call) => call[0] === "store" && call[1] === "rf-cmd1"));
});

test("automatic learning still sweeps and uses the detected frequency", async (t) => {
  const calls = await runLearning(t, 0);
  assert.ok(calls.includes("sweep"));
  assert.ok(calls.includes("findFrequency"));
  assert.ok(calls.includes("rf_learn.long_press"));
  assert.ok(calls.some((call) => call[0] === "capture" && call[1] === 315000));
});

test("failed manual capture resets learning without storing a command", async (t) => {
  const calls = await runLearning(t, 433.92, true);
  assert.ok(calls.includes("rf_learn.error"));
  assert.ok(!calls.some((call) => call[0] === "store"));
});

test("Homey capability options cannot be mistaken for a manual frequency", async () => {
  let args;
  const device = {
    _utils: { debugLog() {} },
    startRfLearning: async (...values) => { args = values; return true; },
  };
  await RM4ProDevice.prototype.onCapabilityLearnRF.call(device, true, { duration: 1000 });
  assert.deepEqual(args, []);
});

test("invalid manual frequency is rejected before changing learning state", async () => {
  const { comm } = communication();
  const device = { _communicate: comm, setCapabilityValue: () => assert.fail("must not change state") };
  await assert.rejects(RM4ProDevice.prototype.startRfLearning.call(device, 868), /RF frequency/);
  assert.equal(device.learn, undefined);
});

test("sensor decoding uses RM4 header offsets, signed temperature and hundredths", async () => {
  const { comm } = communication();
  comm._check_data = async (packet) => {
    assert.deepEqual([...packet.slice(0, 6)], [4, 0, 0x24, 0, 0, 0]);
    // Full decrypted frame: length, command, signed temperature, humidity, trailing data.
    return Uint8Array.from([10, 0, 0x24, 0, 0, 0, 251, 231, 47, 3, 5, 0, 0, 0, 0, 0]).slice(4);
  };
  const values = await comm.checkTempHumidity_rm4pro();
  assert.deepEqual(values, { temperature: [-5, -25], humidity: [47, 3] });
  const updates = [];
  await RM4ProDevice.prototype.pollTempHumidity.call({
    _communicate: comm,
    _utils: comm._utils,
    setCapabilityValue: async (key, value) => updates.push([key, value]),
    error: (err) => assert.fail(String(err)),
  });
  assert.deepEqual(updates, [
    ["measure_temperature", -5.25], ["measure_humidity", 47.03],
    ["measure_temperature_rm4", -5.25], ["measure_humidity_rm4", 47.03],
  ]);
});

test("the reporter's exact zero response produces a cable diagnostic, not a fabricated measurement", async () => {
  const { comm, logs } = communication();
  comm._check_data = async () => Uint8Array.from([0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0]);
  assert.deepEqual(await comm.checkTempHumidity_rm4pro(), { temperature: [0, 0], humidity: [0, 0] });
  assert.ok(logs.some((message) => message.includes("HTS2") && message.includes("does not identify the cause")));
});

test("incomplete sensor replies do not overwrite capabilities", async () => {
  const { comm, logs } = communication();
  comm._check_data = async () => Uint8Array.from([0, 0, 21]);
  await RM4ProDevice.prototype.pollTempHumidity.call({
    _communicate: comm,
    _utils: comm._utils,
    setCapabilityValue: () => assert.fail("must not write an incomplete measurement"),
  });
  assert.ok(logs.some((message) => message.includes("Incomplete RM4")));
});

test("command manager starts RM4 learning, acknowledges startup, and rejects unavailable/busy devices", async () => {
  for (const scenario of ["ok", "auto", "busy", "other", "missing", "invalid"]) {
    const frequencies = [];
    const { comm } = communication();
    const device = {
      driver: { id: scenario === "other" ? "RM_pro" : "RM4_pro" },
      learn: scenario === "busy",
      startRfLearning: async (frequency) => {
        comm.encodeRFFrequency_rm4pro(frequency);
        frequencies.push(frequency);
      },
    };
    let result;
    await BroadlinkApp.prototype.handleRfManagerAction.call({
      _rfDevices: new Map(scenario === "missing" ? [] : [["test-device", device]]),
      homey: { settings: {
        get: () => ({ type: "learnRF", mac: "test-device", requestId: "test", frequencyMHz: scenario === "auto" ? undefined : scenario === "invalid" ? 868 : 433.92 }),
        set: async (_key, value) => { result = value; },
      } },
    });
    assert.equal(result.ok, scenario === "ok" || scenario === "auto");
    if (result.ok) {
      assert.equal(result.started, true);
      assert.deepEqual(frequencies, [scenario === "auto" ? 0 : 433.92]);
    } else {
      assert.equal(frequencies.length, 0);
      assert.ok(result.error);
    }
  }
});

test("settings UI shows learning only for RM4 Pro and submits MHz or automatic mode", async () => {
  const elements = {
    "rf-learning": {}, "rf-learn-status": {}, "rf-learn": {},
    "rf-frequency": { value: "433.92", reportValidity: () => true },
  };
  const context = vm.createContext({ document: { getElementById: (id) => elements[id] } });
  vm.runInContext(fs.readFileSync(require.resolve("../settings/js/settings.js"), "utf8"), context);
  vm.runInContext('rfState.devices = [{ mac: "pro", driverId: "RM4_pro" }, { mac: "mini", driverId: "RM4_mini" }]; rfState.selectedMac = "mini"; renderRfLearning();', context);
  assert.equal(elements["rf-learning"].hidden, true);
  vm.runInContext('rfState.selectedMac = "pro"; renderRfLearning();', context);
  assert.equal(elements["rf-learning"].hidden, false);
  const actions = [];
  context.callAction = async (_homey, action) => { actions.push(action); return { ok: true, started: true }; };
  await context.onLearnRF({});
  assert.equal(actions[0].frequencyMHz, 433.92);
  assert.match(elements["rf-learn-status"].textContent, /Learning started at 433.92/);
  elements["rf-frequency"].value = "";
  await context.onLearnRF({});
  assert.equal(actions[1].frequencyMHz, 0);
  assert.match(elements["rf-learn-status"].textContent, /Automatic scanning started/);
  assert.equal(elements["rf-learn"].disabled, false);
});
