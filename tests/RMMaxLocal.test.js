'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { probe, sendCode, isPrivateIPv4 } = require('../lib/RMMaxLocal');
const input = { ipAddress: '192.168.1.30', credentials: { mac: 'aabbccddeeff', id: [1, 2, 3, 4], key: Array.from({ length: 16 }, (_, i) => i) } };
const iv = Buffer.from('562e17996d093d28ddb3ba695a2e6f58', 'hex');
function checksum(data) { return (0xbeaf + Array.from(data).reduce((a, b) => a + b, 0)) & 0xffff; }
function reply(request, clear, status = 0, key = input.credentials.key) {
  const header = Buffer.from(request.subarray(0, 0x38)); header.writeInt16LE(status, 0x22); header.writeUInt16LE(0, 0x20);
  let cipherText = Buffer.alloc(0);
  if (clear) {
    const padded = Buffer.alloc(Math.ceil(clear.length / 16) * 16); clear.copy(padded);
    header.writeUInt16LE(checksum(padded), 0x34);
    const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key), iv); cipher.setAutoPadding(false); cipherText = Buffer.concat([cipher.update(padded), cipher.final()]);
  }
  const packet = Buffer.concat([header, cipherText]); packet.writeUInt16LE(checksum(packet), 0x20); return packet;
}
function factory(handler) {
  const state = { sends: 0, closed: 0 };
  state.socketFactory = () => {
    const socket = new EventEmitter(); socket.close = () => { state.closed++; };
    socket.send = (packet, offset, length, port, ip, callback) => { state.sends++; assert.equal(ip, input.ipAddress); assert.equal(port, 80); callback(null); setImmediate(() => handler(socket, packet)); };
    return socket;
  };
  return state;
}
const peer = { address: input.ipAddress, port: 80 };
test('private IPv4 validation rejects malformed, public, and obvious subnet boundaries', () => {
  for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.3.4', '192.168.1.1']) assert.equal(isPrivateIPv4(ip), true);
  for (const ip of ['172.32.1.2', '8.8.8.8', '192.168.1.0', '192.168.1.255', '010.1.2.3', '10.1.1.256']) assert.equal(isPrivateIPv4(ip), false);
});
test('probe sends encrypted firmware query and validates response', async () => {
  const state = factory((socket, packet) => {
    assert.equal(packet.readUInt16LE(0x24), 0xaf8b); assert.equal(packet[0x26], 0x6a);
    const decrypt = crypto.createDecipheriv('aes-128-cbc', Buffer.from(input.credentials.key), iv); decrypt.setAutoPadding(false);
    assert.equal(Buffer.concat([decrypt.update(packet.subarray(0x38)), decrypt.final()])[0], 0x68);
    socket.emit('message', reply(packet, Buffer.from([0, 0, 0, 0, 0x34, 0x12])), peer);
  });
  assert.deepEqual(await probe(input, state), { firmware: 0x1234 }); assert.equal(state.sends, 1); assert.equal(state.closed, 1);
});
test('send validates acknowledgment and performs exactly one send', async () => {
  const state = factory((socket, packet) => {
    const decrypt = crypto.createDecipheriv('aes-128-cbc', Buffer.from(input.credentials.key), iv); decrypt.setAutoPadding(false);
    assert.equal(Buffer.concat([decrypt.update(packet.subarray(0x38)), decrypt.final()]).subarray(0, 6).toString('hex'), '02000000aabb');
    socket.emit('message', reply(packet, Buffer.from('02000000', 'hex')), peer);
  });
  await sendCode(input, 'aabb', state); assert.equal(state.sends, 1); assert.equal(state.closed, 1);
});
test('signed device errors are preserved without requiring an ID or encrypted payload', async () => {
  for (const code of [-1, -7]) {
    const state = factory((socket, packet) => { const result = reply(packet, null, code); result.fill(0, 0x30, 0x34); result.writeUInt16LE(0, 0x20); result.writeUInt16LE(checksum(result), 0x20); socket.emit('message', result, peer); });
    await assert.rejects(probe(input, state), error => error.deviceError === code); assert.equal(state.closed, 1);
  }
});
test('wrong peer, counter and MAC ignored until valid response', async () => {
  const state = factory((socket, packet) => {
    const good = reply(packet, Buffer.from([0, 0, 0, 0, 8, 0]));
    socket.emit('message', good, { address: '192.168.1.31', port: 80 }); socket.emit('message', good, { ...peer, port: 81 });
    const wrong = Buffer.from(good); wrong[0x28] ^= 1; socket.emit('message', wrong, peer);
    const wrongMac = Buffer.from(good); wrongMac[0x2a] ^= 1; socket.emit('message', wrongMac, peer);
    socket.emit('message', good, peer);
  });
  assert.deepEqual(await probe(input, state), { firmware: 8 }); assert.equal(state.closed, 1);
});
test('wrong key, corrupt checksum, short success and invalid ack rejected', async () => {
  for (const kind of ['wrongkey', 'corrupt', 'short', 'ack']) {
    const state = factory((socket, packet) => {
      let result = kind === 'short' ? reply(packet, null) : reply(packet, Buffer.from([0, 0, 0, 0, 8, 0]), 0, kind === 'wrongkey' ? Array(16).fill(255) : input.credentials.key);
      if (kind === 'corrupt') result[result.length - 1] ^= 1;
      socket.emit('message', result, peer);
    });
    await assert.rejects(kind === 'ack' ? sendCode(input, 'aabb', state) : probe(input, state)); assert.equal(state.closed, 1);
  }
});
test('timeout and invalid inputs do not retry or leak sockets', async () => {
  const state = factory(() => {});
  await assert.rejects(probe(input, { ...state, timeoutMs: 5 }), e => e.code === 'TIMEOUT'); assert.equal(state.closed, 1); assert.equal(state.sends, 1);
  await assert.rejects(sendCode(input, 'bad', state), /Invalid saved code/);
  await assert.rejects(probe({ ...input, ipAddress: '8.8.8.8' }, state), /Invalid local device/);
  assert.equal(state.sends, 1);
});
