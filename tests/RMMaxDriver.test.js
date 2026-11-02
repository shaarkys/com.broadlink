'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');

let scenario;
const hub = { endpointId: 'hub1', productId: 'rmmax', friendlyName: 'Living room', mac: 'aabbccddeeff', cookie: 'private-cookie', valid: true };
const remote = { endpointId: 'remote1', gatewayId: 'hub1', friendlyName: 'Remote' };
const creds = { mac: hub.mac, id: [1, 2, 3, 4], key: Array(16).fill(7) };
const account = { provider: 'broadlink_eu', userId: 'owner', loginSession: 'secret-session' };
const magic = { provider: 'magic_home', region: 'eu', accessToken: 'secret-token', refreshToken: 'secret-refresh', expiresAt: 9999999999999 };
const copy = x => JSON.parse(JSON.stringify(x));
class EU {
  constructor(session) { this.session = copy(session); }
  static async login() { return scenario.login ? scenario.login() : copy(account); }
  getSession() { return copy(this.session); }
  async listHomes() { return copy(scenario.homes || [{ id: 'home1', name: 'Home' }]); }
  async listDevices() { return scenario.listDevices ? scenario.listDevices() : copy(scenario.endpoints || [hub, remote]); }
  async getRemote() { if (scenario.remoteError) throw Error('sensitive failure'); return { irData: Array.from({ length: 10 }, (_, i) => ({ name: `RF${i}`, codeList: [{ code: 'aabb' + i.toString(16).padStart(2, '0') }] })) }; }
  async sendCode() { scenario.cloudSends++; if (scenario.sendError) throw Error('sensitive failure'); }
}
class Magic extends EU {
  static async authorize() { return copy(magic); }
}
const cloud = { BroadlinkCloud: EU, MagicHomeCloud: Magic, extractCredentials: endpoint => endpoint.valid ? copy(creds) : null, isRMMaxEndpoint: endpoint => endpoint.productId === 'rmmax' };
const local = { isPrivateIPv4: ip => /^192\.168\.1\.\d+$/.test(ip), async probe() { scenario.probes++; if (scenario.probeError) throw Error('probe failure'); return { firmware: 123 }; }, async sendCode() { scenario.localSends++; if (scenario.sendError) throw Error('send failure'); } };
const originalLoad = Module._load;
let Driver, Device, commands;
try {
  Module._load = function (request, parent, isMain) {
    if (request === 'homey') return { Driver: class {}, Device: class {} };
    if (request.endsWith('/BroadlinkCloud') || request === './BroadlinkCloud') return cloud;
    if (request.endsWith('/RMMaxLocal')) return local;
    return originalLoad.call(this, request, parent, isMain);
  };
  Driver = require('../drivers/RM_max/driver'); Device = require('../drivers/RM_max/device'); commands = require('../lib/RMMaxCommands');
} finally { Module._load = originalLoad; }
function reset() { scenario = { cloudSends: 0, localSends: 0, probes: 0 }; }
function makeDriver() {
  const trigger = { calls: [], async trigger(...args) { this.calls.push(args); } };
  const d = new Driver(); d.log = () => {}; d.getDevices = () => [];
  d.homey = { setTimeout: () => 1, clearTimeout: () => {}, flow: { getActionCard: () => ({ registerRunListener() { return this; }, getArgument() { return { registerAutocompleteListener() {} }; } }), getDeviceTriggerCard: () => trigger } };
  return { driver: d, trigger };
}
async function pair(driver, provider = 'broadlink_eu', repairDevice) {
  const handlers = {}; const socket = { setHandler: (name, fn) => { handlers[name] = fn; } };
  if (repairDevice) driver.onRepair(socket, repairDevice); else driver.onPair(socket);
  const login = await handlers.cloud_login(provider === 'broadlink_eu' ? { provider, email: 'mail@example.org', password: 'secret-password' } : { provider, authCode: 'secret-code', region: 'eu' });
  const discovery = await handlers.cloud_discover(provider === 'broadlink_eu' ? { homeId: 'home1' } : {});
  return { handlers, login, discovery };
}
function makeDevice(driver, bundle, settings = { transport: 'cloud', ipAddress: '192.168.1.20' }) {
  const device = new Device(); let stored = copy(bundle); const id = commands.deviceId(bundle.session, bundle.hub);
  Object.assign(device, { driver, homey: driver.homey, log() {}, getData: () => ({ id }), getSetting: key => settings[key], getStoreValue: key => key === 'rmmax_cloud' ? stored : null,
    async setStoreValue(key, value) { if (key === 'rmmax_cloud') stored = copy(value); }, async unsetStoreValue() {}, registerCapabilityListener() {}, async setCapabilityValue() {}, async setAvailable() {}, async setUnavailable() {} });
  return { device, settings, stored: () => stored };
}
async function newBundle() {
  const { driver, trigger } = makeDriver(); await driver.onInit(); const p = await pair(driver); const preview = await p.handlers.cloud_preview({ hubId: 'hub1' });
  const result = await p.handlers.cloud_complete({ hubId: 'hub1' });
  const bundle = driver.takePairingBundle(result.device.store.bootstrapToken, result.device.data.id);
  return { driver, trigger, p, preview, result, bundle };
}

