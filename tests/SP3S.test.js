"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const crypto = require("node:crypto");
const Communicate = require("../lib/Communicate");
const BroadlinkUtils = require("../lib/BroadlinkUtils");
const originalLoad = Module._load;
let SP2Device;
let SP3SDevice;
try {
  Module._load = function (request, parent, isMain) {
    if (request === "homey") return { Device: class {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  SP2Device = require("../drivers/SP2/device");
  SP3SDevice = require("../drivers/SP3S/device");
} finally {
  Module._load = originalLoad;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function expired() {
  return Object.assign(new Error("Control key expired"), { code: -7 });
}

function harness(t, Device = SP3SDevice) {
  const device = new Device();
  const logs = [];
  const errors = [];
  const values = new Map([["onoff.power", false], ["onoff.nightlight", true], ["measure_power", 12]]);
  const settings = { ipAddress: "192.0.2.12", key: "11".repeat(16), id: "01000000", CheckInterval: 5 };
  const timers = new Map();
  const events = [];
  let timerId = 0;
  const communication = new Communicate();
  const homey = {
    __: (key) => key,
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  t.mock.method(BroadlinkUtils.prototype, "debugLog", (_source, ...args) => logs.push(args.join(" ")));
  communication.configure({ homey, deviceType: 0x8010, ipAddress: settings.ipAddress, count: 0, mac: new Uint8Array(6) });
  communication.read_status = async () => new Uint8Array([2]);
  communication.setPowerState = async (level) => events.push(["write", level]);
  communication.sp2_get_energy = async () => new Uint8Array([0, 0x50, 0x12, 0, 0]);
  communication.auth = async () => {
    events.push(["auth", communication.deviceType]);
    communication.key = new Uint8Array(16).fill(0x33);
    communication.id = new Uint8Array([1, 2, 3, 4]);
    return { key: communication.key, id: communication.id };
  };
  communication.destroy = () => events.push(["destroy"]);
  Object.assign(device, {
    homey,
    _communicate: communication,
    _authenticated: true,
    _operationQueue: Promise.resolve(),
    _deleted: false,
    log: (...args) => logs.push(args.join(" ")),
    error: (...args) => errors.push(args),
    getData: () => ({ devtype: "32784", mac: "102030405060" }),
    getName: () => "Test SP3S",
    getSettings: () => settings,
    setSettings: async (patch) => { events.push(["settings", Object.keys(patch)]); Object.assign(settings, patch); },
    getCapabilityValue: (id) => values.get(id),
    setCapabilityValue: async (id, value) => { events.push(["value", id, value]); values.set(id, value); },
    hasCapability: (id) => values.has(id),
    addCapability: async (id) => values.set(id, null),
    registerCapabilityListener() {},
    initializeDeviceLockCapability: async () => {},
    startLockChecks() {},
    stopLockChecks: () => events.push(["stopLocks"]),
    generate_trigger_power: (mode) => events.push(["powerTrigger", mode]),
    generate_trigger_nightlight: (mode) => events.push(["nightlightTrigger", mode]),
  });
  return { device, communication, logs, errors, values, settings, timers, events };
}

function encryptedReply(comm, plaintext) {
  const padded = Buffer.alloc(Math.ceil(plaintext.length / 16) * 16);
  Buffer.from(plaintext).copy(padded);
  const cipher = crypto.createCipheriv("aes-128-cbc", comm.key, comm.iv);
  cipher.setAutoPadding(false);
  return { data: Buffer.concat([Buffer.alloc(0x38), cipher.update(padded), cipher.final()]) };
}

test("reported 56-byte expired-key response retains a useful signed error for all plug commands", async (t) => {
  const { communication } = harness(t);
  // Header from the report, with the customer MAC removed. There is no encrypted payload.
  const data = Buffer.from("5aa5aa555aa5aa550000000000000000000000000000000000000000000000006accf9ff1080ee03a2c600000000000000000000e9bf0000", "hex");
  assert.equal(data.length, 0x38);
  communication.sendto = async () => ({ data });
  for (const method of ["read_status", "sp2_get_energy", "setPowerState"]) {
    await assert.rejects(Communicate.prototype[method].call(communication, 1), (err) => err.code === -7 && /control key expired/.test(err.message));
  }
  communication.sendto = async () => ({ data: Buffer.from(data) });
  data.writeUInt16LE(0xfffc, 0x22);
  await assert.rejects(Communicate.prototype.setPowerState.call(communication, 1), (err) => err.code === -4);
});

test("plug status rejects empty success payloads and keeps transport failure details", async (t) => {
  const { communication } = harness(t);
  communication.send_packet = async () => ({ error: 0, payload: [] });
  await assert.rejects(Communicate.prototype.read_status.call(communication), /invalid_response/);
  communication.send_packet = async () => ({ error: -1, message: "UDP timeout" });
  await assert.rejects(Communicate.prototype.read_status.call(communication), /UDP timeout/);
});

test("expired status authenticates with raw 0x8010, saves session, retries, then acknowledges ON", async (t) => {
  const { device, communication, events, settings, values, logs } = harness(t);
  let reads = 0;
  communication.read_status = async () => {
    events.push(["read"]);
    if (++reads === 1) throw expired();
    return new Uint8Array([2]);
  };
  const persist = deferred();
  device.setSettings = async (patch) => { events.push(["saving"]); await persist.promise; Object.assign(settings, patch); };
  const pending = device.onCapabilityPowerOnOff(true);
  while (!events.some(([event]) => event === "saving")) await Promise.resolve();
  assert.equal(reads, 1);
  assert.equal(values.get("onoff.power"), false);
  persist.resolve();
  await pending;
  assert.deepEqual(events.filter(([event]) => ["read", "auth", "write"].includes(event)), [["read"], ["auth", 0x8010], ["read"], ["write", 3]]);
  assert.equal(settings.key, "33".repeat(16));
  assert.equal(settings.id, "01020304");
  assert.equal(values.get("onoff.power"), true);
  assert.ok(logs.some((line) => line.includes("retrying once")));
  assert.ok(logs.every((line) => !line.includes(settings.key)));
});

test("a second expired response rejects once without state updates or success triggers", async (t) => {
  const { device, communication, values, events } = harness(t);
  communication.setPowerState = async () => { events.push(["rejectedWrite"]); throw expired(); };
  await assert.rejects(device.do_action_power_on(), (err) => err.code === -7);
  assert.equal(events.filter(([event]) => event === "auth").length, 1);
  assert.equal(events.filter(([event]) => event === "rejectedWrite").length, 2);
  assert.equal(events.some(([event]) => event === "powerTrigger"), false);
  assert.equal(values.get("onoff.power"), false);
});

test("unsupported commands and status errors reject without authentication or unsafe writes", async (t) => {
  const { device, communication, events } = harness(t);
  communication.read_status = async () => { throw Object.assign(new Error("Unsupported command"), { code: -4 }); };
  await assert.rejects(device.onCapabilityPowerOnOff(true), /Unsupported command/);
  await assert.rejects(device.do_action_nightlight_off(), /Unsupported command/);
  await assert.rejects(device.check_condition_power_on(), /Unsupported command/);
  assert.equal(events.some(([event]) => ["auth", "write", "value"].includes(event)), false);
});

test("polls coalesce and commands wait for authentication and the single outstanding transport request", async (t) => {
  const { device, communication, events, logs } = harness(t);
  const gate = deferred();
  let reads = 0;
  communication.read_status = async () => { reads++; await gate.promise; return new Uint8Array([2]); };
  const poll = device.onCheckInterval();
  assert.equal(device.onCheckInterval(), poll);
  assert.ok(logs.some((line) => line.includes("polling skipped")));
  const write = device.onCapabilityPowerOnOff(true);
  await Promise.resolve();
  assert.equal(reads, 1);
  assert.equal(events.some(([event]) => event === "write"), false);
  gate.resolve();
  await Promise.all([poll, write]);
  assert.equal(reads, 2);
  assert.equal(events.filter(([event]) => event === "write").length, 1);
});

test("energy failure preserves its previous value while switch-state polling continues", async (t) => {
  const { device, communication, values, errors } = harness(t);
  communication.read_status = async () => new Uint8Array([1]);
  communication.sp2_get_energy = async () => { throw new Error("Energy unavailable"); };
  await device.onCheckInterval();
  assert.equal(values.get("onoff.power"), true);
  assert.equal(values.get("onoff.nightlight"), false);
  assert.equal(values.get("measure_power"), 12);
  assert.match(errors[0][1].message, /Energy unavailable/);
  await assert.rejects(device.get_energy(), /Energy unavailable/);
});

test("manual authentication uses newly submitted IP and waits for errors; false toggle does nothing", async (t) => {
  const { device, communication, settings, timers, events } = harness(t);
  await device.onSettings({ newSettings: { ...settings, ipAddress: "192.0.2.13", Authenticate: true }, changedKeys: ["Authenticate", "ipAddress"] });
  assert.equal(communication.ipAddress, "192.0.2.13");
  assert.equal(communication.deviceType, 0x8010);
  assert.equal(settings.id, "01020304");
  assert.equal(timers.size, 1);
  const timer = [...timers.values()][0];
  await timer.callback();
  assert.equal(settings.Authenticate, false);
  await device.onSettings({ newSettings: { ...settings, Authenticate: false }, changedKeys: ["Authenticate"] });
  assert.equal(events.filter(([event]) => event === "auth").length, 1);
  communication.auth = async () => { throw new Error("Authentication rejected"); };
  await assert.rejects(device.onSettings({ newSettings: { Authenticate: true }, changedKeys: ["Authenticate"] }), /Authentication rejected/);
});

test("newly paired plugs authenticate once and failed persistence prevents a command", async (t) => {
  const { device, communication, events } = harness(t, SP2Device);
  device._authenticated = false;
  await device.onAdded();
  await device.onAdded();
  assert.equal(events.filter(([event]) => event === "auth").length, 1);
  device._authenticated = false;
  device.setSettings = async () => { throw new Error("Cannot save session"); };
  await assert.rejects(device.onCapabilityPowerOnOff(true), /Cannot save session/);
  assert.equal(events.some(([event]) => event === "write"), false);
  communication.auth = async () => ({ id: [], key: [] });
  await assert.rejects(device.onAdded(), /Invalid SP2\/SP3S authentication session/);
});

test("nightlight writes preserve the relay and failed commands do not poison the queue", async (t) => {
  const { device, communication, events, values } = harness(t);
  communication.setPowerState = async () => { throw new Error("Write failed"); };
  await assert.rejects(device.onCapabilityNightLightOnOff(false), /Write failed/);
  assert.equal(values.get("onoff.nightlight"), true);
  communication.read_status = async () => new Uint8Array([3]);
  communication.setPowerState = async (level) => events.push(["write", level]);
  assert.equal(await device.do_action_nightlight_off(), true);
  assert.deepEqual(events.find(([event]) => event === "write"), ["write", 1]);
  assert.equal(values.get("onoff.nightlight"), false);
});

test("deletion waits for a bounded request, rejects queued writes and prevents late updates", async (t) => {
  const { device, communication, events, values, timers } = harness(t);
  const gate = deferred();
  communication.read_status = async () => { await gate.promise; return new Uint8Array([1]); };
  device.start_check_interval(5);
  const poll = device.onCheckInterval();
  await Promise.resolve();
  const write = device.onCapabilityPowerOnOff(true);
  const rejected = assert.rejects(write, /stopped/);
  const stopping = device.onDeleted();
  assert.equal(timers.size, 0);
  assert.equal(events.some(([event]) => event === "destroy"), false);
  gate.resolve();
  await Promise.all([poll, stopping, rejected]);
  assert.equal(values.get("onoff.power"), false);
  assert.equal(events.some(([event]) => event === "write"), false);
  assert.equal(events.filter(([event]) => event === "destroy").length, 1);
});

test("polling schedules only after completion and settings replace the one timer", async (t) => {
  const { device, communication, timers, settings, logs } = harness(t);
  const gate = deferred();
  communication.read_status = async () => { await gate.promise; return new Uint8Array([2]); };
  device.start_check_interval(5);
  const [id, timer] = timers.entries().next().value;
  timers.delete(id);
  const running = timer.callback();
  assert.equal(timers.size, 0);
  device.start_check_interval(6);
  gate.resolve();
  await running;
  assert.equal(timers.size, 1);
  await device.onSettings({ newSettings: { ...settings, CheckInterval: 10 }, changedKeys: ["CheckInterval"] });
  assert.equal(timers.size, 1);
  for (const interval of [0, -1, NaN, Infinity, 3601]) assert.throws(() => device.start_check_interval(interval), /between 1 and 3600/);
  assert.equal(timers.size, 1);
  await device.onUninit();
  assert.equal(timers.size, 0);
  for (const state of ["started", "replaced", "cancelled"]) {
    assert.ok(logs.some((line) => line.includes(`polling ${state}`)), state);
  }
});

test("authentication wire packet keeps 0x8010 and retries use the refreshed session", async (t) => {
  const { device, communication, settings } = harness(t);
  const session = Buffer.from("01020304" + "33".repeat(16), "hex");
  let commands = 0;
  communication.auth = Communicate.prototype.auth;
  communication.read_status = Communicate.prototype.read_status;
  communication.setPowerState = Communicate.prototype.setPowerState;
  communication.sendto = async (packet) => {
    assert.equal(Buffer.from(packet).readUInt16LE(0x24), 0x8010);
    if (packet[0x26] === 0x65) return encryptedReply(communication, session);
    if (++commands === 1) {
      const data = Buffer.alloc(0x38);
      data.writeUInt16LE(0xfff9, 0x22);
      return { data };
    }
    assert.equal(Buffer.from(packet).subarray(0x30, 0x34).toString("hex"), "01020304");
    return encryptedReply(communication, Buffer.from([1, 0, 0, 0, 2]));
  };
  await device.onCapabilityPowerOnOff(true);
  assert.equal(commands, 3);
  assert.equal(settings.id, "01020304");
});

test("reinitialization replaces the connection and timer while retaining decimal device type", async (t) => {
  const { device, timers, settings, events } = harness(t);
  await device.onInit();
  assert.equal(timers.size, 1);
  const first = device._communicate;
  assert.equal(Number(first.deviceType), 0x8010);
  assert.equal(device._authenticated, true);
  await device.onInit();
  assert.notEqual(device._communicate, first);
  assert.equal(timers.size, 1);
  assert.equal(Number(device._communicate.deviceType), 0x8010);
  assert.equal(settings.key, "11".repeat(16));
  assert.equal(events.filter(([event]) => event === "auth").length, 0);
  await device.onUninit();
  assert.equal(timers.size, 0);
});

test("stopping during authentication prevents session persistence, commands and delayed setting resets", async (t) => {
  const { device, communication, timers, events } = harness(t);
  const gate = deferred();
  communication.auth = async () => { await gate.promise; return { key: new Uint8Array(16), id: new Uint8Array(4) }; };
  const pending = device.onSettings({ newSettings: { Authenticate: true }, changedKeys: ["Authenticate"] });
  const rejected = assert.rejects(pending, /stopped/);
  await Promise.resolve();
  const stopping = device.onUninit();
  gate.resolve();
  await Promise.all([rejected, stopping]);
  assert.equal(timers.size, 0);
  assert.equal(events.some(([event]) => ["settings", "write"].includes(event)), false);
});

test("energy-only key expiry recovers once without reporting a fabricated zero reading", async (t) => {
  const { device, communication, events, values } = harness(t);
  let attempts = 0;
  communication.sp2_get_energy = async () => {
    if (++attempts === 1) throw expired();
    return new Uint8Array([0, 0x50, 0x12, 0, 0]);
  };
  await device.onCheckInterval();
  assert.equal(attempts, 2);
  assert.equal(events.filter(([event]) => event === "auth").length, 1);
  assert.equal(values.get("measure_power"), 12.5);
});

test("stopping while a command reads status prevents the subsequent relay write", async (t) => {
  const { device, communication, events } = harness(t);
  const gate = deferred();
  communication.read_status = async () => { await gate.promise; return new Uint8Array([2]); };
  const pending = device.onCapabilityPowerOnOff(true);
  const rejected = assert.rejects(pending, /stopped/);
  await Promise.resolve();
  const stopping = device.onUninit();
  gate.resolve();
  await Promise.all([rejected, stopping]);
  assert.equal(events.some(([event]) => event === "write"), false);
});
