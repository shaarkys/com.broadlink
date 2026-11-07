"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const dgram = require("node:dgram");
const { EventEmitter } = require("node:events");
const Communicate = require("../lib/Communicate");
const BroadlinkUtils = require("../lib/BroadlinkUtils");
const originalLoad = Module._load;
let classes, RM4Mini;
try {
  Module._load = function (name, ...args) {
    if (name === "homey") return { Device: class {}, Driver: class {} };
    return originalLoad.call(this, name, ...args);
  };
  RM4Mini = require("../drivers/RM4_mini/device");
  classes = ["RM3_mini", "RM_pro", "RM_plus", "RM4_pro"].map(name => require(`../drivers/${name}/device`));
} finally { Module._load = originalLoad; }

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function communication(type = 0x2737) {
  const comm = new Communicate();
  comm.configure({ homey: { __: key => key }, deviceType: type, count: 0 });
  comm._utils.debugLog = () => {};
  return comm;
}
function sockets(t) {
  const result = [];
  t.mock.method(dgram, "createSocket", () => {
    const socket = new EventEmitter();
    socket.closeCount = 0;
    socket.send = () => {};
    socket.close = () => { socket.closeCount++; };
    socket.reply = () => socket.emit("message", Buffer.from([socket.index]), { address: "192.0.2.1", port: 80, size: 1 });
    socket.index = result.length + 1;
    result.push(socket);
    return socket;
  });
  return result;
}
function device(index, comm = communication()) {
  const calls = [];
  const prefix = ["rm3mini", "rmpro", "rmplus", "rm4_pro"][index];
  return Object.assign(Object.create(classes[index].prototype), {
    _communicate: comm, _utils: comm._utils,
    getData: () => ({ devtype: String(index === 3 ? 0x520b : 0x2737) }),
    dataStore: { getCommandData: () => Uint8Array.from([0x26, 0, 2, 0, 1, 2]) },
    error: (...args) => calls.push(["error", ...args]),
    driver: {
      [`${prefix}_specific_cmd_trigger`]: { trigger: async () => calls.push("specific") },
      [`${prefix}_any_cmd_trigger`]: { trigger: async () => calls.push("any") },
    }, calls,
  });
}

for (let index = 0; index < classes.length; index++) {
  test(`local remote ${index} rejects device and transport failures without sent Flows`, async () => {
    for (const failure of [{ error: -1, message: "mock timeout" }, { error: 0xfff9 }, new Error("mock send failure")]) {
      const comm = communication();
      comm.send_packet = async () => { if (failure instanceof Error) throw failure; return failure; };
      const dev = device(index, comm);
      await assert.rejects(dev.executeCommand({ variable: { name: "test" } }));
      assert.deepEqual(dev.calls, []);
    }
  });
  test(`local remote ${index} preserves sends and handles post-send Flow failures`, async () => {
    const comm = communication();
    let packet;
    comm.send_packet = async (_command, _version, payload) => { packet = Buffer.from(payload); return { error: 0 }; };
    const dev = device(index, comm);
    const first = Object.values(dev.driver)[0];
    first.trigger = async () => { throw new Error("Flow rejected"); };
    assert.equal(await dev.executeCommand({ variable: { name: "test" } }), true);
    assert.equal(packet.subarray(0, index === 3 ? 6 : 4).toString("hex"), index === 3 ? "da0002000000" : "02000000");
    assert.ok(dev.calls.includes("any"));
    assert.equal(dev.calls.filter(call => Array.isArray(call) && call[0] === "error").length, 1);
  });
}

test("each concurrent UDP request owns its response, socket and timer", async t => {
  const udp = sockets(t), comm = communication();
  let firstSettled = false;
  const first = comm.sendto(Buffer.alloc(1), "192.0.2.1", 80, 20).then(response => { firstSettled = true; return response; });
  const second = comm.sendto(Buffer.alloc(1), "192.0.2.1", 80, 20);
  udp[1].reply();
  assert.equal((await second).data[0], 2);
  assert.equal(firstSettled, false);
  udp[0].reply();
  assert.equal((await first).data[0], 1);
  assert.deepEqual(udp.map(socket => socket.closeCount), [1, 1]);
  comm.destroy(); comm.destroy();
  assert.deepEqual(udp.map(socket => socket.closeCount), [1, 1]);
});