test('EU pairing previews ten named commands and UI payloads exclude secrets and codes', async () => {
  reset(); const { driver } = makeDriver(); await driver.onInit(); const p = await pair(driver);
  const preview = await p.handlers.cloud_preview({ hubId: 'hub1' }); assert.equal(preview.commands.length, 10); assert.equal(preview.commands[9].name, 'Remote / RF9');
  const result = await p.handlers.cloud_complete({ hubId: 'hub1' });
  const exposed = JSON.stringify([p.login, p.discovery, preview, result]);
  for (const secret of ['secret-password', 'secret-session', 'private-cookie', 'aabb00', 'aabb09']) assert.equal(exposed.includes(secret), false, secret);
});
test('Magic Home discovery is diagnostic only', async () => {
  reset(); const { driver } = makeDriver(); await driver.onInit(); const p = await pair(driver, 'magic_home');
  assert.deepEqual(p.discovery.summary, { devices: 2, hubs: 1, credentialSets: 1 }); assert.equal(p.discovery.commandImportSupported, false);
  const preview = await p.handlers.cloud_preview({ hubId: 'hub1' }); assert.equal(preview.canAdd, false); assert.equal(preview.commands.length, 0); assert.match(preview.reason, /does not expose/);
  await assert.rejects(p.handlers.cloud_complete({ hubId: 'hub1' })); assert.equal(JSON.stringify([p.login, p.discovery, preview]).includes('secret-token'), false);
});
test('bootstrap token is one-use and bound to the selected identity', async () => {
  reset(); const { driver } = makeDriver(); await driver.onInit(); const p = await pair(driver); await p.handlers.cloud_preview({ hubId: 'hub1' }); const result = await p.handlers.cloud_complete({ hubId: 'hub1' });
  const token = result.device.store.bootstrapToken, id = result.device.data.id;
  assert.throws(() => driver.takePairingBundle(token, 'wrong-id')); assert.equal(driver.takePairingBundle(token, id).hub.endpointId, 'hub1'); assert.throws(() => driver.takePairingBundle(token, id));
});
test('repair rejects different account, home or hub without replacing old configuration', async () => {
  reset(); const base = await newBundle();
  for (const change of ['account', 'home', 'hub']) {
    let replaced = false; const old = copy(base.bundle);
    const dev = { getData: () => ({ id: change === 'hub' ? 'broadlink_eu:other' : base.result.device.data.id }), getStoreValue: () => old, async replaceCloudConfiguration() { replaced = true; } };
    if (change === 'account') old.session.userId = 'different'; if (change === 'home') old.session.familyId = 'different';
    const p = await pair(base.driver, 'broadlink_eu', dev); await p.handlers.cloud_preview({ hubId: 'hub1' }); await assert.rejects(p.handlers.cloud_complete({ hubId: 'hub1' }), /original account, home and RM Max/); assert.equal(replaced, false);
  }
});
test('refresh failure preserves previous saved commands and persistent configuration', async () => {
  reset(); const base = await newBundle(); const x = makeDevice(base.driver, base.bundle); await x.device.onInit(); scenario.remoteError = true;
  await assert.rejects(x.device.refreshCommands()); assert.deepEqual(x.stored(), base.bundle); assert.deepEqual(x.device._config, base.bundle);
});
test('failed physical send is attempted once and triggers only on success', async () => {
  reset(); const base = await newBundle(); const x = makeDevice(base.driver, base.bundle); await x.device.onInit(); const args = { variable: { id: base.bundle.commands[0].id } };
  scenario.sendError = true; await assert.rejects(x.device.executeCommand(args)); assert.equal(scenario.cloudSends, 1); assert.equal(scenario.localSends, 0); assert.equal(base.trigger.calls.length, 0);
  scenario.sendError = false; await x.device.executeCommand(args); assert.equal(scenario.cloudSends, 2); assert.equal(base.trigger.calls.length, 1);
});
test('local mode requires successful probe and matching IP and key fingerprint', async () => {
  reset(); const base = await newBundle(); const x = makeDevice(base.driver, base.bundle); await x.device.onInit(); const args = { variable: { id: base.bundle.commands[0].id } };
  x.settings.transport = 'local'; await assert.rejects(x.device.executeCommand(args)); assert.equal(scenario.localSends, 0);
  await x.device.probeLocal(); await x.device.executeCommand(args); assert.equal(scenario.localSends, 1);
  x.settings.ipAddress = '192.168.1.21'; await assert.rejects(x.device.executeCommand(args)); x.settings.ipAddress = '192.168.1.20';
  x.device._config.localVerification.fingerprint = crypto.randomBytes(32).toString('hex'); await assert.rejects(x.device.executeCommand(args));
  assert.equal(scenario.localSends, 1); assert.equal(scenario.cloudSends, 0);
});
test('failed subsequent local probe revokes old verification', async () => {
  reset(); const base = await newBundle(); const x = makeDevice(base.driver, base.bundle); await x.device.onInit(); await x.device.probeLocal(); scenario.probeError = true;
  await assert.rejects(x.device.probeLocal()); assert.equal(x.stored().localVerification, null); assert.equal(x.device._config.localVerification, null);
});
test('disconnect invalidates in-flight login and discovery', async () => {
  reset(); const { driver } = makeDriver(); await driver.onInit();
  let release; scenario.login = () => new Promise(resolve => { release = resolve; });
  const h1 = {}; driver.onPair({ setHandler: (name, fn) => { h1[name] = fn; } }); const pending = h1.cloud_login({ provider: 'broadlink_eu', email: 'e', password: 'p' });
  h1.disconnect(); release(copy(account)); await assert.rejects(pending, /expired/); await assert.rejects(h1.cloud_complete({ hubId: 'hub1' }), /expired/);
  reset(); const p = await pair(driver); scenario.listDevices = () => new Promise(resolve => { release = resolve; });
  const discovery = p.handlers.cloud_discover({ homeId: 'home1' }); p.handlers.disconnect(); release([hub, remote]); await assert.rejects(discovery, /expired/); await assert.rejects(p.handlers.cloud_complete({ hubId: 'hub1' }), /expired/);
});
test('a failed pairing probe invalidates an earlier success', async () => {
  reset(); const { driver } = makeDriver(); await driver.onInit(); const p = await pair(driver);
  await p.handlers.cloud_preview({ hubId: 'hub1' });
  await p.handlers.cloud_probe({ hubId: 'hub1', ipAddress: '192.168.1.20' }); scenario.probeError = true;
  await assert.rejects(p.handlers.cloud_probe({ hubId: 'hub1', ipAddress: '192.168.1.20' }));
  const result = await p.handlers.cloud_complete({ hubId: 'hub1' });
  const bundle = driver.takePairingBundle(result.device.store.bootstrapToken, result.device.data.id);
  assert.equal(bundle.localVerification, null);
});
test('local send failure never retries, falls back to cloud, or triggers a Flow', async () => {
  reset(); const base = await newBundle(); const x = makeDevice(base.driver, base.bundle); await x.device.onInit(); await x.device.probeLocal();
  x.settings.transport = 'local'; scenario.sendError = true;
  await assert.rejects(x.device.executeCommand({ variable: { id: base.bundle.commands[0].id } }));
  assert.equal(scenario.localSends, 1); assert.equal(scenario.cloudSends, 0); assert.equal(base.trigger.calls.length, 0);
});
test('repair recovers when bootstrap persistence failed and the original identity matches', async () => {
  reset(); const base = await newBundle(); let replacement;
  const repairDevice = { getData: () => ({ id: base.result.device.data.id }), getStoreValue: () => null, async replaceCloudConfiguration(bundle) { replacement = bundle; } };
  const p = await pair(base.driver, 'broadlink_eu', repairDevice); await p.handlers.cloud_preview({ hubId: 'hub1' });
  assert.deepEqual(await p.handlers.cloud_complete({ hubId: 'hub1' }), { repair: true });
  assert.equal(replacement.hub.endpointId, 'hub1'); assert.equal(replacement.commands.length, 10);
});
test('failed persistence after a successful local probe blocks local sending', async () => {
  reset(); const base = await newBundle(); const x = makeDevice(base.driver, base.bundle); await x.device.onInit();
  const store = x.device.setStoreValue.bind(x.device); x.device.setStoreValue = async (key, value) => { if (value.localVerification) throw new Error('storage failure'); return store(key, value); };
  await assert.rejects(x.device.probeLocal()); assert.equal(x.device._config.localVerification, null); assert.equal(x.stored().localVerification, null);
  x.settings.transport = 'local'; await assert.rejects(x.device.executeCommand({ variable: { id: base.bundle.commands[0].id } })); assert.equal(scenario.localSends, 0);
});
test('bootstrap storage failure can be repaired for the original device identity', async () => {
  reset(); const { driver } = makeDriver(); await driver.onInit(); const pairing = await pair(driver); await pairing.handlers.cloud_preview({ hubId: 'hub1' });
  const result = await pairing.handlers.cloud_complete({ hubId: 'hub1' }); const data = result.device.data;
  const values = { bootstrapToken: result.device.store.bootstrapToken }; let failSave = true; let unavailable = false;
  const device = new Device(); Object.assign(device, { driver, homey: driver.homey, log() {}, getData: () => data, getSetting: () => 'cloud', getStoreValue: key => values[key],
    async setStoreValue(key, value) { if (failSave && key === 'rmmax_cloud') throw Error('storage failure'); values[key] = copy(value); }, async unsetStoreValue(key) { delete values[key]; }, registerCapabilityListener() {}, async setCapabilityValue() {}, async setAvailable() {}, async setUnavailable() { unavailable = true; } });
  await device.onInit(); assert.equal(unavailable, true); assert.equal(values.rmmax_cloud, undefined);
  failSave = false; const repairing = await pair(driver, 'broadlink_eu', device); await repairing.handlers.cloud_preview({ hubId: 'hub1' });
  assert.deepEqual(await repairing.handlers.cloud_complete({ hubId: 'hub1' }), { repair: true }); assert.equal(values.rmmax_cloud.hub.endpointId, 'hub1'); assert.equal(values.bootstrapToken, undefined);
});
