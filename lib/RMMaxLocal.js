'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const IV = Buffer.from('562e17996d093d28ddb3ba695a2e6f58', 'hex');
const SIGNATURE = Buffer.from('5aa5aa555aa5aa55', 'hex');
const MAX_PACKET = 65507;

function isPrivateIPv4(ip) {
  if (typeof ip !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(ip)) return false;
  const n = ip.split('.').map(Number);
  if (n.some(x => x > 255) || n[3] === 0 || n[3] === 255) return false;
  return n[0] === 10 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168);
}
function validate(input, options) {
  if (!input || !isPrivateIPv4(input.ipAddress) || !input.credentials) throw new Error('Invalid local device configuration');
  const c = input.credentials;
  const bytes = (a, length) => Array.isArray(a) && a.length === length && a.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
  if (typeof c.mac !== 'string' || !/^[0-9a-f]{12}$/.test(c.mac) || !bytes(c.id, 4) || !bytes(c.key, 16)) throw new Error('Invalid local device credentials');
  const timeout = options.timeoutMs === undefined ? 5000 : options.timeoutMs;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 5000 || (options.socketFactory !== undefined && typeof options.socketFactory !== 'function')) throw new Error('Invalid local request options');
  return timeout;
}
function checksum(data) { let sum = 0xbeaf; for (const byte of data) sum = (sum + byte) & 0xffff; return sum; }
function frame(payload, credentials, counter) {
  const clear = Buffer.alloc(Math.ceil(payload.length / 16) * 16); payload.copy(clear);
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(credentials.key), IV); cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
  const packet = Buffer.alloc(0x38 + encrypted.length); SIGNATURE.copy(packet);
  packet.writeUInt16LE(0xaf8b, 0x24); packet[0x26] = 0x6a; packet.writeUInt16LE(counter, 0x28);
  Buffer.from(credentials.mac, 'hex').reverse().copy(packet, 0x2a); Buffer.from(credentials.id).copy(packet, 0x30);
  packet.writeUInt16LE(checksum(clear), 0x34); encrypted.copy(packet, 0x38);
  packet.writeUInt16LE(checksum(packet), 0x20); return packet;
}
function packetChecksum(packet) {
  const copy = Buffer.from(packet); const expected = copy.readUInt16LE(0x20); copy.writeUInt16LE(0, 0x20);
  return checksum(copy) === expected;
}
function exchange(input, payload, options) {
  const timeout = validate(input, options); const credentials = input.credentials;
  const counter = crypto.randomBytes(2).readUInt16LE(0) | 0x8000;
  const packet = frame(payload, credentials, counter);
  return new Promise((resolve, reject) => {
    let socket; let timer; let done = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer);
      if (socket) { try { socket.close(); } catch (_) {} }
      if (error) reject(error); else resolve(value);
    };
    try {
      socket = options.socketFactory ? options.socketFactory() : dgram.createSocket('udp4');
      socket.on('error', () => finish(new Error('Local device communication failed')));
      socket.on('message', (msg, peer) => {
        if (!peer || peer.address !== input.ipAddress || peer.port !== 80 || !Buffer.isBuffer(msg) || msg.length < 0x38 || msg.length > MAX_PACKET) return;
        if (!msg.subarray(0, 8).equals(SIGNATURE) || msg.readUInt16LE(0x28) !== counter || !msg.subarray(0x2a, 0x30).equals(Buffer.from(credentials.mac, 'hex').reverse())) return;
        if (!packetChecksum(msg)) { finish(new Error('Invalid local device response')); return; }
        const status = msg.readInt16LE(0x22);
        if (status !== 0) { const error = new Error('Local device rejected request'); error.deviceError = status; finish(error); return; }
        if (msg.length < 0x48 || (msg.length - 0x38) % 16 !== 0) { finish(new Error('Invalid local device response')); return; }
        try {
          const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(credentials.key), IV); decipher.setAutoPadding(false);
          const clear = Buffer.concat([decipher.update(msg.subarray(0x38)), decipher.final()]);
          if (checksum(clear) !== msg.readUInt16LE(0x34)) { finish(new Error('Invalid local device response')); return; }
          finish(null, clear);
        } catch (_) { finish(new Error('Invalid local device response')); }
      });
      timer = setTimeout(() => { const error = new Error('Local device request timed out'); error.code = 'TIMEOUT'; finish(error); }, timeout);
      socket.send(packet, 0, packet.length, 80, input.ipAddress, error => { if (error) finish(new Error('Local device communication failed')); });
    } catch (_) { finish(new Error('Local device communication failed')); }
  });
}
async function probe(input, options = {}) {
  const payload = await exchange(input, Buffer.from([0x68]), options);
  if (payload.length < 6 || !payload.some(byte => byte !== 0)) throw new Error('Invalid firmware response');
  return { firmware: payload.readUInt16LE(4) };
}
async function sendCode(input, hex, options = {}) {
  if (typeof hex !== 'string' || hex.length < 2 || hex.length > 130872 || !/^(?:[a-f\d]{2})+$/i.test(hex)) throw new Error('Invalid saved code');
  const payload = await exchange(input, Buffer.concat([Buffer.from('02000000', 'hex'), Buffer.from(hex, 'hex')]), options);
  if (payload.length < 4 || payload.readUInt32LE(0) !== 2 || payload.subarray(4).some(byte => byte !== 0)) throw new Error('Invalid local device acknowledgment');
}
module.exports = { probe, sendCode, isPrivateIPv4 };

