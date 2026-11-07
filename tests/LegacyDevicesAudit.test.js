"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const Communicate = require("../lib/Communicate");
const originalLoad = Module._load;
let Base, A1, MP1, SP1, Dooya, Hysen;
try {
  Module._load = function (request, parent, isMain) {
    if (request === "homey") return { Device: class { onSettings() {} onUninit() {} }, Driver: class {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  Base = require("../lib/BroadlinkDevice");
  A1 = require("../drivers/A1/device");
  MP1 = require("../drivers/MP1/device");
  SP1 = require("../drivers/SP1/device");
  Dooya = require("../drivers/Dooya/device");
  Hysen = require("../drivers/Hysen/device");
} finally {
  Module._load = originalLoad;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness(Device) {
  const device = Object.create(Device.prototype);
  const events = [];
  const values = new Map([["onoff", false], ["onoff.s1", false], ["windowcoverings_closed", false], ["parental_mode", false]]);
  const settings = { ipAddress: "192.0.2.1", CheckInterval: 5 };
  const timers = new Map();
  let timerId = 0;
  const homey = {
    __: (key) => key,
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  const trigger = (name) => ({ trigger: async () => { events.push(["trigger", name]); } });
  Object.assign(device, {
    homey,
    _utils: {
      debugLog() {},
      hexToArr: (hex) => Uint8Array.from(Buffer.from(hex || "", "hex")),
      arrToHex: (bytes) => Buffer.from(bytes).toString("hex"),
      concatTypedArrays: (a, b) => Uint8Array.from([...a, ...b]),
      asHex: () => "mock response",
    },
    _communicate: {},
    driver: {
      trigger_toggle: trigger("changed"), trigger_on: trigger("on"), trigger_off: trigger("off"),
      trigger_closed: trigger("closed"), trigger_open: trigger("opened"),
      trigger_parentalmode_on: trigger("parental on"), trigger_parentalmode_off: trigger("parental off"), trigger_parentalmode_toggle: trigger("parental changed"),
      a1_trigger_air_quality: trigger("air quality"), a1_trigger_light_level: trigger("light level"), a1_trigger_noise_level: trigger("noise level"),
    },
    getCapabilities: () => [...values.keys()],
    getCapabilityValue: (id) => values.get(id),
    setCapabilityValue: async (id, value) => { events.push(["capability", id, value]); values.set(id, value); },
    getSettings: () => settings,
    getData: () => ({ devtype: "10004", mac: "102030405060" }),
    setSettings: async (patch) => { Object.assign(settings, patch); events.push(["settings", patch]); },
    registerCapabilityListener() {},
    error: (...args) => events.push(["error", ...args]),
    log() {},
  });
  return { device, values, settings, events, timers };
}

for (const [Device, command, action, capability] of [
  [SP1, "sp1_set_power_state", "do_action_on", "onoff"],
  [MP1, "mp1_set_power_state", "do_action_on", "onoff.s1"],
  [Dooya, "dooya_set_state", "do_action_close", "windowcoverings_closed"],
]) {
  test(`${Device.name} rejects failed writes without state updates or success triggers`, async () => {
    const { device, values, events } = harness(Device);
    const failure = new Error("mock UDP timeout");
    device._communicate[command] = async () => { throw failure; };
    await assert.rejects(device[action]("1"), (err) => err === failure);
    assert.equal(values.get(capability), false);
    assert.equal(events.some(([kind]) => kind === "trigger" || kind === "capability"), false);
  });

  test(`${Device.name} waits for acknowledgment before committing action state`, async () => {
    const { device, values, events } = harness(Device);
    const pending = deferred();
    device._communicate[command] = () => pending.promise;
    const result = device[action]("1");
    await Promise.resolve();
    assert.equal(values.get(capability), false);
    assert.equal(events.some(([kind]) => kind === "trigger" || kind === "capability"), false);
    pending.resolve(0);
    assert.equal(await result, true);
    assert.equal(values.get(capability), true);
  });
}

test("SP1 and all MP1 capability listeners return command errors", async () => {
  for (const [Device, command, listeners] of [
    [SP1, "sp1_set_power_state", ["onCapabilityOnOff"]],
    [MP1, "mp1_set_power_state", ["onCapabilityOnOff_1", "onCapabilityOnOff_2", "onCapabilityOnOff_3", "onCapabilityOnOff_4"]],
  ]) {
    const { device, events } = harness(Device);
    device._communicate[command] = async () => { throw new Error("mock rejection"); };
    for (const listener of listeners) await assert.rejects(device[listener](true), /mock rejection/);
    assert.equal(events.some(([kind]) => kind === "trigger" || kind === "capability"), false);
  }
});

test("legacy actions exercise actual Communicate helpers and reject explicit device errors", async () => {
  for (const [Device, action] of [[SP1, "do_action_on"], [MP1, "do_action_on"], [Dooya, "do_action_close"]]) {
    const { device, events } = harness(Device);
    const communication = Object.create(Communicate.prototype);
    communication.homey = device.homey;
    communication.send_packet = async () => ({ error: 17, payload: new Uint8Array([0]) });
    device._communicate = communication;
    await assert.rejects(device[action]("1"), /invalid_response/);
    assert.equal(events.some(([kind]) => kind === "trigger" || kind === "capability"), false);
  }
});

for (const [Device, command, action] of [
  [SP1, "sp1_set_power_state", "do_action_on"],
  [MP1, "mp1_set_power_state", "do_action_on"],
  [Dooya, "dooya_set_state", "do_action_close"],
]) {
  for (const failedStage of ["capability", "trigger"]) {
    test(`${Device.name} keeps acknowledged action successful when Homey ${failedStage} fails`, async () => {
      const { device, events } = harness(Device);
      let sends = 0;
      device._communicate[command] = async () => { sends++; return 0; };
      if (failedStage === "capability") {
        device.setCapabilityValue = async () => { throw new Error("mock Homey capability failure"); };
      } else {
        for (const card of Object.values(device.driver)) {
          card.trigger = async () => { throw new Error("mock Homey Flow failure"); };
        }
      }
      assert.equal(await device[action]("1"), true);
      await new Promise(setImmediate);
      assert.equal(sends, 1);
      const errors = events.filter(([kind]) => kind === "error");
      assert.equal(errors.length, 1);
      assert.match(errors[0][1], /command acknowledged/);
      assert.match(errors[0][2].message, /mock Homey/);
    });
  }
}

test("Dooya keeps acknowledged command state if Homey capability persistence fails", async () => {
  const { device, events } = harness(Dooya);
  let sends = 0;
  device._communicate.dooya_set_state = async () => { sends++; return 0; };
  device.setCapabilityValue = async () => { throw new Error("mock Homey capability failure"); };
  assert.equal(await device.do_action_close(), true);
  assert.equal(await device.do_action_close(), true);
  assert.equal(await device.check_condition_closed(), true);
  assert.equal(sends, 2);
  assert.deepEqual(events.filter(([kind]) => kind === "trigger"), [["trigger", "closed"]]);
});

test("MP1 keeps a successful polled state when its Homey Flow triggers fail", async () => {
  const { device, values, events } = harness(MP1);
  device._communicate.mp1_check_power = async () => 1;
  for (const card of Object.values(device.driver)) {
    card.trigger = async () => { throw new Error("mock Homey Flow failure"); };
  }
  await device.onCheckInterval();
  await new Promise(setImmediate);
  assert.equal(values.get("onoff.s1"), true);
  assert.equal(values.get("onoff.s2"), false);
  assert.equal(events.some(([kind, message]) => kind === "error" && /state read succeeded/.test(message)), true);
});

for (const [Device, readMethod, response] of [
  [A1, "read_status", new Uint8Array([20, 0, 50, 0, 2, 0, 1, 0, 1])],
  [MP1, "mp1_check_power", 1],
]) {
  test(`${Device.name} ignores a read that completes after deletion`, async () => {
    const { device, events } = harness(Device);
    device._localGeneration = 1;
    const read = deferred();
    device._communicate[readMethod] = () => read.promise;
    device._communicate.destroy = () => {};
    const operation = device.onCheckInterval();
    device.onDeleted();
    read.resolve(response);
    await operation;
    assert.equal(events.some(([kind]) => kind === "trigger" || kind === "capability"), false);
  });

  test(`${Device.name} ignores an old read when a replacement generation is active`, async () => {
    const { device, events } = harness(Device);
    device._localGeneration = 1;
    const read = deferred();
    device._communicate[readMethod] = () => read.promise;
    const operation = device.onCheckInterval();
    device._localGeneration = 2;
    device._communicate = {};
    read.resolve(response);
    await operation;
    assert.equal(events.some(([kind]) => kind === "trigger" || kind === "capability"), false);
  });

  test(`${Device.name} observes polling capability rejections without an unhandled promise`, async () => {
    const { device, events } = harness(Device);
    const logs = [];
    device._communicate[readMethod] = async () => response;
    device._utils.debugLog = (_source, message) => logs.push(message);
    let attempts = 0;
    device.setCapabilityValue = async () => { attempts++; throw new Error("mock polling capability rejection"); };
    await device.onCheckInterval();
    await new Promise(setImmediate);
    assert.equal(attempts, 1);
    assert.equal(logs.some((message) => /mock polling capability rejection/.test(message))
      || events.some(([kind, , err]) => kind === "error" && /mock polling capability rejection/.test(err.message)), true);
  });

  test(`${Device.name} stops further polling writes when deleted during a capability update`, async () => {
    const { device } = harness(Device);
    device._localGeneration = 1;
    device._communicate[readMethod] = async () => response;
    device._communicate.destroy = () => {};
    const update = deferred();
    const started = deferred();
    let attempts = 0;
    device.setCapabilityValue = () => { attempts++; started.resolve(); return update.promise; };
    const operation = device.onCheckInterval();
    await started.promise;
    device.onDeleted();
    update.resolve();
    await operation;
    assert.equal(attempts, 1);
  });
}

test("MP1 deletion during a Flow trigger prevents all later capability writes", async () => {
  const { device, events } = harness(MP1);
  device._localGeneration = 1;
  device._communicate.mp1_check_power = async () => 1;
  device._communicate.destroy = () => {};
  const flow = deferred();
  const started = deferred();
  device.driver.trigger_toggle.trigger = () => { started.resolve(); return flow.promise; };
  const operation = device.onCheckInterval();
  await started.promise;
  device.onDeleted();
  flow.resolve();
  await operation;
  assert.equal(events.some(([kind]) => kind === "capability"), false);
});

test("A1 deletion during its first Flow trigger prevents subsequent triggers", async () => {
  const { device, events } = harness(A1);
  device._localGeneration = 1;
  device._communicate.read_status = async () => new Uint8Array([20, 0, 50, 0, 2, 0, 1, 0, 1]);
  device._communicate.destroy = () => {};
  const flow = deferred();
  const started = deferred();
  device.driver.a1_trigger_air_quality.trigger = () => { started.resolve(); return flow.promise; };
  const operation = device.onCheckInterval();
  await started.promise;
  device.onDeleted();
  flow.resolve();
  await operation;
  assert.equal(events.some(([kind]) => kind === "trigger"), false);
});

test("Dooya capability mapping agrees with actions and custom triggers fire once per transition", async () => {
  const { device, events } = harness(Dooya);
  const commands = [];
  device._communicate.dooya_set_state = async (...args) => { commands.push(args); return 0; };
  await device.onCapabilityWcClosed(true);
  await device.onCapabilityClose();
  await device.onCapabilityWcClosed(false);
  await device.onCapabilityOpen();
  await device.onCapabilityStop();
  assert.deepEqual(commands, [[2, 0], [2, 0], [1, 0], [1, 0], [3, 0]]);
  assert.deepEqual(events.filter(([kind]) => kind === "trigger"), [["trigger", "closed"], ["trigger", "opened"]]);
});

test("Dooya button and closed-capability failures reject without transitions", async () => {
  const { device, events } = harness(Dooya);
  device._communicate.dooya_set_state = async () => { throw new Error("mock rejection"); };
  for (const listener of ["onCapabilityWcClosed", "onCapabilityOpen", "onCapabilityClose", "onCapabilityStop"]) {
    await assert.rejects(device[listener](true), /mock rejection/);
  }
  assert.equal(events.some(([kind]) => kind === "trigger" || kind === "capability"), false);
});

for (const Device of [A1, MP1]) {
  test(`${Device.name} initializes exactly one configured telemetry timer and replaces it on reinit/settings`, async (t) => {
    const { device, settings } = harness(Device);
    const active = new Set();
    let nextId = 0;
    t.mock.method(Base.prototype, "onInit", async function () {});
    device.stop_check_interval = () => { active.clear(); };
    device.start_check_interval = (minutes) => { assert.equal(minutes, settings.CheckInterval); active.add(++nextId); };
    settings.CheckInterval = 7;
    await device.onInit();
    assert.equal(active.size, 1);
    await device.onInit();
    assert.equal(active.size, 1);
    settings.CheckInterval = 9;
    await device.onSettings({ oldSettings: { CheckInterval: 7 }, newSettings: settings, changedKeys: ["CheckInterval"] });
    assert.equal(active.size, 1);
  });

  test(`${Device.name} does not start polling if uninitialized while shared initialization is pending`, async (t) => {
    const { device } = harness(Device);
    t.mock.method(Base.prototype, "onInit", async function () { this._localStopped = true; });
    device.stop_check_interval = () => {};
    let starts = 0;
    device.start_check_interval = () => { starts++; };
    await device.onInit();
    assert.equal(starts, 0);
  });
}

test("A1 authentication uses submitted IP, decimal device type, and awaits authentication", async () => {
  const { device, settings } = harness(A1);
  let options;
  device._communicate.setIPaddress = () => {};
  device._communicate.configure = (value) => { options = value; };
  const authentication = deferred();
  device.authenticateDevice = () => authentication.promise;
  const operation = device.onSettings({ oldSettings: settings, newSettings: { ...settings, ipAddress: "192.0.2.2", Authenticate: true }, changedKeys: ["ipAddress", "Authenticate"] });
  assert.equal(options.deviceType, 10004);
  assert.equal(options.ipAddress, "192.0.2.2");
  authentication.reject(new Error("mock authentication failure"));
  await assert.rejects(operation, /mock authentication failure/);
});

function hysenHarness() {
  const state = harness(Hysen);
  state.device.data = {
    RoomTemperature: 20, ExternalTemperature: 18, TargetTemperature: 21, ParentalMode: false, power: 1,
    LoopMode: "1", AutoMode: "0", SensorMode: "0", TempRangeExtSensor: 42, FloorTempDeadZone: 2,
    SensorUpperLimit: 35, SensorLowerLimit: 5, RoomTempAdjust: 0, AntiFreezeMode: "0", poweron: 0,
    schedule: Array.from({ length: 8 }, () => ({ time: "06:30", temp: 20 })),
  };
  return state;
}

for (const Device of [A1, MP1, SP1, Dooya, Hysen]) {
  test(`${Device.name} abandons an explicitly superseded base initialization even when its replacement is active`, async (t) => {
    const { device, timers } = harness(Device);
    device._communicate = null;
    t.mock.method(Base.prototype, "onInit", async function () {
      this._localStopped = false;
      return false;
    });
    let listeners = 0, pollingStarts = 0, reads = 0;
    device.registerCapabilityListener = () => { listeners++; };
    device.stop_check_interval = () => {};
    device.start_check_interval = () => { pollingStarts++; };
    device.get_full_status = device.get_temperature = async () => { reads++; };
    assert.equal(await device.onInit(), false);
    assert.equal(listeners, 0);
    assert.equal(pollingStarts, 0);
    assert.equal(reads, 0);
    assert.equal(timers.size, 0);
  });
}

test("Hysen SDK v3 settings validate limits and times before any write", async () => {
  const { device } = hysenHarness();
  let writes = 0;
  device.set_advanced = device.set_schedule = async () => { writes++; };
  for (const [patch, error] of [
    [{ SensorUpperLimit: 5, SensorLowerLimit: 5 }, /invalid_sensor_limits/],
    [{ weekday1: "xx:30" }, /invalid_schedule_time/],
    [{ weekday1: "25:00" }, /invalid_schedule_time/],
    [{ weekday1: "06:60" }, /invalid_schedule_time/],
  ]) {
    await assert.rejects(device.onSettings({ oldSettings: {}, newSettings: patch, changedKeys: Object.keys(patch) }), error);
  }
  assert.equal(writes, 0);
});

test("Hysen SDK v3 settings await advanced/schedule writes and commit submitted values only on success", async () => {
  const { device } = hysenHarness();
  const pending = deferred();
  let advanced, schedule;
  device.set_advanced = async (...args) => { advanced = args; await pending.promise; };
  device.set_schedule = async (value) => { schedule = value; };
  const operation = device.onSettings({ oldSettings: {}, newSettings: { SensorUpperLimit: 40, weekday1: "07:45", weekdaytemp1: 22 }, changedKeys: ["SensorUpperLimit", "weekday1", "weekdaytemp1"] });
  assert.equal(advanced[5], 40);
  assert.equal(device.data.SensorUpperLimit, 35);
  assert.equal(schedule, undefined);
  pending.resolve();
  await operation;
  assert.deepEqual(schedule[0], { time: "07:45", temp: 22 });
  assert.equal(device.data.SensorUpperLimit, 40);
  device.set_advanced = async () => { throw new Error("mock write failed"); };
  await assert.rejects(device.onSettings({ oldSettings: {}, newSettings: { SensorUpperLimit: 45 }, changedKeys: ["SensorUpperLimit"] }), /mock write failed/);
  assert.equal(device.data.SensorUpperLimit, 40);
});

test("Hysen target, parental, and settings helpers propagate failures without requested state or events", async () => {
  const { device, values, events } = hysenHarness();
  device.send_request = async () => { throw new Error("mock device rejection"); };
  await assert.rejects(device.onCapabilityTargetTemperature(25), /mock device rejection/);
  assert.equal(device.data.TargetTemperature, 21);
  await assert.rejects(device.onCapabilityParentalMode(true), /mock device rejection/);
  assert.equal(device.data.ParentalMode, false);
  assert.equal(values.get("parental_mode"), false);
  assert.equal(events.some(([kind]) => kind === "trigger" || kind === "capability"), false);
  await assert.rejects(device.set_advanced(1, 0, 0, 42, 2, 35, 5, 0, 0, 0), /mock device rejection/);
  await assert.rejects(device.set_schedule(device.data.schedule), /mock device rejection/);
  await assert.rejects(device.set_time(12, 0, 0, 1), /mock device rejection/);
});

test("Hysen real request/helper chain rejects transport and device errors before settings commit", async () => {
  for (const failure of [new Error("mock socket timeout"), { error: 17 }]) {
    const { device, events } = hysenHarness();
    const requests = [];
    device._communicate.send_packet = async (command, version, payload) => {
      requests.push({ command, version, payload: [...payload] });
      if (failure instanceof Error) throw failure;
      return failure;
    };
    const expected = failure instanceof Error ? /mock socket timeout/ : /error = 17/;
    await assert.rejects(device.onCapabilityTargetTemperature(25), expected);
    assert.equal(device.data.TargetTemperature, 21);
    await assert.rejects(device.onCapabilityParentalMode(true), expected);
    assert.equal(device.data.ParentalMode, false);
    for (const patch of [{ SensorUpperLimit: 40 }, { weekday1: "07:45" }, { AdjustClock: true }]) {
      await assert.rejects(device.onSettings({ oldSettings: {}, newSettings: patch, changedKeys: Object.keys(patch) }), expected);
    }
    assert.equal(device.data.SensorUpperLimit, 35);
    assert.equal(device.data.schedule[0].time, "06:30");
    assert.equal(events.some(([kind]) => kind === "capability" || kind === "settings" || kind === "trigger"), false);
    assert.equal(requests.length, 5);
    assert.equal(requests.every(({ command, payload }) => command === 0x6a && payload[0] === payload.length - 2), true);
  }
});

test("Hysen parental changes commit only after acknowledgment, preserve power and avoid duplicate triggers", async () => {
  const { device, values, events } = hysenHarness();
  const pending = deferred();
  const payloads = [];
  device.send_request = (payload) => { payloads.push([...payload]); return pending.promise; };
  const operation = device.onCapabilityParentalMode(true);
  assert.equal(device.data.ParentalMode, false);
  assert.equal(values.get("parental_mode"), false);
  pending.resolve();
  await operation;
  assert.deepEqual(payloads[0], [1, 6, 0, 0, 1, 1]);
  assert.equal(device.data.ParentalMode, true);
  await device.do_action_parentalmode_on();
  assert.deepEqual(events.filter(([kind]) => kind === "trigger"), [["trigger", "parental on"], ["trigger", "parental changed"]]);
});

for (const failedStage of ["capability", "trigger"]) {
  test(`Hysen keeps acknowledged parental command successful when Homey ${failedStage} fails`, async () => {
    const { device, events } = hysenHarness();
    let sends = 0;
    device._communicate.send_packet = async () => {
      sends++;
      return { error: 0, cmd: new Uint8Array(4), payload: new Uint8Array(4) };
    };
    if (failedStage === "capability") {
      device.setCapabilityValue = async () => { throw new Error("mock Homey capability failure"); };
    } else {
      device.driver.trigger_parentalmode_on.trigger = async () => { throw new Error("mock Homey Flow failure"); };
    }
    await device.do_action_parentalmode_on();
    await new Promise(setImmediate);
    assert.equal(sends, 1);
    assert.equal(device.data.ParentalMode, true);
    const errors = events.filter(([kind]) => kind === "error");
    assert.equal(errors.length, 1);
    assert.match(errors[0][1], /Homey (capability update|Flow trigger) failed/);
    assert.match(errors[0][2].message, /mock Homey/);
  });
}

function mockHysenLifecycle(t, device) {
  t.mock.method(Base.prototype, "onInit", async function () { this._communicate = { destroy() {} }; });
  t.mock.method(Base.prototype, "onUninit", function () { this.stop_check_interval(); this._communicate = null; });
  let starts = 0;
  device.start_check_interval = () => { starts++; };
  device.stop_check_interval = () => {};
  return () => starts;
}

for (const stop of ["onDeleted", "onUninit"]) {
  test(`Hysen ${stop} cancels delayed startup and a stale callback cannot restart polling`, async (t) => {
    const { device, timers } = harness(Hysen);
    const starts = mockHysenLifecycle(t, device);
    let reads = 0;
    device.get_full_status = device.get_temperature = async () => { reads++; };
    await device.onInit();
    const [id, timer] = [...timers][0];
    assert.equal(timer.delay, 4000);
    await device[stop]();
    assert.equal(timers.has(id), false);
    await timer.callback();
    assert.equal(reads, 0);
    assert.equal(starts(), 0);
  });
}

test("Hysen reinit cancels old startup and only its current generation begins polling", async (t) => {
  const { device, timers } = harness(Hysen);
  const starts = mockHysenLifecycle(t, device);
  let reads = 0;
  device.get_full_status = device.get_temperature = async () => { reads++; };
  await device.onInit();
  const oldTimer = [...timers.values()][0];
  await device.onInit();
  assert.equal(timers.size, 1);
  await oldTimer.callback();
  assert.equal(reads, 0);
  assert.notEqual(device._startupTimeout, null);
  await [...timers.values()][0].callback();
  assert.equal(reads, 2);
  assert.equal(starts(), 1);
});

test("Hysen reinit during a startup read ignores the old response and preserves its new startup timer", async (t) => {
  const { device, timers, events } = harness(Hysen);
  const starts = mockHysenLifecycle(t, device);
  const response = deferred();
  device.send_request = () => response.promise;
  await device.onInit();
  const [oldId, oldTimer] = [...timers][0];
  timers.delete(oldId);
  const oldOperation = oldTimer.callback();
  await device.onInit();
  const currentTimer = device._startupTimeout;
  response.resolve(new Uint8Array(48));
  await oldOperation;
  assert.equal(device._startupTimeout, currentTimer);
  assert.equal(timers.has(currentTimer), true);
  assert.equal(events.some(([kind]) => kind === "capability" || kind === "settings" || kind === "trigger"), false);
  assert.equal(starts(), 0);
});

for (const stop of ["onDeleted", "onUninit"]) {
  test(`Hysen ${stop} during startup read prevents late capability writes and polling`, async (t) => {
    const { device, timers, events } = harness(Hysen);
    const starts = mockHysenLifecycle(t, device);
    const response = deferred();
    device.send_request = () => response.promise;
    await device.onInit();
    const pending = [...timers.values()][0].callback();
    await device[stop]();
    response.resolve(new Uint8Array(48));
    await pending;
    assert.equal(events.some(([kind]) => kind === "capability" || kind === "settings" || kind === "trigger"), false);
    assert.equal(starts(), 0);
  });
}
