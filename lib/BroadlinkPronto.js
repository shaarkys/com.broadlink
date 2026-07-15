"use strict";

const BROADLINK_IR_COMMAND = 0x26;
const BROADLINK_TICK_NUMERATOR = 8192;
const BROADLINK_TICK_DENOMINATOR = 269;
const DEFAULT_CARRIER_HZ = 38000;
const PRONTO_CLOCK_US = 0.241246;

function toByteArray(data) {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Uint8Array.from(data);
  if (data && typeof data === "object") return Uint8Array.from(Object.values(data));
  throw new TypeError("Broadlink command must be a byte array.");
}

function getBroadlinkPacket(data) {
  const storedCommand = toByteArray(data);
  let packetOffset = 0;

  // Commands learned through this app include the two leading status bytes
  // returned by the RM check-data command. Raw Broadlink packets start at 0.
  if (storedCommand.length >= 3 && storedCommand[0] === 0 && storedCommand[1] === 0) {
    packetOffset = 2;
  }

  return {
    packet: storedCommand.slice(packetOffset),
    packetOffset,
    storedLength: storedCommand.length,
  };
}

function decodeBroadlinkIr(data) {
  const { packet, packetOffset, storedLength } = getBroadlinkPacket(data);
  if (packet.length < 6) {
    throw new Error("Broadlink command is too short.");
  }
  if (packet[0] !== BROADLINK_IR_COMMAND) {
    throw new Error(`Command is not infrared (expected 0x26, received 0x${packet[0].toString(16).padStart(2, "0")}).`);
  }

  const dataLength = packet[2] | (packet[3] << 8);
  if (dataLength === 0) {
    throw new Error("Broadlink IR command does not contain pulse data.");
  }

  const dataStart = 4;
  const dataEnd = dataStart + dataLength;
  if (dataEnd > packet.length) {
    throw new Error(`Broadlink IR command is truncated (declares ${dataLength} pulse bytes).`);
  }

  const ticks = [];
  for (let offset = dataStart; offset < dataEnd;) {
    let value = packet[offset++];
    if (value === 0) {
      if (offset + 1 >= dataEnd) {
        throw new Error("Broadlink IR command ends inside an extended pulse value.");
      }
      value = (packet[offset] << 8) | packet[offset + 1];
      offset += 2;
    }
    if (value === 0) {
      throw new Error("Broadlink IR command contains a zero-length pulse.");
    }
    ticks.push(value);
  }

  if (ticks.length % 2 !== 0) {
    throw new Error(`Broadlink IR command contains ${ticks.length} timings; Pronto Hex requires mark/space pairs.`);
  }

  const durationsUs = ticks.map((value) => value * BROADLINK_TICK_NUMERATOR / BROADLINK_TICK_DENOMINATOR);
  const hasTerminator = packet.length >= dataEnd + 2 && packet[dataEnd] === 0x0d && packet[dataEnd + 1] === 0x05;
  const longGapCount = durationsUs.reduce((count, duration, index) => {
    return count + (index % 2 === 1 && duration >= 15000 ? 1 : 0);
  }, 0);

  return {
    durationsUs,
    repeatCount: packet[1],
    dataLength,
    hasTerminator,
    longGapCount,
    packetOffset,
    storedLength,
  };
}

function formatProntoWord(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`Pronto Hex value ${value} is outside the 16-bit range.`);
  }
  return value.toString(16).toUpperCase().padStart(4, "0");
}

function broadlinkToPronto(data, options = {}) {
  const carrierHz = Number(options.carrierHz ?? DEFAULT_CARRIER_HZ);
  if (!Number.isFinite(carrierHz) || carrierHz < 10000 || carrierHz > 100000) {
    throw new Error("Carrier frequency must be between 10000 and 100000 Hz.");
  }

  const decoded = decodeBroadlinkIr(data);
  const frequencyWord = Math.round(1000000 / (carrierHz * PRONTO_CLOCK_US));
  const prontoUnitUs = frequencyWord * PRONTO_CLOCK_US;
  const burstPairs = decoded.durationsUs.length / 2;
  if (burstPairs > 0xffff) {
    throw new Error("Broadlink IR command contains too many pulse pairs for Pronto Hex.");
  }

  const timingWords = decoded.durationsUs.map((durationUs) => {
    const value = Math.max(1, Math.round(durationUs / prontoUnitUs));
    return formatProntoWord(value);
  });

  const words = [
    "0000",
    formatProntoWord(frequencyWord),
    formatProntoWord(burstPairs),
    "0000",
    ...timingWords,
  ];

  const warnings = [
    `The learned Broadlink data does not contain its original carrier frequency; ${Math.round(carrierHz)} Hz was used.`,
  ];
  if (carrierHz > 45000 || carrierHz < 30000) {
    warnings.push("This carrier is outside Homey's documented 30-45 kHz range for app-defined IR signals; Pronto Hex transmission must be tested on the target Homey hardware.");
  }
  if (!decoded.hasTerminator) {
    warnings.push("The stored command has no standard Broadlink IR terminator, although its declared pulse data is valid.");
  }
  if (decoded.repeatCount > 0) {
    warnings.push(`The Broadlink packet requests ${decoded.repeatCount} additional repeat(s); this is not embedded in the generated one-shot Pronto Hex.`);
  }
  if (decoded.longGapCount > 1) {
    warnings.push(`The capture contains ${decoded.longGapCount} long spaces and may already include repeated frames.`);
  }

  return {
    prontoHex: words.join(" "),
    carrierHz: Math.round(carrierHz),
    carrierSource: "assumed",
    frequencyWord,
    burstPairs,
    timingCount: decoded.durationsUs.length,
    broadlinkRepeatCount: decoded.repeatCount,
    longGapCount: decoded.longGapCount,
    packetOffset: decoded.packetOffset,
    inputFormat: decoded.packetOffset === 2 ? "homey-check-data" : "broadlink-raw",
    suggestedHomeyRepetitions: 1,
    warnings,
  };
}

module.exports = {
  DEFAULT_CARRIER_HZ,
  decodeBroadlinkIr,
  broadlinkToPronto,
};
