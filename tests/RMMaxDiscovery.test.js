'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
let foundType;
class Comm { configure() {} async discover() { return { devtype: foundType, mac: [1, 2, 3, 4, 5, 6], ipAddress: '192.168.1.8' }; } destroy() {} }
const originalLoad = Module._load;
let RM4Driver, RM4Device;
try {
  Module._load = function (request, parent, isMain) {
    if (request === 'homey') return { Driver: class {}, Device: class {} };
    if (request === 'dgram') return { createSocket() { throw new Error('Live UDP is forbidden in this test'); } };
    if (request === './../lib/Communicate.js' && parent.filename.endsWith('BroadlinkDriver.js')) return Comm;
    return originalLoad.call(this, request, parent, isMain);
  };
  RM4Driver = require('../drivers/RM4_pro/driver'); RM4Device = require('../drivers/RM4_pro/device');
} finally { Module._load = originalLoad; }
function harness() {
  const driver = new RM4Driver(); const card = { registerRunListener() { return this; }, getArgument() { return { registerAutocompleteListener() {} }; } };
  driver.homey = { flow: { getActionCard: () => card, getDeviceTriggerCard: () => card } }; driver.log = () => {};
  driver._utils = { debugLog() {}, getHomeyIp: async () => '192.168.1.2', getDeviceInfo: () => ({ name: 'RM4 Pro', isCompatible: true }), asHex: () => '01:02:03:04:05:06', arrToHex: () => '010203040506' };
  const handlers = {}, events = []; const socket = { setHandler(name, fn) { handlers[name] = fn; }, emit(...args) { events.push(args); } };
  return { driver, handlers, events, socket };
}
test('legacy RM4 Pro discovery excludes RM Max but allows RM4 Pro', async () => {
  const h = harness(); await h.driver.onInit(); h.driver.onPair(h.socket);
  foundType = 0xaf8b; await h.handlers.start_discover({ address: '192.168.1.8' }); assert.deepEqual(await h.handlers.list_devices(), []); assert.deepEqual(h.events.at(-1), ['discovered', null]);
  foundType = 0x520b; await h.handlers.start_discover({ address: '192.168.1.8' }); assert.equal((await h.handlers.list_devices()).length, 1);
});
test('existing RM Max under legacy RM4 Pro retains command execution', async () => {
  const device = new RM4Device(); let sent; let triggers = 0;
  Object.assign(device, { _utils: { debugLog() {} }, dataStore: { getCommandData: () => [1, 2] }, _communicate: { async send_IR_RF_data_rm4pro(value) { sent = value; } }, driver: { rm4_pro_specific_cmd_trigger: { trigger() { triggers++; } }, rm4_pro_any_cmd_trigger: { trigger() { triggers++; } } }, getData: () => ({ devtype: '44939' }) });
  await device.executeCommand({ variable: { name: 'Power' } }); assert.deepEqual(sent, [1, 2]); assert.equal(triggers, 2);
});