test("timed-out UDP replies and errors cannot settle a replacement request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const udp = sockets(t), comm = communication();
  const first = assert.rejects(comm.sendto(Buffer.alloc(1), "192.0.2.1", 80, 1), /timeout/);
  t.mock.timers.tick(1000);
  await first;
  let settled = false;
  const next = comm.sendto(Buffer.alloc(1), "192.0.2.1", 80, 20).then(value => { settled = true; return value; });
  udp[0].reply(); udp[0].emit("error", new Error("late error"));
  await flush();
  assert.equal(settled, false);
  udp[1].reply();
  assert.equal((await next).data[0], 2);
});

test("UDP send errors preserve their cause and destroy settles every pending request", async t => {
  const udp = sockets(t), comm = communication();
  const first = assert.rejects(comm.sendto(Buffer.alloc(1), "192.0.2.1", 80, 20), /mock socket error/);
  udp[0].emit("error", new Error("mock socket error")); await first;
  const pending = [1, 2].map(() => assert.rejects(comm.sendto(Buffer.alloc(1), "192.0.2.1", 80, 20), { code: "BROADLINK_CANCELLED" }));
  comm.destroy(); comm.destroy();
  await Promise.all(pending);
  assert.deepEqual(udp.map(socket => socket.closeCount), [1, 1, 1]);
});

test("destroy cancels the existing retry delay without resending a physical command", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const comm = communication(); let sends = 0;
  comm.sendto = async () => { sends++; throw new Error("timeout"); };
  const result = assert.rejects(comm.send_packet(0x6a, false, new Uint8Array(4)), { code: "BROADLINK_CANCELLED" });
  await flush(); assert.equal(sends, 1);
  comm.destroy(); t.mock.timers.tick(60000);
  await result; assert.equal(sends, 1);
});

test("capture polls are sequential, locally bounded and abort on terminal errors", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const comm = communication(), reply = deferred(); let sends = 0;
  comm.send_packet = async () => { sends++; return sends === 1 ? reply.promise : { error: 0, payload: [9] }; };
  const captured = comm._check_data(new Uint8Array(16));
  t.mock.timers.tick(2000); await flush();
  t.mock.timers.tick(10000); await flush(); assert.equal(sends, 1);
  reply.resolve({ error: 0xfff6 }); await flush();
  t.mock.timers.tick(2000); await flush();
  assert.deepEqual(await captured, [9]); assert.equal(sends, 2);
  comm.send_packet = async () => ({ error: -1, message: "mock timeout" });
  const failed = assert.rejects(comm._check_data(new Uint8Array(16)), /mock timeout/);
  t.mock.timers.tick(2000); await failed;
  comm.send_packet = async () => { sends++; return { error: 0xfff6 }; };
  const bounded = assert.rejects(comm._check_data(new Uint8Array(16)), /timed out/);
  const before = sends;
  for (let i = 0; i < 8; i++) { t.mock.timers.tick(2000); await flush(); }
  await bounded; assert.equal(sends - before, 8);
});

test("capture cancellation settles a pending UDP poll and prevents further reads/retries", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const udp = sockets(t), comm = communication();
  const captured = assert.rejects(comm._check_data(new Uint8Array(16)), { code: "BROADLINK_CANCELLED" });
  t.mock.timers.tick(2000); await flush(); assert.equal(udp.length, 1);
  comm.cancelLearning(); await captured;
  t.mock.timers.tick(60000); await flush(); assert.equal(udp.length, 1);
  udp[0].reply(); assert.equal(udp[0].closeCount, 1);
});

test("manual RM3-family authentication uses decimal device type and the submitted IP", async () => {
  const dev = device(0); let configured;
  dev.getSettings = () => ({ ipAddress: "192.0.2.1" });
  dev.getData = () => ({ devtype: "10039", mac: "000000000000" });
  dev._communicate.configure = options => { configured = options; };
  dev.authenticateDevice = async () => {};
  dev.setSettings = async () => {};
  await dev.onSettings({ oldSettings: { Authenticate: false }, newSettings: { Authenticate: true, ipAddress: "192.0.2.2" }, changedKeys: ["Authenticate"] });
  assert.equal(configured.deviceType, 10039); assert.equal(configured.ipAddress, "192.0.2.2");
});

