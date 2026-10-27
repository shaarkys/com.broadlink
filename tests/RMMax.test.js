"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const Communicate = require("../lib/Communicate");

const originalLoad = Module._load;
let RM4ProDevice;
try {
  Module._load = function (request, parent, isMain) {
    if (request === "homey") return { Device: class {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  RM4ProDevice = require("../drivers/RM4_pro/device");
} finally {
  Module._load = originalLoad;
}

function harness() {
  const comm = new Communicate();
  comm.configure({ deviceType: "0xaf8b", homey: {
    settings: { get: () => null }, __: (key) => key,
    setTimeout: (fn) => { queueMicrotask(fn); return 1; },
  } });
  const packets = [];
  const responses = [];
  comm.send_packet = async (command, _version, payload) => {
    assert.equal(command, 0x6a);
    packets.push(Buffer.from(payload));
    return responses.shift() || { error: 0 };
  };
  return { comm, packets, responses };
}

test("RM Max sends raw and Homey-stored IR/RF using the legacy four-byte prefix", async () => {
  const { comm, packets } = harness();
  for (const marker of [0x26, 0xb2, 0xd7]) {
    const raw = Buffer.from([marker, 2, 2, 0, 0x10, 0x20, 0x0d, 5]);
    const stored = Buffer.concat([Buffer.alloc(2), raw, Buffer.alloc(12)]);
    for (const data of [raw, stored, [...stored]]) await comm.send_IR_RF_data_rm4pro(data);
    const expected = Buffer.concat([Buffer.from([2, 0, 0, 0]), raw]);
    for (const packet of packets.splice(0)) assert.deepEqual(packet, expected);
    assert.deepEqual(stored.subarray(2, 10), raw);
  }
  for (const invalid of [null, {}, [], [0x26, 0, 4, 0, 1], [0x27, 0, 1, 0, 1]]) {
    await assert.rejects(comm.send_IR_RF_data_rm4pro(invalid), /command/);
  }
  assert.equal(packets.length, 0);
});

test("RM Max IR learning uses legacy commands and preserves the Homey status prefix", async () => {
  const { comm, packets, responses } = harness();
  const raw = Buffer.from("260002001020", "hex");
  await comm.enter_learning_red();
  responses.push({ error: 65526 }, { error: 0, payload: raw }); // -10: waiting for IR data.
  assert.deepEqual(Buffer.from(await comm.check_IR_data_red()), Buffer.concat([Buffer.alloc(2), raw]));
  assert.deepEqual(packets.map((packet) => [...packet]), [[3, 0, 0, 0], [4, 0, 0, 0], [4, 0, 0, 0]]);
});

test("RM Max RF sweep, frequency read, capture and cancellation use legacy offsets", async () => {
  const { comm, packets, responses } = harness();
  const frequency = comm.encodeRFFrequency_rm4pro(433.92);
  await comm.enterRFSweep_rm4pro();
  responses.push({ error: 0, payload: Buffer.alloc(5) }, { error: 0, payload: Buffer.concat([Buffer.from([1]), frequency]) });
  assert.deepEqual(Buffer.from(await comm.checkRFData_rm4pro()), frequency);
  const raw = Buffer.from("b20002001020", "hex");
  responses.push({ error: 0 }, { error: 0, payload: raw });
  assert.deepEqual(Buffer.from(await comm.checkRFData2_rm4pro(frequency)), Buffer.concat([Buffer.alloc(2), raw]));
  await comm.cancelRFSweep_rm4pro();
  assert.deepEqual(packets.map((packet) => packet.toString("hex")), [
    "19000000", "1a000000", "1a000000", "1b000000009f0600", "04000000", "1e000000",
  ]);
});

test("RM Max stops on authentication/protocol errors without inventing lock evidence", async () => {
  const { comm, packets, responses } = harness();
  for (const error of [65535, 65529, 65530]) {
    responses.push({ error });
    await assert.rejects(comm.enter_learning_red(), (err) => err.code === error - 65536 && !/locked/.test(err.message));
  }
  assert.equal(packets.length, 3);
  responses.push(...Array.from({ length: 8 }, () => ({ error: 65526 })));
  await assert.rejects(comm.check_IR_data_red(), /timed out/);
  assert.equal(packets.length, 11);
});

test("RM Max RF search is bounded and invalid captured replies cannot become commands", async () => {
  const { comm, packets, responses } = harness();
  responses.push(...Array.from({ length: 10 }, () => ({ error: 0, payload: Buffer.alloc(5) })));
  await assert.rejects(comm.checkRFData_rm4pro(), /no_key_detected/);
  assert.equal(packets.length, 10);
  for (const payload of [Buffer.alloc(16), Buffer.from([0x26, 0, 4, 0, 1])]) {
    responses.push({ error: 0, payload });
    await assert.rejects(comm.check_IR_data_red(), /Invalid RM Max/);
  }
});

test("existing RM4 Pro command packets keep their original framing", async () => {
  const { comm, packets } = harness();
  comm.deviceType = 0x520b;
  await comm.enter_learning_red();
  await comm.enterRFSweep_rm4pro();
  await comm.cancelRFSweep_rm4pro();
  await comm.send_IR_RF_data_rm4pro(Buffer.from([0x26, 0, 2, 0, 1, 2]));
  assert.deepEqual(packets.map((packet) => packet.subarray(0, 6).toString("hex")), [
    "040003000000", "040019000000", "04001e000000", "da0002000000",
  ]);
});

test("failed RM Max sends reject the Flow action without firing sent triggers", async () => {
  const device = {
    getData: () => ({ devtype: String(0xaf8b) }),
    _utils: { debugLog() {} },
    _communicate: { send_IR_RF_data_rm4pro: async () => { throw new Error("device rejected command"); } },
    dataStore: { getCommandData: () => Buffer.from("260002001020", "hex") },
    driver: {
      rm4_pro_specific_cmd_trigger: { trigger: () => assert.fail("must not trigger") },
      rm4_pro_any_cmd_trigger: { trigger: () => assert.fail("must not trigger") },
    },
  };
  await assert.rejects(RM4ProDevice.prototype.executeCommand.call(device, { variable: { name: "TV" } }), /device rejected/);
});

test("RM Max does not issue unsupported RM4 sensor requests", async () => {
  await RM4ProDevice.prototype.pollTempHumidity.call({
    getData: () => ({ devtype: String(0xaf8b) }),
    _communicate: { checkTempHumidity_rm4pro: () => assert.fail("RM4 sensor request") },
  });
});
