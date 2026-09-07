"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const crypto = require("node:crypto");
const { getVariant, encode, decode } = require("../lib/BroadlinkSP4");
const { BroadlinkType, devType2Info } = require("../lib/DeviceInfo");
const BroadlinkUtils = require("../lib/BroadlinkUtils");
const Communicate = require("../lib/Communicate");
const fixtures = require("./fixtures/scb1e.json");

const originalLoad = Module._load;
let SCB1EDevice;
let SCB1EDriver;
try {
  Module._load = function loadWithHomeyStub(request, parent, isMain) {
    if (request === "homey") return { Device: class {}, Driver: class {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  SCB1EDevice = require("../drivers/SCB1E/device");
  SCB1EDriver = require("../drivers/SCB1E/driver");
} finally {
  Module._load = originalLoad;
}

function response(variant) {
  return { error: 0, decryptedPayload: Buffer.from(fixtures[variant].response, "hex") };
}

function jsonResponse(variant, json) {
  const header = variant === "SP4" ? 12 : 14;
  const data = Buffer.from(json);
  const payload = Buffer.alloc(header + data.length);
  payload.writeUInt32LE(data.length, header - 4);
  data.copy(payload, header);
  return { error: 0, decryptedPayload: payload };
}

for (const [deviceType, variant] of [[0xa56b, "SP4"], [0x5115, "SP4B"], [0x6113, "SP4B"]]) {
  test(`SCB1E 0x${deviceType.toString(16)} discovery and protocol selection`, () => {
    assert.equal(devType2Info(deviceType).type, BroadlinkType.SCB1E);
    assert.equal(devType2Info(deviceType).name, "SCB1E");
    for (const raw of [deviceType, String(deviceType), `0x${deviceType.toString(16)}`]) {
      assert.equal(getVariant(raw), variant);
    }
    const utils = new BroadlinkUtils({ settings: { get: () => null } });
    utils.debugLog = () => {};
    assert.equal(utils.getDeviceInfo(deviceType, BroadlinkType.SCB1E).isCompatible, true);
    assert.equal(utils.getDeviceInfo(deviceType, BroadlinkType.SP2).isCompatible, false);
    assert.equal(utils.getDeviceInfo(deviceType, BroadlinkType.SP3plus).isCompatible, false);
    const driver = new SCB1EDriver();
    driver.onInit();
    assert.equal(driver.CompatibilityID, BroadlinkType.SCB1E);
  });

  test(`SCB1E 0x${deviceType.toString(16)} communication uses SP4/SP4B through 0x6A`, async () => {
    const comm = new Communicate();
    comm.deviceType = String(deviceType);
    const requests = [];
    comm.send_packet = async (command, version, packet) => {
      requests.push([command, version, packet.toString("hex")]);
      return response(variant);
    };
    assert.deepEqual(await comm.scb1e_get_state(), fixtures[variant].state);
    assert.deepEqual(await comm.scb1e_set_power(true), fixtures[variant].rawState);
    await comm.scb1e_set_power(false);
    assert.deepEqual(requests, [
      [0x6a, false, fixtures[variant].get],
      [0x6a, false, fixtures[variant].on],
      [0x6a, false, fixtures[variant].off],
    ]);
    await assert.rejects(comm.scb1e_set_power("on"), /boolean/);
    comm.send_packet = async () => ({ error: 0xfff9 });
    await assert.rejects(comm.scb1e_get_state(), /response error 65529/);
    await assert.rejects(comm.scb1e_set_power(true), /response error 65529/);
  });
}

for (const variant of ["SP4", "SP4B"]) {
  test(`${variant} requests match independently generated upstream fixtures`, () => {
    assert.equal(encode(variant, 1, {}).toString("hex"), fixtures[variant].get);
    assert.equal(encode(variant, 2, { pwr: 1 }).toString("hex"), fixtures[variant].on);
    assert.equal(encode(variant, 2, { pwr: 0 }).toString("hex"), fixtures[variant].off);
  });

  test(`${variant} response decoding accepts AES padding and preserves raw set-state values`, () => {
    const reply = response(variant);
    reply.decryptedPayload = Buffer.concat([reply.decryptedPayload, Buffer.alloc(16)]);
    assert.deepEqual(decode(variant, reply), fixtures[variant].rawState);
    assert.deepEqual(decode(variant, reply, true), fixtures[variant].state);
    assert.deepEqual(decode(variant, jsonResponse(variant, "{}")), {});
  });

  test(`${variant} rejects malformed replies without exposing response content`, () => {
    assert.throws(() => decode(variant), /response error missing/);
    assert.throws(() => decode(variant, { error: -1, message: "UDP timeout" }), /UDP timeout/);
    assert.throws(() => decode(variant, { error: 0 }), /no decrypted payload/);
    assert.throws(() => decode(variant, { error: 0, decryptedPayload: Buffer.alloc(5) }), /header is truncated/);
    const truncated = response(variant);
    truncated.decryptedPayload = truncated.decryptedPayload.subarray(0, -1);
    assert.throws(() => decode(variant, truncated), /JSON length is invalid/);
    const badLength = response(variant);
    badLength.decryptedPayload.writeUInt32LE(0xffffffff, variant === "SP4" ? 8 : 10);
    assert.throws(() => decode(variant, badLength), /JSON length is invalid/);
    assert.throws(() => decode(variant, jsonResponse(variant, "")), /JSON length is invalid/);
    assert.throws(() => decode(variant, jsonResponse(variant, "private-response-content")), { message: `${variant} response contains invalid JSON` });
    for (const json of ["[]", "null", "42", '"text"']) {
      assert.throws(() => decode(variant, jsonResponse(variant, json)), /state must be an object/);
    }
    assert.throws(() => decode(variant, jsonResponse(variant, '{"pwr":"off"}')), /invalid pwr/);
    for (const field of ["current", "volt", "power", "totalconsum", "overload"]) {
      for (const value of ["null", '"1234"', "1e999", "true"]) {
        assert.throws(() => decode(variant, jsonResponse(variant, `{"${field}":${value}}`), true), new RegExp(`invalid ${field}`));
      }
    }
  });
}

test("SP4B divides all five sensor fields by 1000 and removes unsupported/missing fields", () => {
  assert.deepEqual(decode("SP4B", response("SP4B"), true), fixtures.SP4B.state);
  for (const field of ["current", "volt", "power", "totalconsum", "overload"]) {
    assert.deepEqual(decode("SP4B", jsonResponse("SP4B", JSON.stringify({ [field]: -1 })), true), {});
    assert.deepEqual(decode("SP4B", jsonResponse("SP4B", JSON.stringify({ [field]: 0 })), true), { [field]: 0 });
  }
  assert.deepEqual(decode("SP4B", jsonResponse("SP4B", '{"pwr":0,"ntlight":1}'), true), { pwr: 0, ntlight: 1 });
  assert.deepEqual(decode("SP4", response("SP4"), true), fixtures.SP4.rawState);
});

test("existing device families retain their discovery mappings", () => {
  for (const [id, type] of [[0, "SP1"], [0x2711, "SP2"], [0x7530, "SP2"], [0x9479, "SP3plus"], [0x947a, "SP3plus"], [0x2737, "RM"], [0x520b, "RM4Pro"], [0x4eb5, "MP1"]]) {
    assert.equal(devType2Info(id).type, BroadlinkType[type]);
    assert.throws(() => getVariant(id), /Unsupported SCB1E/);
  }
});

function communicateHarness() {
  const comm = new Communicate();
  comm.configure({ homey: {}, deviceType: 0xa56b, count: 0, mac: new Uint8Array(6) });
  const logs = [];
  comm._utils.debugLog = (...args) => logs.push(args.slice(1).join(" "));
  return { comm, logs };
}

function encryptedReply(comm, plaintext, error = 0) {
  const padded = Buffer.alloc(Math.ceil(plaintext.length / 16) * 16);
  Buffer.from(plaintext).copy(padded);
  const cipher = crypto.createCipheriv("aes-128-cbc", comm.key, comm.iv);
  cipher.setAutoPadding(false);
  const data = Buffer.concat([Buffer.alloc(0x38), cipher.update(padded), cipher.final()]);
  data.writeUInt16LE(error, 0x22);
  return { data };
}

test("send_packet preserves legacy cmd/payload semantics and adds the full decrypted frame", async () => {
  const { comm } = communicateHarness();
  const plaintext = Buffer.from(fixtures.SP4.response, "hex");
  comm.sendto = async (packet) => {
    assert.equal(packet[0x24], 0x6b);
    assert.equal(packet[0x25], 0xa5);
    assert.equal(packet[0x26], 0x6a);
    return encryptedReply(comm, plaintext);
  };
  const result = await comm.send_packet(0x6a, false, encode("SP4", 1, {}));
  assert.equal(result.error, 0);
  assert.deepEqual(result.cmd, result.decryptedPayload.slice(0, 4));
  assert.deepEqual(result.payload, result.decryptedPayload.slice(4));
  assert.deepEqual(Buffer.from(result.decryptedPayload).subarray(0, plaintext.length), plaintext);
  assert.deepEqual(decode("SP4", result, true), fixtures.SP4.state);
  comm.sendto = async () => encryptedReply(comm, plaintext, 0xfff9);
  const failure = await comm.send_packet(0x6a, false, encode("SP4", 1, {}));
  assert.equal(failure.error, 0xfff9);
  assert.equal(failure.payload, undefined);
  assert.equal(failure.cmd, undefined);
});

test("authentication still extracts the session but never logs its response or key", async () => {
  const { comm, logs } = communicateHarness();
  const session = Buffer.from("102030405566778899aabbccddeeff0011223344", "hex");
  comm.sendto = async () => encryptedReply(comm, session);
  const auth = await comm.auth();
  assert.deepEqual(Buffer.from(auth.id), session.subarray(0, 4));
  assert.deepEqual(Buffer.from(auth.key), session.subarray(4));
  assert.ok(logs.some((line) => line.includes("authentication succeeded")));
  assert.ok(logs.every((line) => !line.includes("response=") && !line.includes("resp ") && !line.includes("key:") && !line.includes("55,66,77,88")));
});

function deviceHarness() {
  const device = new SCB1EDevice();
  const values = new Map();
  const logs = [];
  const errors = [];
  const timers = new Map();
  const settings = { ipAddress: "192.0.2.10", CheckInterval: 1, key: "11".repeat(16), id: "22".repeat(4) };
  let timerId = 0;
  Object.assign(device, {
    _operationQueue: Promise.resolve(),
    _authenticated: true,
    _variant: "SP4B",
    _deleted: false,
    _utils: { hexToArr: (value) => Buffer.from(value, "hex"), arrToHex: (value) => Buffer.from(value).toString("hex"), debugLog: () => {} },
    homey: {
      setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
      clearTimeout: (id) => timers.delete(id),
    },
    getSettings: () => settings,
    getSetting: (key) => settings[key],
    getData: () => ({ devtype: String(0x5115), mac: "102030405060", name: "SCB1E" }),
    getName: () => "SCB1E",
    setSettings: async (patch) => Object.assign(settings, patch),
    setCapabilityValue: async (capability, value) => values.set(capability, value),
    registerCapabilityListener: (capability, listener) => { device.listener = listener; },
    log: (...args) => logs.push(args),
    error: (...args) => errors.push(args),
    _communicate: { scb1e_get_state: async () => fixtures.SP4B.state, destroy: () => {} },
  });
  return { device, values, logs, errors, timers, settings };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("one poll updates all capabilities; missing readings and failures keep last values", async () => {
  const { device, values, errors } = deviceHarness();
  let reads = 0;
  device._communicate.scb1e_get_state = async () => { reads++; return fixtures.SP4B.state; };
  await device.onCheckInterval();
  assert.equal(reads, 1);
  assert.deepEqual(Object.fromEntries(values), { onoff: true, measure_power: 284.437, meter_power: 12.345, measure_voltage: 230.5, measure_current: 1.234 });
  device._communicate.scb1e_get_state = async () => ({ pwr: 0, power: 0 });
  await device.onCheckInterval();
  assert.equal(values.get("onoff"), false);
  assert.equal(values.get("measure_power"), 0);
  assert.equal(values.get("meter_power"), 12.345);
  const previous = new Map(values);
  device._communicate.scb1e_get_state = async () => { throw new Error("UDP timeout"); };
  await device.onCheckInterval();
  assert.deepEqual(values, previous);
  assert.equal(errors.length, 1);
  device._communicate.scb1e_get_state = async () => fixtures.SP4B.state;
  await device.onCheckInterval();
  assert.equal(values.get("onoff"), true);
});

test("polls coalesce and relay commands wait for the outstanding state request", async () => {
  const { device, values } = deviceHarness();
  const gate = deferred();
  const events = [];
  device._communicate.scb1e_get_state = async () => {
    events.push("read");
    if (events.length === 1) await gate.promise;
    return { pwr: 1 };
  };
  device._communicate.scb1e_set_power = async () => { events.push("write"); return {}; };
  const first = device.onCheckInterval();
  assert.equal(device.onCheckInterval(), first);
  const write = device.onCapabilityOnoff(true);
  await new Promise(setImmediate);
  assert.deepEqual(events, ["read"]);
  gate.resolve();
  await Promise.all([first, write]);
  assert.deepEqual(events, ["read", "write", "read"]);
  assert.equal(values.get("onoff"), true);
});

test("failed relay writes reject without optimistic updates; failed refresh does not reject a successful write", async () => {
  const { device, values } = deviceHarness();
  values.set("onoff", false);
  device._communicate.scb1e_set_power = async () => { throw new Error("protocol error"); };
  await assert.rejects(device.onCapabilityOnoff(true), /protocol error/);
  assert.equal(values.get("onoff"), false);
  device._communicate.scb1e_set_power = async () => ({ pwr: 0 });
  await assert.rejects(device.onCapabilityOnoff(true), /does not match/);
  device._communicate.scb1e_set_power = async () => ({});
  device._communicate.scb1e_get_state = async () => { throw new Error("UDP timeout"); };
  await device.onCapabilityOnoff(true);
  assert.equal(values.get("onoff"), true);
});

test("poll timers reschedule only after completion and settings changes replace the schedule", async () => {
  const { device, timers } = deviceHarness();
  const gate = deferred();
  device._communicate.scb1e_get_state = async () => { await gate.promise; return {}; };
  device.start_check_interval(1);
  const [id, timer] = [...timers][0];
  timers.delete(id);
  const polling = timer.callback();
  await new Promise(setImmediate);
  assert.equal(timers.size, 0);
  device.start_check_interval(2);
  gate.resolve();
  await polling;
  assert.equal(timers.size, 1);
  const [newId, newTimer] = [...timers][0];
  timers.delete(newId);
  await newTimer.callback();
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 120000);
  device.stop_check_interval();
  assert.equal(timers.size, 0);
});

test("deletion waits for active requests, prevents late updates and rejects queued commands", async () => {
  const { device, values, timers } = deviceHarness();
  const gate = deferred();
  let destroyed = false;
  let writes = 0;
  device._communicate.scb1e_get_state = async () => { await gate.promise; return { pwr: 1 }; };
  device._communicate.scb1e_set_power = async () => { writes++; return {}; };
  device._communicate.destroy = () => { destroyed = true; };
  device.start_check_interval(1);
  const polling = device.onCheckInterval();
  await new Promise(setImmediate);
  const write = device.onCapabilityOnoff(true);
  const rejected = assert.rejects(write, /deleted/);
  const deleting = device.onDeleted();
  assert.equal(destroyed, false);
  assert.equal(timers.size, 0);
  gate.resolve();
  await Promise.all([polling, rejected, deleting]);
  assert.equal(destroyed, true);
  assert.equal(writes, 0);
  assert.equal(values.size, 0);
});

test("re-authentication is serialized and uses new IP and the decimal discovery type", async () => {
  const { device, timers } = deviceHarness();
  const gate = deferred();
  const events = [];
  device._communicate.ipAddress = "192.0.2.10";
  device._communicate.scb1e_get_state = async () => { events.push("read"); await gate.promise; return {}; };
  device._communicate.setIPaddress = (address) => { device._communicate.ipAddress = address; events.push("ip"); };
  device._communicate.configure = (options) => {
    assert.equal(options.ipAddress, "192.0.2.11");
    assert.equal(options.deviceType, 0x5115);
    assert.equal(options.key, null);
    events.push("configure");
  };
  device._communicate.auth = async () => { events.push("auth"); return { key: Buffer.alloc(16), id: Buffer.alloc(4) }; };
  const poll = device.onCheckInterval();
  const change = device.onSettings({ newSettings: { ipAddress: "192.0.2.11", Authenticate: true }, changedKeys: ["ipAddress", "Authenticate"] });
  await new Promise(setImmediate);
  assert.deepEqual(events, ["read"]);
  gate.resolve();
  await Promise.all([poll, change]);
  assert.deepEqual(events, ["read", "ip", "configure", "auth"]);
  assert.equal(device._authenticated, true);
  assert.equal(timers.size, 1);
  await device.onDeleted();
  assert.equal(timers.size, 0);
});

test("first poll authenticates once for a newly paired device and retries after auth failure", async () => {
  const { device } = deviceHarness();
  device._authenticated = false;
  let authentications = 0;
  device._communicate.configure = () => {};
  device._communicate.auth = async () => {
    authentications++;
    if (authentications === 1) throw new Error("auth timeout");
    return { key: Buffer.alloc(16), id: Buffer.alloc(4) };
  };
  await device.onAdded();
  assert.equal(device._authenticated, false);
  await device.onCheckInterval();
  await device.onCheckInterval();
  assert.equal(authentications, 2);
  assert.equal(device._authenticated, true);
});

test("SCB1E declares standard capabilities and preserves its pairing templates", () => {
  const manifest = require("../drivers/SCB1E/driver.compose.json");
  assert.equal(manifest.class, "socket");
  assert.deepEqual(manifest.capabilities, ["onoff", "measure_power", "meter_power", "measure_voltage", "measure_current"]);
  assert.deepEqual(manifest.pair.map((view) => view.id), ["start", "list_devices", "add_devices"]);
});

test("initialization retains the raw type and repeated initialization replaces the timer and communication", async () => {
  for (const [raw, variant] of [[0xa56b, "SP4"], [0x5115, "SP4B"], [0x6113, "SP4B"]]) {
    const { device, timers } = deviceHarness();
    device.getData = () => ({ devtype: String(raw), mac: "102030405060", name: "SCB1E" });
    await device.onInit();
    assert.equal(device._variant, variant);
    assert.equal(Number(device._communicate.deviceType), raw);
    assert.equal(device._authenticated, true);
    assert.equal(typeof device.listener, "function");
    assert.equal(timers.size, 1);
    const original = device._communicate;
    await device.onInit();
    assert.notEqual(device._communicate, original);
    assert.equal(timers.size, 1);
    await device.onDeleted();
    assert.equal(timers.size, 0);
  }
});

test("deletion during re-authentication leaves no delayed settings update or timer", async () => {
  const { device, timers, settings } = deviceHarness();
  const gate = deferred();
  device._communicate.configure = () => {};
  device._communicate.auth = async () => { await gate.promise; return { key: Buffer.alloc(16), id: Buffer.alloc(4) }; };
  const change = device.onSettings({ newSettings: { Authenticate: true }, changedKeys: ["Authenticate"] });
  await new Promise(setImmediate);
  const deleting = device.onDeleted();
  gate.resolve();
  await Promise.all([change, deleting]);
  assert.equal(settings.key, "11".repeat(16));
  assert.equal(timers.size, 0);
});

test("deletion during capability update prevents subsequent measurement writes", async () => {
  const { device } = deviceHarness();
  const gate = deferred();
  const updates = [];
  device.setCapabilityValue = async (capability) => { updates.push(capability); await gate.promise; };
  const poll = device.onCheckInterval();
  await new Promise(setImmediate);
  const deleting = device.onDeleted();
  gate.resolve();
  await Promise.all([poll, deleting]);
  assert.deepEqual(updates, ["onoff"]);
});

test("invalid polling intervals cannot create a busy loop or discard the valid schedule", () => {
  const { device, timers } = deviceHarness();
  device.start_check_interval(1);
  for (const interval of [0, -1, NaN, Infinity, undefined, "1", 3601]) {
    assert.throws(() => device.start_check_interval(interval), /polling interval/);
    assert.equal(timers.size, 1);
  }
});