test("local address lookup rejects with the original failure", async () => {
  const failure = new Error("mock address failure");
  const utils = new BroadlinkUtils({ cloud: { getLocalAddress: async () => { throw failure; } } });
  utils.debugLog = () => {};
  await assert.rejects(utils.getHomeyIp(), error => error === failure);
});

for (const index of [0, 3]) {
  test(`local IR learner ${index} cannot save a late capture after cancellation`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const dev = device(index), capture = deferred(); let stored = 0;
    dev.setCapabilityValue = async () => {};
    dev._communicate.enter_learning = dev._communicate.enter_learning_red = async () => {};
    dev._communicate.check_IR_data = dev._communicate.check_IR_data_red = () => capture.promise;
    dev.dataStore.addCommand = async () => { stored++; return true; };
    await dev.onCapabilityLearnIR(true); t.mock.timers.tick(300); await flush();
    await dev.onCapabilityLearnIR(false); capture.resolve([0x26, 0]); await flush();
    await Promise.allSettled(dev._localLearningTasks);
    assert.equal(stored, 0); assert.equal(dev.learn, false);
  });
}

for (const index of [1, 2]) {
  test(`RF learner ${index} selects an unused name and refuses failed persistence`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const saved of [true, false]) {
      const dev = device(index), prompts = []; let setting;
      dev.homey = { __: key => key, speechOutput: { say: async key => prompts.push(key) } };
      dev.isSpeechOutputAvailable = () => true;
      dev.setCapabilityValue = async () => {};
      dev._communicate.enterRFSweep = dev._communicate.checkRFData = dev._communicate.cancelRFSweep = async () => {};
      dev._communicate.checkRFData2 = async () => [0xb2, 0];
      let name;
      dev.dataStore = { dataArray: [{ name: "rf-cmd2" }], addCommand: async value => { name = value; return saved; } };
      dev.storeCmdSetting = async value => { setting = value; };
      assert.equal(await dev.onCapabilityLearnRF(true), saved);
      assert.equal(name, "rf-cmd1"); assert.equal(setting, saved ? "rf-cmd1" : undefined);
      assert.equal(prompts.includes("rf_learn.done"), saved);
    }
  });
}

for (const replacement of [false, true]) {
  test(`base init cannot resume after ${replacement ? "a replacement init" : "stop"} while draining learning`, async () => {
    const Base = Object.getPrototypeOf(classes[0].prototype);
    const drain = deferred();
    let reads = 0, starts = 0;
    const dev = Object.assign(Object.create(Base), {
      _localLearningTasks: new Set([drain.promise]),
      _communicate: { destroy() {}, cancelLearning() {} },
      homey: { clearTimeout() {} },
      getSettings: () => { reads++; return {}; },
      getData: () => ({ devtype: "10039" }), getName: () => "test",
      _utils: { hexToArr: () => null, arrToHex: () => "", debugLog() {} },
      initializeDeviceLockCapability: async () => {},
      startLockChecks: () => { starts++; },
    });
    const original = dev.onInit();
    const next = replacement ? dev.onInit() : (dev.onUninit(), null);
    drain.resolve();
    assert.equal(await original, false);
    if (replacement) { await next; assert.equal(reads, 1); assert.equal(starts, 1); }
    else { assert.equal(reads, 0); assert.equal(starts, 0); assert.equal(dev._localStopped, true); }
    dev.onUninit();
  });
}

test("RM4 Pro RF cancellation prevents a late capture from being saved", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let scheduled;
  t.mock.method(global, "setImmediate", callback => { scheduled = callback; });
  const dev = device(3), capture = deferred(); let stored = 0;
  dev.setCapabilityValue = async () => {};
  dev.isSpeechOutputAvailable = () => true;
  dev.homey = { __: key => key, speechOutput: { say: async () => {} } };
  dev.setWarning = dev.unsetWarning = async () => {};
  dev._communicate.checkRFData2_rm4pro = () => capture.promise;
  dev._communicate.cancelRFSweep_rm4pro = async () => {};
  dev.dataStore = { dataArray: [], addCommand: async () => { stored++; return true; } };
  await dev.startRfLearning(433.92);
  const task = scheduled(); await flush(); t.mock.timers.tick(2000); await flush();
  await dev.onCapabilityLearnRF(false);
  capture.resolve([0xb2, 0]); await task;
  assert.equal(stored, 0); assert.equal(dev.learn, false);
});

