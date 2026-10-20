"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const Communicate = require("../lib/Communicate");
const DataStore = require("../lib/DataStore");

const originalLoad = Module._load;
let RM4MiniDevice;
try {
  Module._load = function (request, parent, isMain) {
    if (request === "homey") return { Device: class {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  RM4MiniDevice = require("../drivers/RM4_mini/device");
} finally {
  Module._load = originalLoad;
}
const BroadlinkDevice = require("../lib/BroadlinkDevice");

const shortIR = Buffer.from("2602020010200d05", "hex");
const session = { key: Buffer.alloc(16, 0x11), id: Buffer.from([1, 2, 3, 4]) };
const args = { variable: { name: "heat pump" } };

function harness() {
  const calls = [];
  const homey = {
    __: (key) => key,
    setTimeout: (fn, ms) => { calls.push(["delay", ms]); if (ms !== 5000) queueMicrotask(fn); return 1; },
    clearTimeout: () => calls.push(["clear timeout"]),
  };
  const comm = new Communicate();
  comm.configure = (options) => {
    Communicate.prototype.configure.call(comm, options);
    comm._utils.debugLog = () => {};
  };
  comm.configure({ homey, deviceType: 0x62bc, mac: Buffer.alloc(6), count: 0,
    ipAddress: "192.0.2.10", key: Buffer.alloc(16, 0x22), id: Buffer.alloc(4, 9) });
  comm.send_packet = async (command, _version, payload) => {
    calls.push(["packet", command, Buffer.from(payload)]);
    return { error: 0 };
  };
  const device = Object.assign(Object.create(RM4MiniDevice.prototype), {
    homey,
    _communicate: comm,
    _utils: comm._utils,
    getData: () => ({ devtype: "25276", mac: "000000000000" }),
    setSettings: async (settings) => calls.push(["settings", settings]),
    log: (...message) => calls.push(["log", ...message]),
    error: (...message) => calls.push(["error", ...message]),
    dataStore: { getCommandData: () => shortIR },
    driver: {
      rm4_mini_specific_cmd_trigger: { trigger: async () => calls.push(["specific"]) },
      rm4_mini_any_cmd_trigger: { trigger: async () => calls.push(["any"]) },
    },
  });
  return { comm, device, calls };
}

function packets(calls) {
  return calls.filter((call) => call[0] === "packet");
}

test("RM4 mini sends a 448-byte IR packet with the Python <HI header and no stored padding", async () => {
  const { comm, calls } = harness();
  // Synthetic long AC-sized code; no claim that this is a real Panasonic capture.
  const raw = Buffer.alloc(448, 0x20);
  raw.set([0x26, 2, 0xbc, 1]); // 444 pulse bytes, repeat count 2
  raw.set([0x0d, 0x05], raw.length - 2);
  const stored = Buffer.concat([Buffer.alloc(2), raw, Buffer.alloc(14)]);
  const before = Buffer.from(stored);
  for (const input of [stored, raw, [...stored]]) {
    await comm.send_IR_RF_data_rm4mini(input);
  }
  // struct.pack("<HI", 448 + 4, 2) == c4 01 02 00 00 00
  const expected = Buffer.concat([Buffer.from("c40102000000", "hex"), raw]);
  for (const [, command, packet] of packets(calls)) {
    assert.equal(command, 0x6a);
    assert.deepEqual(packet, expected);
  }
  assert.deepEqual(stored, before);
});

test("RM4 mini preserves optional external terminators, repeats, and declared trailing zero bytes", async () => {
  const { comm, calls } = harness();
  await comm.send_IR_RF_data_rm4mini(shortIR);
  assert.deepEqual(packets(calls)[0][2], Buffer.from("0c00020000002602020010200d05", "hex"));
  const raw = Buffer.from("2600040010000100000000", "hex");
  await comm.send_IR_RF_data_rm4mini(raw);
  assert.deepEqual(packets(calls)[1][2], Buffer.from("0c00020000002600040010000100", "hex"));
});

test("RM4 mini rejects malformed or oversized IR before contacting the device", async () => {
  const { comm, calls } = harness();
  const oversized = Buffer.alloc(65539, 1);
  oversized.set([0x26, 0, 0xff, 0xff]);
  for (const input of [null, {}, [], [0x26], [0xb2, 0, 1, 0, 1],
    [0x26, 0, 0, 0], [0, 0, 0x26, 0, 3, 0, 1], oversized]) {
    await assert.rejects(comm.send_IR_RF_data_rm4mini(input), /RM4 mini IR command/);
  }
  assert.equal(packets(calls).length, 0);
});

test("RM4 mini wire packet encrypts the complete dynamic header and pads only for AES", async () => {
  const { comm } = harness();
  comm.send_packet = Communicate.prototype.send_packet;
  comm.sendto = async (packet) => {
    const payload = Buffer.from(comm.decrypt(packet.slice(0x38)));
    assert.equal(payload.length % 16, 0);
    assert.deepEqual(payload.subarray(0, 14), Buffer.from("0c00020000002602020010200d05", "hex"));
    assert.ok(payload.subarray(14).every((byte) => byte === 0));
    return { data: Buffer.concat([Buffer.alloc(0x38), Buffer.from(comm.encrypt(Buffer.alloc(16)))]) };
  };
  await comm.send_IR_RF_data_rm4mini(shortIR);
});

for (const expired of [0xfff9, -7]) {
  test(`RM4 mini recovers expired key ${expired} once using default auth credentials and saves the session`, async () => {
    const { comm, device, calls } = harness();
    let sends = 0;
    comm.send_packet = async (command, _version, payload) => {
      calls.push(["packet", command, Buffer.from(payload)]);
      if (command === 0x65) {
        assert.equal(comm.deviceType, 0x62bc);
        assert.equal(comm.ipAddress, "192.0.2.10");
        assert.deepEqual([...comm.id], [0, 0, 0, 0]);
        assert.equal(Buffer.from(comm.key).toString("hex"), "097628343fe99e23765c1513accf8b02");
        return { error: 0, payload: session.key, cmd: session.id };
      }
      if (++sends === 1) return { error: expired };
      assert.deepEqual(comm.key, session.key);
      assert.deepEqual(comm.id, session.id);
      assert.ok(calls.some((call) => call[0] === "settings"));
      return { error: 0 };
    };
    assert.equal(await device.executeCommand(args), true);
    assert.deepEqual(packets(calls).map((call) => call[1]), [0x6a, 0x65, 0x6a]);
    assert.deepEqual(packets(calls)[0][2], packets(calls)[2][2]);
    assert.deepEqual(calls.find((call) => call[0] === "settings")[1], {
      key: "11111111111111111111111111111111", id: "01020304",
    });
    assert.equal(calls.filter((call) => call[0] === "specific").length, 1);
    assert.equal(calls.filter((call) => call[0] === "any").length, 1);
  });
}

for (const error of [-1, 0xfffa, undefined]) {
  test(`RM4 mini surfaces response error ${error} without authenticating or firing sent Flows`, async () => {
    const { comm, device, calls } = harness();
    comm.send_packet = async () => ({ error, message: "UDP failure" });
    await assert.rejects(device.executeCommand(args), /Broadlink error/);
    assert.equal(calls.some((call) => ["settings", "specific", "any"].includes(call[0])), false);
  });
}

test("RM4 mini stops after the retry is rejected and the queue remains usable", async () => {
  const { comm, device, calls } = harness();
  let auths = 0;
  comm.auth = async () => { auths++; return session; };
  comm.send_packet = async () => ({ error: 0xfff9 });
  await assert.rejects(device.executeCommand(args), /control key expired/);
  assert.equal(auths, 1);
  assert.equal(calls.some((call) => call[0] === "specific"), false);
  comm.send_packet = async () => ({ error: 0 });
  assert.equal(await device.executeCommand(args), true);
});

for (const failure of ["auth", "invalid session", "save"]) {
  test(`RM4 mini does not resend after ${failure} failure`, async () => {
    const { comm, device, calls } = harness();
    let sends = 0;
    comm.send_packet = async () => { sends++; return { error: 0xfff9 }; };
    comm.auth = async () => {
      if (failure === "auth") throw new Error("Authentication unavailable");
      return failure === "invalid session" ? { key: [], id: [] } : session;
    };
    if (failure === "save") device.setSettings = async () => { throw new Error("Session persistence failed"); };
    await assert.rejects(device.executeCommand(args), /Authentication unavailable|Invalid RM4 mini|Session persistence/);
    assert.equal(sends, 1);
    assert.equal(calls.some((call) => call[0] === "specific"), false);
  });
}

test("RM4 mini serializes simultaneous commands through authentication and persistence", async () => {
  const { comm, device } = harness();
  let release;
  const saved = new Promise((resolve) => { release = resolve; });
  let sends = 0;
  let auths = 0;
  comm.send_packet = async () => ({ error: ++sends === 1 ? 0xfff9 : 0 });
  comm.auth = async () => { auths++; return session; };
  device.setSettings = () => saved;
  const first = device.executeCommand(args);
  const second = device.executeCommand(args);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(sends, 1);
  assert.equal(auths, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(sends, 3);
  assert.equal(auths, 1);
});

test("RM4 mini initial authentication uses decimal discovery type", async () => {
  const { comm, device } = harness();
  comm.auth = async () => { assert.equal(comm.deviceType, 0x62bc); return session; };
  await device.onAdded();
});

test("RM4 mini learning waits on read/storage errors and preserves the legacy stored prefix", async () => {
  const { comm, device, calls } = harness();
  let reads = 0;
  const stored = Buffer.concat([Buffer.alloc(2), shortIR, Buffer.alloc(4)]);
  comm.send_packet = async (_command, _version, payload) => {
    calls.push(["packet", 0x6a, Buffer.from(payload)]);
    if (payload[2] === 3) return { error: 0 };
    reads++;
    if (reads === 1) return { error: 0xfff6 }; // -10: no capture yet
    if (reads === 2) return { error: 0xfffb }; // -5: no capture yet
    return { error: 0, payload: stored };
  };
  await device._withAuthentication(() => comm.enter_learning_rm4mini());
  const learned = await comm.check_IR_data_rm4mini(() => device._withAuthentication(() => comm.read_IR_data_rm4mini()));
  assert.equal(learned, stored);
  assert.deepEqual(packets(calls).map((call) => [...call[2]]), [
    [4, 0, 3, 0, 0, 0], [4, 0, 4, 0, 0, 0], [4, 0, 4, 0, 0, 0], [4, 0, 4, 0, 0, 0],
  ]);
  assert.equal(calls.filter((call) => call[0] === "delay").length, 3);
});

test("RM4 mini learning recovers expired keys both entering learning and reading a capture", async () => {
  const { comm, device } = harness();
  const counts = { 3: 0, 4: 0 };
  let auths = 0;
  comm.auth = async () => { auths++; return session; };
  comm.send_packet = async (_command, _version, payload) => {
    if (++counts[payload[2]] === 1) return { error: 0xfff9 };
    return { error: 0, payload: Buffer.concat([Buffer.alloc(2), shortIR]) };
  };
  await device._withAuthentication(() => comm.enter_learning_rm4mini());
  const learned = await comm.check_IR_data_rm4mini(() => device._withAuthentication(() => comm.read_IR_data_rm4mini()));
  assert.deepEqual(learned.subarray(2), shortIR);
  assert.deepEqual(counts, { 3: 2, 4: 2 });
  assert.equal(auths, 2);
});

test("RM4 mini learning times out after eight sequential reads and surfaces unexpected errors immediately", async () => {
  const { comm, calls } = harness();
  let reads = 0;
  comm.send_packet = async () => { reads++; return { error: 0xfff6 }; };
  await assert.rejects(comm.check_IR_data_rm4mini(), /timed out/);
  assert.equal(reads, 8);
  assert.equal(calls.filter((call) => call[0] === "delay").length, 8);
  comm.send_packet = async () => { reads++; return { error: 0xfffa }; };
  await assert.rejects(comm.check_IR_data_rm4mini(), /Broadlink error -6/);
  assert.equal(reads, 9);
});

test("RM4 mini capability learning stops on rejected entry without starting capture polling", async (t) => {
  const { comm, device, calls } = harness();
  let run;
  t.mock.method(global, "setTimeout", (fn) => { if (!run) run = fn; return 1; });
  device.setCapabilityValue = async (id, value) => calls.push([id, value]);
  device.setWarning = async (message) => calls.push(["warning", message]);
  comm.send_packet = async () => ({ error: 0xfffa });
  comm.check_IR_data_rm4mini = async () => assert.fail("Rejected learning entry must not start polling");
  await device.onCapabilityLearnIR(true);
  await run();
  assert.equal(device.learn, false);
  assert.ok(calls.some((call) => call[0] === "warning" && /Broadlink error -6/.test(call[1])));
  assert.ok(calls.some((call) => call[0] === "learningState" && call[1] === false));
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("RM4 mini uninitialization drains the active command and rejects queued commands without sending", async () => {
  const { comm, device, calls } = harness();
  const reply = deferred();
  let sends = 0;
  comm.send_packet = async () => { sends++; return reply.promise; };
  const first = assert.rejects(device.executeCommand(args), /stopped or reinitialized/);
  const second = assert.rejects(device.executeCommand(args), /stopped or reinitialized/);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(sends, 1);
  const stopped = device.onUninit();
  reply.resolve({ error: 0xfff9 });
  await Promise.all([first, second, stopped]);
  assert.equal(sends, 1);
  assert.equal(calls.some((call) => ["settings", "specific", "any"].includes(call[0])), false);
  await assert.rejects(device.executeCommand(args), /stopped or reinitialized/);
});

test("RM4 mini stopping during authentication prevents persistence and resend", async () => {
  const { comm, device, calls } = harness();
  const authentication = deferred();
  let sends = 0;
  comm.send_packet = async () => { sends++; return { error: 0xfff9 }; };
  comm.auth = () => authentication.promise;
  const command = assert.rejects(device.executeCommand(args), /stopped or reinitialized/);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const stopped = device.onUninit();
  authentication.resolve(session);
  await Promise.all([command, stopped]);
  assert.equal(sends, 1);
  assert.equal(calls.some((call) => call[0] === "settings"), false);
});

test("RM4 mini deletion waits for active work and cannot send queued commands", async () => {
  const { comm, device, calls } = harness();
  const reply = deferred();
  let sends = 0;
  let destroyed = false;
  comm.send_packet = async () => { sends++; return reply.promise; };
  comm.destroy = () => { destroyed = true; };
  device.dataStore.deleteAllCommands = async () => calls.push(["delete commands"]);
  const first = assert.rejects(device.executeCommand(args), /stopped or reinitialized/);
  const second = assert.rejects(device.executeCommand(args), /stopped or reinitialized/);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const deleted = device.onDeleted();
  assert.equal(destroyed, false);
  reply.resolve({ error: 0 });
  await Promise.all([first, second, deleted]);
  assert.equal(sends, 1);
  assert.equal(destroyed, true);
  assert.equal(device._communicate, null);
  assert.equal(calls.some((call) => call[0] === "specific"), false);
});

test("RM4 mini reinitialization rejects old queued work before replacing the connection", async (t) => {
  const { comm, device } = harness();
  const reply = deferred();
  let sends = 0;
  comm.send_packet = async () => { sends++; return reply.promise; };
  const replacement = harness().comm;
  t.mock.method(BroadlinkDevice.prototype, "onInit", async function () { this._communicate = replacement; });
  t.mock.method(DataStore.prototype, "readCommands", async () => {});
  device.hasCapability = () => true;
  device.setCapabilityValue = async () => {};
  device.registerCapabilityListener = () => {};
  const first = assert.rejects(device.executeCommand(args), /stopped or reinitialized/);
  const second = assert.rejects(device.executeCommand(args), /stopped or reinitialized/);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const initialized = device.onInit();
  reply.resolve({ error: 0 });
  await Promise.all([first, second, initialized]);
  assert.equal(sends, 1);
  assert.equal(device._communicate, replacement);
  device.dataStore.getCommandData = () => shortIR;
  assert.equal(await device.executeCommand(args), true);
});

test("RM4 mini stopped learning cannot poll or store data through a replacement connection", async (t) => {
  const { device, calls } = harness();
  let run;
  let wake;
  t.mock.method(global, "setTimeout", (fn) => { if (!run) run = fn; return 1; });
  t.mock.method(global, "clearTimeout", () => {});
  device.homey.setTimeout = (fn) => { wake = fn; };
  device.setCapabilityValue = async (id, value) => calls.push([id, value]);
  device.setWarning = async () => assert.fail("Stopped learning must not update warnings");
  device.dataStore.addCommand = async () => assert.fail("Stopped learning must not save a command");
  await device.onCapabilityLearnIR(true);
  const learning = run();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(typeof wake, "function");
  const stopped = device.onUninit();
  wake();
  await stopped;
  device._communicate = harness().comm;
  device._communicate.read_IR_data_rm4mini = async () => assert.fail("Old learning must not poll replacement connection");
  device._operationsStopped = false;
  await learning;
  assert.equal(packets(calls).length, 1); // only the original enter-learning request
  assert.equal(device.learn, false);
});

for (const stage of ["add", "settings", "page", "warning"]) {
  test(`RM4 mini deletion drains learning paused during ${stage} and prevents later callback mutations`, async (t) => {
    const { comm, device, calls } = harness();
    const pending = deferred();
    let run;
    let paused = false;
    t.mock.method(global, "setTimeout", (fn) => { if (!run) run = fn; return 1; });
    t.mock.method(global, "clearTimeout", () => {});
    device.setCapabilityValue = async (id, value) => calls.push([id, value]);
    device.getNextCmdName = () => "cmd1";
    device.getCurrentOffset = () => 0;
    const operation = (name, result) => async () => {
      calls.push([name]);
      if (stage === name) { paused = true; await pending.promise; }
      return result;
    };
    device.dataStore.addCommand = operation("add", true);
    device.storeCmdSetting = operation("settings");
    device.fillRcCmdPage = operation("page");
    device.setWarning = operation("warning");
    device.dataStore.deleteAllCommands = operation("delete commands");
    comm.check_IR_data_rm4mini = async () => Buffer.concat([Buffer.alloc(2), shortIR]);
    await device.onCapabilityLearnIR(true);
    const learning = run();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    assert.equal(paused, true);
    assert.equal(device._learningTasks.size, 1);
    const deleted = device.onDeleted();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(calls.some((call) => call[0] === "delete commands"), false);
    const before = calls.length;
    pending.resolve();
    await Promise.all([learning, deleted]);
    assert.deepEqual(calls.slice(before), [["delete commands"]]);
    assert.equal(device._learningTasks.size, 0);
    assert.equal(device._communicate, null);
  });
}

test("RM4 mini successful learning awaits persistence and cancels its warning reset on stop", async (t) => {
  const { comm, device, calls } = harness();
  let run;
  let resetWarning;
  t.mock.method(global, "setTimeout", (fn) => { run = fn; return 1; });
  t.mock.method(global, "clearTimeout", () => {});
  device.homey.setTimeout = (fn, ms) => { assert.equal(ms, 5000); resetWarning = fn; return 42; };
  device.setCapabilityValue = async () => {};
  device.getNextCmdName = () => "cmd1";
  device.getCurrentOffset = () => 0;
  device.dataStore.addCommand = async () => { calls.push(["saved"]); return true; };
  device.storeCmdSetting = async () => calls.push(["settings"]);
  device.fillRcCmdPage = async () => calls.push(["page"]);
  device.setWarning = async (message) => calls.push(["warning", message]);
  comm.check_IR_data_rm4mini = async () => shortIR;
  await device.onCapabilityLearnIR(true);
  assert.equal(await run(), true);
  assert.deepEqual(calls.filter((call) => ["saved", "settings", "page", "warning"].includes(call[0])), [
    ["saved"], ["settings"], ["page"], ["warning", "Stored command: cmd1"],
  ]);
  await device.onUninit();
  assert.equal(device._learningWarningTimeout, null);
  const before = calls.length;
  resetWarning();
  assert.equal(calls.length, before);
});
