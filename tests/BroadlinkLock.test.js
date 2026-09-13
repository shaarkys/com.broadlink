"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const Communicate = require("../lib/Communicate");

const originalLoad = Module._load;
let BroadlinkDevice;
const devices = {};
try {
  Module._load = function (request, parent, isMain) {
    if (request === "homey") return {
      Device: class {
        async setWarning(message) { this.warnings.push(message); }
      },
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  BroadlinkDevice = require("../lib/BroadlinkDevice");
  for (const id of ["A1", "Dooya", "Hysen", "MP1", "RM3_mini", "RM4_mini", "RM4_pro", "RM_plus", "RM_pro", "SCB1E", "SP1", "SP2", "SP3S"]) {
    devices[id] = require(`../drivers/${id}/device`);
  }
} finally {
  Module._load = originalLoad;
}

function harness() {
  const device = new BroadlinkDevice();
  const timers = new Map();
  const capabilities = new Map([["device_lock_state", "unknown"]]);
  const settings = { ipAddress: "192.0.2.10", key: "11".repeat(16), id: "22".repeat(4) };
  let nextTimer = 0;
  Object.assign(device, {
    warnings: [], logs: [], errors: [], added: [],
    log: (...args) => device.logs.push(args.join(" ")),
    error: (...args) => device.errors.push(args),
    hasCapability: (id) => capabilities.has(id),
    addCapability: async (id) => { device.added.push(id); capabilities.set(id, null); },
    setCapabilityValue: async (id, value) => capabilities.set(id, value),
    homey: {
      setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
      clearTimeout: (id) => timers.delete(id),
      settings: { get: () => null },
      __: (key) => key === "errors.device_locked" ? "Device locked; unlock in the Broadlink app" : key,
    },
    getSettings: () => settings,
    getSetting: (key) => settings[key],
    getData: () => ({ mac: "102030405060", devtype: String(0x520b) }),
    getName: () => "Test device",
    _utils: {
      debugLog: (_source, ...args) => device.logs.push(args.join(" ")),
      hexToArr: (value) => Buffer.from(value, "hex"),
      arrToHex: (value) => Buffer.from(value).toString("hex"),
    },
  });
  async function runNext() {
    const [id, timer] = timers.entries().next().value;
    timers.delete(id);
    await timer.callback();
  }
  return { device, timers, settings, runNext, capabilities };
}

function discovery(isLocked, overrides = {}) {
  return {
    isLocked,
    ipAddress: "192.0.2.10",
    devtype: 0x520b,
    mac: Buffer.from("605040302010", "hex"),
    ...overrides,
  };
}

test("discovery parses explicit lock flags and treats missing/unrecognized flags as unknown", async () => {
  for (const [size, flag, expected] of [[128, 1, true], [128, 0, false], [64, undefined, null], [127, undefined, null], [128, 2, null]]) {
    const comm = new Communicate();
    comm.configure({ homey: { settings: { get: () => null } } });
    const reply = Buffer.alloc(size);
    reply.writeUInt16LE(0x5213, 0x34);
    Buffer.from("605040302010", "hex").copy(reply, 0x3a);
    if (flag !== undefined) reply[0x7f] = flag;
    comm.sendto = async (packet, address, port, timeout) => {
      assert.equal(packet[0x26], 6);
      assert.equal(address, "192.0.2.10");
      assert.equal(port, 80);
      assert.equal(timeout, 5);
      assert.deepEqual([...packet.slice(0x18, 0x1e)], [0, 0, 0, 0, 0, 0]);
      const checksum = (0xbeaf + packet.reduce((sum, value, index) => sum + ([0x20, 0x21].includes(index) ? 0 : value), 0)) & 0xffff;
      assert.equal(packet[0x20] | packet[0x21] << 8, checksum);
      return { address, data: reply };
    };
    const info = await comm.discover(5, "0.0.0.0", "192.0.2.10", 0);
    assert.equal(info.isLocked, expected);
    assert.equal(info.devtype, 0x5213);
    assert.equal(Buffer.from(info.mac).toString("hex"), "605040302010");
  }
});

test("truncated discovery cannot fabricate a device identity or lock state", async () => {
  const comm = new Communicate();
  comm.configure({ homey: {} });
  comm.sendto = async () => ({ data: Buffer.alloc(63) });
  await assert.rejects(comm.discover(5, "0.0.0.0", "192.0.2.10", 0), /Incomplete/);
});

test("lock checks use isolated unauthenticated communication and preserve other warnings", async (t) => {
  const { device, timers, runNext } = harness();
  const normalCommunication = { untouched: true };
  device._communicate = normalCommunication;
  const states = [true, null, false];
  t.mock.method(Communicate.prototype, "discover", async function (...args) {
    assert.notEqual(this, normalCommunication);
    assert.deepEqual(args, [5, "0.0.0.0", "192.0.2.10", 0]);
    assert.deepEqual([...this.id], [0, 0, 0, 0]);
    return discovery(states.shift());
  });
  device.startLockChecks();
  await runNext();
  assert.match(device.warnings.at(-1), /Device locked/);
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 60000);
  await device.setWarning("Learning RF");
  assert.match(device.warnings.at(-1), /Device locked.*\nLearning RF/);
  await device.unsetWarning();
  assert.match(device.warnings.at(-1), /^Device locked/);
  await runNext();
  assert.equal(device._broadlinkLocked, true);
  await device.setWarning("Sensor failure");
  await runNext();
  assert.equal(device._broadlinkLocked, false);
  assert.equal(device.warnings.at(-1), "Sensor failure");
  await device.unsetWarning();
  assert.equal(device.warnings.at(-1), null);
  assert.equal(device._communicate, normalCommunication);
  device.stopLockChecks();
  assert.equal(timers.size, 0);
});

test("timeouts and authentication errors never become lock evidence or clear a confirmed warning", async (t) => {
  const { device, runNext } = harness();
  let fail = true;
  t.mock.method(Communicate.prototype, "discover", async () => {
    if (fail) throw new Error("Authentication failed / UDP timeout");
    return discovery(true);
  });
  device.startLockChecks();
  await runNext();
  assert.equal(device.warnings.length, 0);
  fail = false;
  await runNext();
  fail = true;
  await runNext();
  assert.equal(device._broadlinkLocked, true);
  assert.match(device.warnings.at(-1), /Device locked/);
  assert.ok(device.logs.some((line) => line.includes("inconclusive")));
  device.stopLockChecks();
});

test("a different MAC, product type or reply IP cannot warn about the paired device", async (t) => {
  const { device, runNext } = harness();
  const mismatches = [{ mac: Buffer.alloc(6) }, { devtype: 0x5213 }, { ipAddress: "192.0.2.11" }];
  t.mock.method(Communicate.prototype, "discover", async () => discovery(true, mismatches.shift()));
  device.startLockChecks();
  for (let i = 0; i < 3; i++) await runNext();
  assert.equal(device.warnings.length, 0);
  assert.equal(device.logs.filter((line) => line.includes("identity")).length, 3);
  device.stopLockChecks();
});

test("IP settings changed during discovery discard the old reply", async (t) => {
  const { device, runNext, settings } = harness();
  t.mock.method(Communicate.prototype, "discover", async () => {
    settings.ipAddress = "192.0.2.11";
    return discovery(true);
  });
  device.startLockChecks();
  await runNext();
  assert.equal(device.warnings.length, 0);
  device.stopLockChecks();
});

test("checks wait for completion, and stopping cancels the socket and settles the pending request", async (t) => {
  const { device, timers, runNext } = harness();
  let closed = 0;
  t.mock.method(Communicate.prototype, "discover", function () {
    this.dgramSocket = { close: () => closed++ };
    return new Promise((_resolve, reject) => { this.callback = { reject }; });
  });
  device.startLockChecks();
  const pending = runNext();
  assert.equal(timers.size, 0);
  assert.ok(device._lockProbe);
  device.stopLockChecks();
  await pending;
  assert.equal(closed, 1);
  assert.equal(timers.size, 0);
  assert.equal(device.warnings.length, 0);
  assert.equal(device._lockProbe, null);
});

test("reinitialization replaces the monitor and ignores late replies from its predecessor", async (t) => {
  const { device, timers, runNext } = harness();
  let finish;
  t.mock.method(Communicate.prototype, "discover", () => new Promise((resolve) => { finish = resolve; }));
  device.startLockChecks();
  const old = runNext();
  device.startLockChecks();
  assert.equal(timers.size, 1);
  finish(discovery(true));
  await old;
  assert.equal(timers.size, 1);
  assert.equal(device.warnings.length, 0);
  device.onUninit();
  assert.equal(timers.size, 0);
});

test("all Broadlink drivers inherit detection, and overridden deletion handlers stop it", async () => {
  for (const [id, Device] of Object.entries(devices)) {
    assert.equal(typeof Device.prototype.startLockChecks, "function", id);
    let stopped = 0;
    const device = {
      stopLockChecks: () => stopped++,
      stop_check_interval() {},
      _utils: { debugLog() {} },
      _communicate: { destroy() {} },
      _operationQueue: Promise.resolve(),
      dataStore: { deleteAllCommands() {} },
      getData: () => ({ id: "test" }),
      homey: { clearTimeout() {} },
      log() {},
    };
    await Device.prototype.onDeleted.call(device);
    assert.equal(stopped, 1, `${id} deletion must stop lock checks`);
  }
});

test("base initialization starts detection for existing devices without changing their data/settings", async () => {
  const { device, timers, settings } = harness();
  const before = { ...settings };
  await device.onInit();
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 0);
  assert.deepEqual(settings, before);
  device.onUninit();
  assert.equal(timers.size, 0);
  device._communicate.destroy();
});