test("uninit cancels climate polling and rejects late telemetry capability writes", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const dev = device(3), reply = deferred(), writes = [];
  dev.homey = { clearTimeout() {} };
  dev.setCapabilityValue = async (...args) => writes.push(args);
  dev._communicate.checkTempHumidity_rm4pro = () => reply.promise;
  dev.pollInterval = setInterval(() => assert.fail("orphan climate interval"), 60000);
  const pending = dev.pollTempHumidity();
  dev.onUninit();
  reply.resolve({ temperature: [20, 0], humidity: [50, 0] }); await pending;
  t.mock.timers.tick(60000);
  assert.deepEqual(writes, []); assert.equal(dev.pollInterval, null);
});

for (const [name, Device] of [["RM3 family", classes[0]], ["RM4 Pro", classes[3]], ["RM4 Mini", RM4Mini]]) {
  test(`${name} deletion persistence failure still clears transport and app registry`, async () => {
    let destroyed = 0, unregistered = 0;
    const failure = new Error("mock unlink failure");
    const dev = Object.assign(Object.create(Device.prototype), {
      homey: { clearTimeout() {}, app: { unregisterRfDevice: () => unregistered++ } },
      _communicate: { destroy: () => destroyed++, cancelLearning() {} },
      _utils: { debugLog() {} },
      dataStore: { deleteAllCommands: async () => { throw failure; } },
      _operationQueue: Promise.resolve(), _learningTasks: new Set(),
      error() {},
    });
    await assert.rejects(dev.onDeleted(), error => error === failure);
    assert.ok(destroyed >= 1);
    assert.equal(dev._communicate, null); assert.equal(unregistered, 1);
  });
}

for (const index of [1, 2]) {
  test(`RF learner ${index} releases its internal flag when Homey UI reset rejects`, async () => {
    const dev = device(index); let entries = 0;
    dev.homey = { __: key => key, speechOutput: { say: async () => {} } };
    dev.isSpeechOutputAvailable = () => true;
    dev.setCapabilityValue = async () => { throw new Error("mock capability reset failure"); };
    dev._communicate.enterRFSweep = async () => { entries++; };
    dev._communicate.checkRFData = dev._communicate.cancelRFSweep = async () => {};
    dev._communicate.checkRFData2 = async () => [0xb2, 0];
    dev.dataStore = { dataArray: [], addCommand: async () => false };
    assert.equal(await dev.onCapabilityLearnRF(true), false);
    assert.equal(dev.learn, false);
    assert.equal(await dev.onCapabilityLearnRF(true), false);
    assert.equal(entries, 2); assert.equal(dev.learn, false);
    assert.ok(dev.calls.some(call => call[0] === "error"));
  });
}

for (const index of [0, 3]) {
  test(`IR learner ${index} releases its internal flag when Homey UI reset rejects`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const dev = device(index); let entries = 0;
    dev.setCapabilityValue = async (_id, value) => { if (value === false) throw new Error("mock capability reset failure"); };
    dev.setWarning = dev.unsetWarning = async () => {};
    dev._communicate.enter_learning = dev._communicate.enter_learning_red = async () => { entries++; };
    dev._communicate.check_IR_data = dev._communicate.check_IR_data_red = async () => [0x26];
    dev.getNextCmdName = () => "cmd1";
    dev.dataStore.addCommand = async () => false;
    for (let attempt = 0; attempt < 2; attempt++) {
      await dev.onCapabilityLearnIR(true); t.mock.timers.tick(300); await flush();
      await Promise.allSettled(dev._localLearningTasks);
      assert.equal(dev.learn, false);
    }
    assert.equal(entries, 2);
    assert.ok(dev.calls.some(call => call[0] === "error"));
    dev._stopLocalLearning();
  });
}
