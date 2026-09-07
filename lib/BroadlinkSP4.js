"use strict";

/*
 * Upstream python-broadlink is licensed under the MIT License (MIT).
 * Copyright (c) 2014 Mike Ryan
 * Copyright (c) 2016 Matthew Garrett
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

// Port of mjg59/python-broadlink broadlink/switch.py (sp4 and sp4b).
// See docs/SCB1E.md for the pinned upstream reference and wire fixtures.
const SENSOR_FIELDS = ["current", "volt", "power", "totalconsum", "overload"];

function getVariant(deviceType) {
  switch (Number(deviceType)) {
    case 0xa56b: return "SP4";
    case 0x5115:
    case 0x6113: return "SP4B";
    default: throw new Error(`Unsupported SCB1E device type: ${deviceType}`);
  }
}

function frameOffset(variant) {
  if (variant === "SP4") return 0;
  if (variant === "SP4B") return 2;
  throw new Error(`Unsupported SCB1E protocol variant: ${variant}`);
}

function encode(variant, flag, state) {
  const offset = frameOffset(variant);
  const data = Buffer.from(JSON.stringify(state), "utf8");
  const packet = Buffer.alloc(offset + 12 + data.length);
  if (offset) packet.writeUInt16LE(12 + data.length, 0);
  packet.writeUInt16LE(0xa5a5, offset);
  packet.writeUInt16LE(0x5a5a, offset + 2);
  packet[offset + 6] = flag;
  packet[offset + 7] = 0x0b;
  packet.writeUInt32LE(data.length, offset + 8);
  data.copy(packet, offset + 12);
  const checksum = packet.subarray(offset).reduce((sum, byte) => sum + byte, 0xbeaf) & 0xffff;
  packet.writeUInt16LE(checksum, offset + 4);
  return packet;
}

function decode(variant, response, normalizeSensors = false) {
  const offset = frameOffset(variant);
  if (!response || response.error !== 0) {
    throw new Error(`${variant} response error ${response ? response.error : "missing"}${response && response.message ? `: ${response.message}` : ""}`);
  }
  if (!(response.decryptedPayload instanceof Uint8Array)) {
    throw new Error(`${variant} response has no decrypted payload`);
  }
  const payload = Buffer.from(response.decryptedPayload);
  const start = offset + 12;
  if (payload.length < start) throw new Error(`${variant} response header is truncated`);
  const length = payload.readUInt32LE(offset + 8);
  if (length === 0 || length > payload.length - start) {
    throw new Error(`${variant} response JSON length is invalid (${length})`);
  }
  let state;
  try {
    state = JSON.parse(payload.subarray(start, start + length).toString("utf8"));
  } catch (err) {
    // JSON parser messages can include arbitrary response content.
    throw new Error(`${variant} response contains invalid JSON`);
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error(`${variant} response state must be an object`);
  }
  if (state.pwr !== undefined && ![0, 1, false, true].includes(state.pwr)) {
    throw new Error(`${variant} response has invalid pwr`);
  }
  for (const field of SENSOR_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(state, field) && !Number.isFinite(state[field])) {
      throw new Error(`${variant} response has invalid ${field}`);
    }
    // Upstream normalizes only sp4b.get_state(), not set_state() responses.
    if (variant === "SP4B" && normalizeSensors && Object.prototype.hasOwnProperty.call(state, field)) {
      if (state[field] === -1) delete state[field];
      else state[field] /= 1000;
    }
  }
  return state;
}

module.exports = { getVariant, encode, decode };