test("device lock is a read-only three-state sensor declared by every driver", () => {
  const capability = require("../.homeycompose/capabilities/device_lock_state.json");
  assert.equal(capability.type, "enum");
  assert.equal(capability.getable, true);
  assert.equal(capability.setable, false);
  assert.equal(capability.uiComponent, "sensor");
  assert.deepEqual(capability.values.map((value) => value.id), ["locked", "unlocked", "unknown"]);
  for (const id of Object.keys(devices)) {
    const manifest = require(`../drivers/${id}/driver.compose.json`);
    assert.equal(manifest.capabilities.filter((capabilityId) => capabilityId === "device_lock_state").length, 1, id);
  }
});

test("existing devices gain the lock capability once and start with unknown on reinitialization", async () => {
  const { device, capabilities } = harness();
  capabilities.clear();
  device.stopLockChecks();
  await device.initializeDeviceLockCapability(device._lockCheckGeneration);
  assert.deepEqual(device.added, ["device_lock_state"]);
  assert.equal(capabilities.get("device_lock_state"), "unknown");
  capabilities.set("device_lock_state", "locked");
  await device.initializeDeviceLockCapability(device._lockCheckGeneration);
  assert.deepEqual(device.added, ["device_lock_state"]);
  assert.equal(capabilities.get("device_lock_state"), "unknown");
  assert.ok(device.logs.some((line) => line.includes("migration completed")));
});

