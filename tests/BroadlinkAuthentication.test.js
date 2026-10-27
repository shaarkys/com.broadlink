"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Module = require("node:module");
const Communicate = require("../lib/Communicate");

const originalLoad = Module._load;
let BroadlinkDevice;
let RM4ProDevice;
try {
  Module._load = function (request, parent, isMain) {
    if (request === "homey") return { Device: class {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  BroadlinkDevice = require("../lib/BroadlinkDevice");
  RM4ProDevice = require("../drivers/RM4_pro/device");
} finally {
  Module._load = originalLoad;
}

const defaultKey = Buffer.from("097628343fe99e23765c1513accf8b02", "hex");
const iv = Buffer.from("562e17996d093d28ddb3ba695a2e6f58", "hex");
const session = { id: Buffer.from([1, 2, 3, 4]), key: Buffer.alloc(16, 0x55) };
// Upstream device.py: packet[4:20] = b"1" * 16; packet[30] = packet[45] = 1;
// packet[48:54] = b"Test 1". The encrypted payload is exactly 80 bytes.
const authPayload = Buffer.from("0000000031313131313131313131313131313131000000000000000000000100000000000000000000000000000100005465737420310000000000000000000000000000000000000000000000000000", "hex");

function harness(deviceType = 0xaf8b) {
  const logs = [];
  const comm = new Communicate();
  comm.configure({ deviceType, ipAddress: "192.0.2.10", mac: Buffer.from("102030405060", "hex"), count: 1,
    homey: { settings: { get: () => false }, __: (key) => key } });
  comm._utils.debugLog = (_source, ...args) => logs.push(args.join(" "));
  return { comm, logs };
}

function successReply() {
  const plaintext = Buffer.concat([session.id, session.key, Buffer.alloc(12)]);
  const cipher = crypto.createCipheriv("aes-128-cbc", defaultKey, iv);
  cipher.setAutoPadding(false);
  return { data: Buffer.concat([Buffer.alloc(56), cipher.update(plaintext), cipher.final()]) };
}

test("authentication wire payload matches upstream for RM Max and existing device families", async () => {
  for (const type of [0xaf8b, 0x5213, 0x520c, 0x8010]) {
    const { comm, logs } = harness(type);
    comm.sendto = async (bytes) => {
      const packet = Buffer.from(bytes);
      assert.equal(packet.readUInt16LE(0x24), type);
      assert.equal(packet[0x26], 0x65);
      assert.equal(packet.length, 56 + 80);
      const decipher = crypto.createDecipheriv("aes-128-cbc", defaultKey, iv);
      decipher.setAutoPadding(false);
      assert.deepEqual(Buffer.concat([decipher.update(packet.subarray(56)), decipher.final()]), authPayload);
      return successReply();
    };
    const result = await comm.auth();
    assert.deepEqual(Buffer.from(result.id), session.id);
    assert.deepEqual(Buffer.from(result.key), session.key);
    assert.ok(logs.every((line) => !line.includes("response=") && !line.includes("resp ") && !line.includes("55,55,55")));
  }
});

test("56-byte authentication rejection preserves the signed code and response length", async () => {
  for (const [raw, signed] of [[65535, -1], [65529, -7], [65530, -6]]) {
    const { comm, logs } = harness();
    comm.sendto = async () => {
      const data = Buffer.alloc(56);
      data.writeUInt16LE(raw, 0x22);
      return { data };
    };
    await assert.rejects(comm.auth(), (err) => {
      assert.equal(err.code, signed);
      assert.match(err.message, /authentication failed.*reply length 56 bytes/);
      assert.ok(!err.message.includes("decrypt_payload"));
      return true;
    });
    assert.deepEqual(Buffer.from(comm.key), defaultKey);
    assert.deepEqual([...comm.id], [0, 0, 0, 0]);
    assert.ok(logs.every((line) => !line.includes("authentication succeeded") && !line.includes("response=")));
  }
});

test("authentication transport errors keep the underlying timeout detail", async () => {
  const { comm } = harness();
  comm.send_packet = async () => ({ error: -1, message: "UDP timeout", payload: null, cmd: null });
  await assert.rejects(comm.auth(), /authentication failed.*UDP timeout/);
});

test("malformed successful authentication replies cannot replace the session", async () => {
  for (const [keyLength, idLength] of [[0, 4], [8, 4], [16, 0], [16, 3]]) {
    const { comm } = harness();
    comm.send_packet = async () => ({ error: 0, payload: Buffer.alloc(keyLength), cmd: Buffer.alloc(idLength) });
    await assert.rejects(comm.auth(), /decrypt_keylength|four-byte device ID/);
    assert.deepEqual(Buffer.from(comm.key), defaultKey);
    assert.deepEqual([...comm.id], [0, 0, 0, 0]);
  }
});

test("newly paired RM Max authentication keeps decimal 44939 as raw type 0xAF8B", async () => {
  const { comm } = harness();
  let sends = 0;
  comm.sendto = async (packet) => {
    sends++;
    assert.equal(Buffer.from(packet).readUInt16LE(0x24), 0xaf8b);
    return successReply();
  };
  const device = Object.assign(Object.create(BroadlinkDevice.prototype), {
    _communicate: comm, _utils: comm._utils, homey: comm.homey,
    getData: () => ({ mac: "102030405060", devtype: "44939" }),
    getSettings: () => ({ ipAddress: "192.0.2.10" }),
    authenticateDevice: () => comm.auth(),
  });
  await device.onAdded();
  assert.equal(sends, 1);
});

test("manual RM Max authentication uses the submitted IP and the raw device type", async () => {
  const { comm } = harness();
  comm.sendto = async (packet, ip) => {
    assert.equal(ip, "192.0.2.11");
    assert.equal(Buffer.from(packet).readUInt16LE(0x24), 0xaf8b);
    return successReply();
  };
  const device = Object.assign(Object.create(RM4ProDevice.prototype), {
    _communicate: comm, _utils: comm._utils, homey: comm.homey,
    getData: () => ({ mac: "102030405060", devtype: "44939" }),
    getSettings: () => ({ ipAddress: "192.0.2.10" }),
    authenticateDevice: () => comm.auth(), setSettings: async () => {},
  });
  await device.onSettings({ oldSettings: { Authenticate: false },
    newSettings: { Authenticate: true, ipAddress: "192.0.2.11" }, changedKeys: ["Authenticate"] });
  await new Promise((resolve) => setImmediate(resolve));
});

test("authentication failure is recorded in normal logs when debug logging is disabled", async () => {
  const { comm } = harness();
  const failure = Object.assign(new Error("Broadlink authentication failed (Broadlink error -1); reply length 56 bytes"), { code: -1 });
  comm.auth = async () => { throw failure; };
  const errors = [];
  const device = Object.assign(Object.create(BroadlinkDevice.prototype), {
    _communicate: comm, _utils: { debugLog: () => assert.fail("must use normal diagnostics") },
    error: (...args) => errors.push(args),
    setSettings: () => assert.fail("must not save a rejected session"),
  });
  await device.authenticateDevice();
  assert.equal(errors.length, 1);
  assert.match(errors[0][0], /no authenticated session obtained/);
  assert.equal(errors[0][1], failure);
});
