'use strict';

// Keep this allowlist limited to known RM types in DeviceInfo.js.
// Raw IR/RF packets: https://github.com/DAB-LABS/broadlink-async/blob/master/broadlink_async/remote.py
// 0x5f36 is rmminib (LAN length-prefixed), despite its RM3 Mini product name.
const TYPES = new Map([
  ...[0x2737, 0x278f, 0x27c2, 0x5f36].map(type => [type, 'rm3_mini']),
  ...[0x51da, 0x5209, 0x520c, 0x520d, 0x5211, 0x5212, 0x5216, 0x521c, 0x6070, 0x610e, 0x610f, 0x62bc, 0x62be, 0x6364, 0x648d, 0x6539, 0x653a].map(type => [type, 'rm4_mini']),
  ...[0x520b, 0x5213, 0x5218, 0x6026, 0x6184, 0x61a2, 0x649b, 0x653c].map(type => [type, 'rm4_pro']),
  [0x5224, 'rm5_plus'],
]);
const LABELS = { rm3_mini: 'RM3 Mini', rm4_mini: 'RM4 Mini', rm4_pro: 'RM4 Pro', rm5_plus: 'RM5 Plus' };
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);

function readCookie(value) {
  if (record(value)) return value;
  if (typeof value !== 'string' || value.length > 16384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  try { const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8')); return record(parsed) ? parsed : null; } catch (_) { return null; }
}

function identifyHub(endpoint) {
  if (!record(endpoint)) return null;
  const sources = [endpoint];
  if (endpoint.cookie !== undefined) {
    const cookie = readCookie(endpoint.cookie);
    if (!cookie) return null;
    sources.push(cookie);
    if (cookie.device !== undefined) {
      if (!record(cookie.device)) return null;
      sources.push(cookie.device);
    }
  }
  const evidence = [];
  for (const source of sources) {
    for (const key of ['devtype', 'devType']) {
      if (source[key] === undefined) continue;
      if (!Number.isInteger(source[key]) || !TYPES.has(source[key])) return null;
      evidence.push(source[key]);
    }
    for (const key of ['productId', 'pid', 'Pid']) {
      if (source[key] === undefined) continue;
      // Recognize only the known zero-padded BroadLink PID layout: zero prefix,
      // little-endian 16-bit device type, then two zero bytes.
      if (typeof source[key] !== 'string' || !/^0{24}[a-f\d]{4}0{4}$/i.test(source[key])) return null;
      const type = Buffer.from(source[key].slice(24, 28), 'hex').readUInt16LE();
      if (!TYPES.has(type)) return null;
      evidence.push(type);
    }
  }
  if (!evidence.length || evidence.some(type => type !== evidence[0])) return null;
  const model = TYPES.get(evidence[0]);
  if (endpoint.model !== undefined && endpoint.model !== model) return null;
  return { model, devtype: evidence[0] };
}

function modelLabel(model) { return typeof model === 'string' && Object.prototype.hasOwnProperty.call(LABELS, model) ? LABELS[model] : ''; }

function validateCode(model, hex) {
  if (!modelLabel(model) || typeof hex !== 'string' || hex.length > 131062 || !/^(?:[a-f\d]{2}){6,}$/i.test(hex)) return false;
  const packet = Buffer.from(hex, 'hex');
  if (packet[0] !== 0x26 && (model !== 'rm4_pro' || ![0xb1, 0xb2, 0xd7].includes(packet[0]))) return false;
  const end = 4 + packet.readUInt16LE(2);
  let offset = packet[0] === 0xb1 ? 8 : 4;
  if (end > packet.length || end <= offset) return false;
  if (packet[0] === 0xb1 && (!packet.readUInt32LE(4) || packet.readUInt32LE(4) > 1000000 || packet[1] !== 0xc0)) return false;
  let timings = 0;
  while (offset < end) {
    let ticks = packet[offset++];
    if (!ticks) {
      if (offset + 2 > end) return false;
      ticks = packet.readUInt16BE(offset); offset += 2;
    }
    if (!ticks) return false;
    timings++;
  }
  if (timings < 2 || (packet[0] === 0x26 && timings % 2)) return false;
  let tail = end;
  // Some exported IR packets put the terminator outside the timing length.
  if (packet[0] === 0x26 && packet[tail] === 0x0d && packet[tail + 1] === 0x05) tail += 2;
  return packet.length - tail <= 16 && packet.subarray(tail).every(byte => byte === 0);
}

function encodeCommand(hub, hex) {
  const identified = identifyHub(hub);
  if (!identified) throw new Error('Unsupported or conflicting RM hub identity');
  if (!validateCode(identified.model, hex)) throw new Error('Invalid saved RM code');
  const data = Buffer.from(hex, 'hex');
  // SDK commonControl takes the command word and raw code for every model.
  // The vendor's LAN packet builder adds the RM4 length field; it is not part
  // of the HTTP passthrough input (BLLetCoreAndroid 2.14.10, bl_tfb_data_pack).
  return Buffer.concat([Buffer.from('02000000', 'hex'), data]);
}

module.exports = { identifyHub, modelLabel, validateCode, encodeCommand };