test("migration failure is logged and does not prevent initialization or lock checks", async (t) => {
  const { device, capabilities, timers, runNext } = harness();
  capabilities.clear();
  device.addCapability = async () => { throw new Error("Homey migration failed"); };
  await device.onInit();
  assert.equal(timers.size, 1);
  assert.equal(device.errors[0][1].message, "Homey migration failed");
  t.mock.method(Communicate.prototype, "discover", async () => discovery(true));
  await runNext();
  assert.match(device.warnings.at(-1), /Device locked/);
  device.onUninit();
  device._communicate.destroy();
});

test("normal logs and capability report every check without requiring debug logging", async (t) => {
  const { device, capabilities, runNext } = harness();
  device._utils.debugLog = () => {};
  const states = [true, true, null, false];
  t.mock.method(Communicate.prototype, "discover", async () => discovery(states.shift()));
  device.startLockChecks();
  for (const expected of ["locked", "locked", "unknown", "unlocked"]) {
    await runNext();
    assert.equal(capabilities.get("device_lock_state"), expected);
  }
  assert.equal(device.logs.filter((line) => line === "Broadlink device lock state: locked").length, 2);
  assert.ok(device.logs.some((line) => line.includes("unknown") && line.includes("last confirmed state: locked")));
  assert.ok(device.logs.includes("Broadlink device lock state: unlocked"));
  device.stopLockChecks();
});

test("timeouts publish unknown but preserve the last confirmed lock warning", async (t) => {
  const { device, capabilities, runNext } = harness();
  let fail = false;
  t.mock.method(Communicate.prototype, "discover", async () => {
    if (fail) throw new Error("UDP timeout");
    return discovery(true);
  });
  device.startLockChecks();
  await runNext();
  fail = true;
  await runNext();
  assert.equal(capabilities.get("device_lock_state"), "unknown");
  assert.match(device.warnings.at(-1), /Device locked/);
  assert.ok(device.logs.some((line) => line.includes("unknown") && line.includes("UDP timeout")));
  device.stopLockChecks();
});

test("a capability write failure is logged and cannot suppress the device warning", async (t) => {
  const { device, runNext } = harness();
  device.setCapabilityValue = async () => { throw new Error("capability write failed"); };
  t.mock.method(Communicate.prototype, "discover", async () => discovery(true));
  device.startLockChecks();
  await runNext();
  await runNext();
  assert.equal(device.errors.length, 2);
  assert.equal(device.errors[0][1].message, "capability write failed");
  assert.match(device.warnings.at(-1), /Device locked/);
  device.stopLockChecks();
});

test("stopping during capability migration prevents a late reset or timer restart", async () => {
  const { device, capabilities, timers } = harness();
  capabilities.clear();
  let finish;
  device.addCapability = () => new Promise((resolve) => { finish = resolve; });
  const initializing = device.onInit();
  while (!finish) await Promise.resolve();
  device.onUninit();
  finish();
  await initializing;
  assert.equal(timers.size, 0);
  assert.equal(capabilities.has("device_lock_state"), false);
  device._communicate.destroy();
});
