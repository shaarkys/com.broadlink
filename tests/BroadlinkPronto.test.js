"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { decodeBroadlinkIr, broadlinkToPronto } = require("../lib/BroadlinkPronto");

test("decodes one-byte and extended Broadlink timings", () => {
  const packet = Uint8Array.from([
    0x26, 0x00, 0x06, 0x00,
    0x10, 0x00, 0x01, 0x24, 0x92, 0x20,
    0x0d, 0x05,
  ]);

  const decoded = decodeBroadlinkIr(packet);

  assert.equal(decoded.durationsUs.length, 4);
  assert.equal(decoded.repeatCount, 0);
  assert.equal(decoded.hasTerminator, true);
  assert.ok(Math.abs(decoded.durationsUs[0] - (16 * 8192 / 269)) < 0.001);
  assert.ok(Math.abs(decoded.durationsUs[1] - (292 * 8192 / 269)) < 0.001);
});

test("converts a Broadlink IR packet to one-shot 38 kHz Pronto Hex", () => {
  const packet = Uint8Array.from([
    0x26, 0x00, 0x06, 0x00,
    0x10, 0x00, 0x01, 0x24, 0x92, 0x20,
    0x0d, 0x05,
  ]);

  const result = broadlinkToPronto(packet);

  assert.equal(result.prontoHex, "0000 006D 0002 0000 0013 0152 00A9 0025");
  assert.equal(result.carrierHz, 38000);
  assert.equal(result.carrierSource, "assumed");
  assert.equal(result.burstPairs, 2);
  assert.equal(result.suggestedHomeyRepetitions, 1);
});

test("converts an IR command stored with the Homey check-data status prefix", () => {
  const storedCommand = Uint8Array.from([
    0x00, 0x00,
    0x26, 0x00, 0x06, 0x00,
    0x10, 0x00, 0x01, 0x24, 0x92, 0x20,
    0x0d, 0x05, 0x00, 0x00,
  ]);

  const result = broadlinkToPronto(storedCommand);

  assert.equal(result.prontoHex, "0000 006D 0002 0000 0013 0152 00A9 0025");
  assert.equal(result.inputFormat, "homey-check-data");
  assert.equal(result.packetOffset, 2);
  assert.equal(result.pulseDataLength, 6);
  assert.equal(result.hasTerminator, true);
  assert.equal(result.minDurationUs, 487);
  assert.equal(result.maxDurationUs, 8892);
});

test("allows an experimental 56 kHz Pronto carrier and reports the Homey caveat", () => {
  const packet = Uint8Array.from([
    0x26, 0x00, 0x02, 0x00,
    0x10, 0x20,
    0x0d, 0x05,
  ]);

  const result = broadlinkToPronto(packet, { carrierHz: 56000 });

  assert.equal(result.frequencyWord, 0x004a);
  assert.match(result.prontoHex, /^0000 004A 0001 0000 /);
  assert.ok(result.warnings.some((warning) => warning.includes("outside Homey's documented 30-45 kHz range")));
});

test("reports repeat metadata and multiple long spaces without changing the capture", () => {
  const packet = Uint8Array.from([
    0x26, 0x02, 0x08, 0x00,
    0x10, 0x00, 0x02, 0x91,
    0x10, 0x00, 0x02, 0x91,
    0x0d, 0x05,
  ]);

  const result = broadlinkToPronto(packet);

  assert.equal(result.broadlinkRepeatCount, 2);
  assert.equal(result.longGapCount, 2);
  assert.ok(result.warnings.some((warning) => warning.includes("additional repeat")));
  assert.ok(result.warnings.some((warning) => warning.includes("may already include repeated frames")));
});

test("rejects non-IR and malformed Broadlink packets", () => {
  assert.throws(
    () => broadlinkToPronto([0xb2, 0x00, 0x02, 0x00, 0x10, 0x20]),
    /not infrared/,
  );
  assert.throws(
    () => broadlinkToPronto([0x00, 0x00, 0xb2, 0x00, 0x02, 0x00, 0x10, 0x20]),
    /received 0xb2/,
  );
  assert.throws(
    () => broadlinkToPronto([0x26, 0x00, 0x04, 0x00, 0x10, 0x20]),
    /truncated/,
  );
  assert.throws(
    () => broadlinkToPronto([0x26, 0x00, 0x01, 0x00, 0x10, 0x0d, 0x05]),
    /mark\/space pairs/,
  );
});
