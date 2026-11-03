'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const systemCapabilities = new Set(require('./fixtures/homey-rmmax-capabilities.json').systemCapabilities);
const driverManifest = require('../drivers/RM_max/driver.compose.json');
const knownCapability = id => systemCapabilities.has(id.split('.')[0]) || fs.existsSync(path.join(__dirname, '../.homeycompose/capabilities', id + '.json'));

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
  async control(endpoint, namespace, action, payload, version) {
    scenario.cloudSends++; (scenario.directives ||= []).push({ namespace, action, payload, version });
    if (scenario.control) return scenario.control(this, endpoint, namespace, action, payload);
    if (scenario.sendError) throw Error('sensitive failure');
    return {};
  }
}
const cloud = { BroadlinkCloud: EU, MagicHomeCloud: Magic, extractCredentials: endpoint => endpoint.valid ? copy(creds) : null, isRMMaxEndpoint: endpoint => endpoint.productId === 'rmmax' };
const local = { isPrivateIPv4: ip => /^192\.168\.1\.\d+$/.test(ip), async probe() { scenario.probes++; if (scenario.probeError) throw Error('probe failure'); return { firmware: 123 }; }, async sendCode() { scenario.localSends++; if (scenario.sendError) throw Error('send failure'); } };
const originalLoad = Module._load;
let Driver, Device, commands;
try {
  Module._load = function (request, parent, isMain) {
    if (request === 'homey') return { Driver: class {}, Device: class {
      constructor() { this.testCaps = new Set(['rmmax_status', 'button.refresh', 'button.local_test']); this.testOptions = {}; }
      hasCapability(id) { return this.testCaps.has(id); }
      async addCapability(id) { if (!knownCapability(id)) throw Error('Invalid Capability: ' + id); this.testCaps.add(id); }
      async removeCapability(id) { this.testCaps.delete(id); }
      getCapabilityOptions(id) {
        if (id.startsWith('button.') && !driverManifest.capabilitiesOptions[id]) throw Error('Invalid Capability: ' + id);
        return this.testOptions[id] || {};
      }
      async setCapabilityOptions(id, value) { this.testOptions[id] = value; }
    } };
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
  const timers = new Map(); let nextTimer = 0;
  d.homey = { setTimeout: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; }, clearTimeout: id => timers.delete(id), flow: { getActionCard: () => ({ registerRunListener() { return this; }, getArgument() { return { registerAutocompleteListener() {} }; } }), getDeviceTriggerCard: () => trigger } };
  return { driver: d, trigger, timers };
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
  const listeners = {}, values = {};
  Object.assign(device, { driver, homey: driver.homey, log() {}, getData: () => ({ id }), getSetting: key => settings[key], getStoreValue: key => key === 'rmmax_cloud' ? stored : null,
    async setStoreValue(key, value) { if (key === 'rmmax_cloud') stored = copy(value); }, async unsetStoreValue() {}, registerCapabilityListener(id, fn) { listeners[id] = fn; }, async setCapabilityValue(id, value) { values[id] = value; }, async setAvailable() { device.testUnavailable = false; }, async setUnavailable(message) { device.testUnavailable = message; } });
  return { device, settings, listeners, values, stored: () => stored };
}
async function newBundle() {
  const { driver, trigger } = makeDriver(); await driver.onInit(); const p = await pair(driver); const preview = await p.handlers.cloud_preview({ hubId: 'hub1' });
  const result = await p.handlers.cloud_complete({ hubId: 'hub1' });
  const bundle = driver.takePairingBundle(result.device.store.bootstrapToken, result.device.data.id);
  return { driver, trigger, p, preview, result, bundle };
}

const magicCap = (ns, names, properties = []) => ({ interface: ns, version: '2', actions: { supported: names.map(name => ({ name })) }, properties: { supported: properties.map(name => ({ name })) } });
const magicEndpoint = { ...hub, valid: false, mac: undefined, cookie: { did: 'physical-hub', aeskeyToken: 'opaque-secret' }, capabilities: [magicCap('DNA.PowerControl', ['ChangePowerState'], ['powerState']), magicCap('DNA.VolumeControl', ['AdjustVolume'], ['volumeSteps'])] };
async function newMagicDevice(endpoint = magicEndpoint) {
  reset(); scenario.endpoints = [copy(endpoint)];
  const { driver, trigger, timers } = makeDriver(); await driver.onInit();
  const p = await pair(driver, 'magic_home'); const preview = await p.handlers.cloud_preview({ hubId: endpoint.endpointId });
  const result = await p.handlers.cloud_complete({ hubId: endpoint.endpointId });
  const bundle = driver.takePairingBundle(result.device.store.bootstrapToken, result.device.data.id);
  const x = makeDevice(driver, bundle); x.device.testCaps = new Set(result.device.capabilities);
  await x.device.onInit();
  return { driver, trigger, timers, p, preview, result, bundle, ...x };
}

test('Magic Home pairing adds an actionable remote and sends exact cloud intents from capabilities', async () => {
  const x = await newMagicDevice();
  assert.equal(x.preview.canAdd, true); assert.equal(x.preview.rawCredentialsAvailable, false);
  assert(x.result.device.capabilities.includes('onoff')); assert(!x.result.device.capabilities.includes('button.local_test'));
  await x.listeners.onoff(true);
  assert.deepEqual(scenario.directives[0], { namespace: 'DNA.PowerControl', action: 'ChangePowerState', payload: { powerState: 'ON' }, version: '2' });
  await x.listeners.volume_down(); assert.deepEqual(scenario.directives[1].payload, { volumeSteps: -1 });
  assert.equal(scenario.localSends, 0); assert.equal(x.trigger.calls.length, 2);
  assert.equal(x.values.onoff, true);
});

test('TV startup succeeds when Homey rejects dynamic placeholder capability metadata', async () => {
  const x = await newMagicDevice();
  assert.throws(() => x.device.getCapabilityOptions('button.volume_up'), /Invalid Capability: button.volume_up/);
  assert.equal(x.device.testUnavailable, false);
  assert(x.device.hasCapability('volume_up'));
  await x.listeners.volume_up(); assert.deepEqual(scenario.directives[0].payload, { volumeSteps: 1 });
});

test('v3.1.81 TV devices migrate controls and cached metadata without changing command Flow IDs', async () => {
  const endpoint = { ...magicEndpoint, capabilities: [...magicEndpoint.capabilities, magicCap('DNA.PlaybackController', ['Play', 'Pause', 'Stop', 'Next', 'Previous'])] };
  const x = await newMagicDevice(endpoint); await x.device.onUninit();
  const legacy = copy(x.stored()); const mapping = require('../lib/RMMaxMagic').LEGACY_CONTROL_CAPABILITIES;
  for (const command of legacy.commands) {
    const old = Object.entries(mapping).find(([, current]) => current === command.capability);
    if (old) command.capability = old[0];
    else if (command.namespace.includes('Playback')) delete command.capability;
  }
  const migrated = makeDevice(x.driver, legacy);
  migrated.device.testCaps = new Set(['rmmax_status', 'button.refresh', 'button.check_connection', 'onoff', ...Object.keys(mapping)]);
  await migrated.device.onInit();
  assert.equal(migrated.device.testUnavailable, false);
  assert.deepEqual(migrated.stored().commands.map(c => c.id), legacy.commands.map(c => c.id));
  for (const old of Object.keys(mapping)) assert.equal(migrated.device.hasCapability(old), false);
  for (const id of ['volume_up', 'volume_down', 'rmmax_play', 'rmmax_pause', 'speaker_stop', 'speaker_next', 'speaker_prev']) assert(migrated.device.hasCapability(id));
  await migrated.listeners.rmmax_pause(); assert.equal(scenario.directives[0].action, 'Pause');
  await migrated.device.executeCommand({ variable: { id: legacy.commands[0].id } }); assert.equal(scenario.directives[1].action, 'ChangePowerState');
});

test('Homey capability initialization errors preserve the cause without alleging missing cloud authorization', async () => {
  const x = await newMagicDevice(); const logs = []; x.device.log = message => logs.push(message);
  x.device.testCaps.delete('volume_up');
  const original = x.device.addCapability.bind(x.device);
  x.device.addCapability = async id => { if (id === 'volume_up') throw Error('Invalid Capability: volume_up'); return original(id); };
  await x.device.onInit();
  assert.match(x.device.testUnavailable, /Homey controls/);
  assert.match(logs.join('\n'), /Homey controls: Invalid Capability: volume_up/);
  assert.equal(logs.join('\n').includes('initialization requires authorization'), false);
  x.device.addCapability = original; await x.device.onInit(); assert.equal(x.device.testUnavailable, false);
});

test('Magic Home refresh updates learned cloud actions and retains existing IDs and Flows', async () => {
  const endpoint = { ...magicEndpoint, capabilities: [magicCap('DNA.CustomizedRemoteControl', ['RF 1', 'RF 2'])] };
  const x = await newMagicDevice(endpoint); const first = x.device.onAutoComplete();
  scenario.endpoints[0].capabilities[0].actions.supported.push({ name: 'RF 3' });
  await x.device.refreshCommands(); assert.equal(x.device.onAutoComplete().length, 3);
  assert.equal(x.device.onAutoComplete()[0].id, first[0].id);
  await x.device.executeCommand({ variable: first[0] });
  assert.equal(scenario.directives[0].action, 'RF 1');
});

test('connection failure becomes unavailable, one timer recovers, rejected authorization requests Repair', async () => {
  const x = await newMagicDevice();
  scenario.listDevices = async () => { throw Object.assign(Error('private'), { code: 'TIMEOUT' }); };
  await assert.rejects(x.device.refreshCommands()); assert.match(x.device.testUnavailable, /automatically/);
  assert.equal(x.timers.size, 1); assert.equal([...x.timers.values()][0].ms, 60000);
  delete scenario.listDevices; await x.device.refreshCommands(); assert.equal(x.device.testUnavailable, false);
  assert.equal(x.timers.size, 1); assert.equal([...x.timers.values()][0].ms, 300000);
  scenario.listDevices = async () => { throw Object.assign(Error('private'), { code: 'AUTH_REQUIRED' }); };
  await assert.rejects(x.device.refreshCommands()); assert.match(x.device.testUnavailable, /Repair/); assert.equal(x.timers.size, 0);
  delete scenario.listDevices;
  const repair = await pair(x.driver, 'magic_home', x.device); await repair.handlers.cloud_preview({ hubId: 'hub1' });
  await repair.handlers.cloud_complete({ hubId: 'hub1' }); assert.equal(x.device.testUnavailable, false); assert.equal(x.timers.size, 1);
});

test('Magic Home token rotation survives a failed physical send with no resend', async () => {
  const x = await newMagicDevice();
  scenario.control = async client => { client.session = { ...client.session, accessToken: 'rotated', refreshToken: 'next-refresh' }; throw Object.assign(Error('secret'), { code: 'TIMEOUT' }); };
  await assert.rejects(x.device.executeCommand({ variable: x.device.onAutoComplete()[0] }));
  assert.equal(scenario.cloudSends, 1); assert.equal(x.trigger.calls.length, 0); assert.equal(x.stored().session.refreshToken, 'next-refresh');
});

test('reported offline endpoint and failed refresh retain cached commands without claiming online', async () => {
  const x = await newMagicDevice(); const before = x.device.onAutoComplete();
  scenario.endpoints[0].isReachable = false;
  await assert.rejects(x.device.refreshCommands()); assert.match(x.device.testUnavailable, /offline/);
  assert.deepEqual(x.device.onAutoComplete(), before);
});

test('sensor-only endpoint can be added and refresh queries real sensor state', async () => {
  const x = await newMagicDevice({ ...magicEndpoint, capabilities: [magicCap('DNA.TemperatureSensor', [], ['temperature'])] });
  assert(x.result.device.capabilities.includes('measure_temperature')); assert(!x.result.device.capabilities.includes('onoff'));
  scenario.control = async () => ({ context: { properties: [{ namespace: 'DNA.TemperatureSensor', name: 'temperature', value: { value: 23, scale: 'CELSIUS' } }] } });
  await x.device.refreshCommands(); assert.equal(x.values.measure_temperature, 23);
  assert.equal(scenario.directives[0].action, 'ReportState');
});

test('local transport is rejected for cloud-only actions and shutdown cancels checks', async () => {
  const x = await newMagicDevice();
  await assert.rejects(x.device.onSettings({ newSettings: { transport: 'local', ipAddress: '192.168.1.20' }, changedKeys: ['transport'] }), /cloud transport/);
  await assert.rejects(x.device.probeLocal(), /cloud intents/); assert.equal(scenario.probes, 0);
  const timer = [...x.timers.values()][0]; x.device.onUninit(); assert.equal(x.timers.size, 0);
  await timer.fn(); assert.equal(x.timers.size, 0); assert.equal(scenario.cloudSends, 0);
});

test('deletion during an outstanding cloud check prevents capability writes and rescheduling', async () => {
  const x = await newMagicDevice(); let release;
  scenario.listDevices = () => new Promise(resolve => { release = resolve; });
  const pending = x.device.refreshCommands(); x.device.onDeleted(); release([magicEndpoint]);
  await assert.rejects(pending, /cancelled/); assert.equal(x.timers.size, 0);
});

test('refresh adds new controls once and retains old capability IDs when actions disappear', async () => {
  const x = await newMagicDevice();
  const firstListener = x.listeners.volume_up;
  scenario.endpoints[0].capabilities.push(magicCap('DNA.PlaybackController', ['Play']));
  await x.device.refreshCommands(); assert(x.device.hasCapability('rmmax_play'));
  assert.equal(x.listeners.volume_up, firstListener);
  scenario.endpoints[0].capabilities = [magicCap('DNA.PowerControl', ['ChangePowerState'], ['powerState'])];
  await x.device.refreshCommands(); assert(x.device.hasCapability('volume_up'));
  assert.throws(() => x.listeners.volume_up(), /no longer available/);
});

test('a cloud outage leaves previously verified EU local control available', async () => {
  reset(); const base = await newBundle(); const x = makeDevice(base.driver, base.bundle); await x.device.onInit(); await x.device.probeLocal(); x.settings.transport = 'local';
  scenario.listDevices = async () => { throw Object.assign(Error('offline'), { code: 'TIMEOUT' }); };
  await assert.rejects(x.device.refreshCommands()); assert.equal(x.device.testUnavailable, false);
  await x.device.executeCommand({ variable: x.device.onAutoComplete()[0] }); assert.equal(scenario.localSends, 1);
});

test('automatic checks defer while busy, refresh without sending commands, and schedule once', async () => {
  const x = await newMagicDevice(); let reads = 0;
  scenario.listDevices = async () => { reads++; return [copy(magicEndpoint)]; };
  const fire = async () => { const [id, timer] = [...x.timers.entries()][0]; x.timers.delete(id); await timer.fn(); };
  x.device._busy = true; await fire(); assert.equal(reads, 0); assert.equal([...x.timers.values()][0].ms, 30000);
  x.device._busy = false; await fire(); assert.equal(reads, 1); assert.equal(scenario.cloudSends, 0); assert.equal(x.timers.size, 1);
  assert.equal([...x.timers.values()][0].ms, 300000);
});

test('reinitialization waits for an old command and prevents duplicate polling or stale triggers', async () => {
  const x = await newMagicDevice(); let release;
  scenario.control = () => new Promise(resolve => { release = resolve; });
  const pending = x.device.executeCommand({ variable: x.device.onAutoComplete()[0] });
  const initializing = x.device.onInit();
  assert.equal(x.device._stopped, true); assert.equal(x.timers.size, 0);
  release({}); await assert.rejects(pending, /cancelled/); await initializing;
  assert.equal(x.device._stopped, false); assert.equal(x.timers.size, 1); assert.equal(x.trigger.calls.length, 0); assert.equal(scenario.cloudSends, 1);
});

test('one user command waits for an automatic check without creating an unbounded send queue', async () => {
  const x = await newMagicDevice(); let release;
  scenario.listDevices = () => new Promise(resolve => { release = resolve; });
  const [id, timer] = [...x.timers.entries()][0]; x.timers.delete(id); const checking = timer.fn();
  const args = { variable: x.device.onAutoComplete()[0] };
  const sending = x.device.executeCommand(args);
  await assert.rejects(x.device.executeCommand(args), /still running/);
  assert.equal(scenario.cloudSends, 0);
  release([copy(magicEndpoint)]); await checking; await sending;
  assert.equal(scenario.cloudSends, 1); assert.equal(x.timers.size, 1);
});

test('EU pairing previews ten named commands and UI payloads exclude secrets and codes', async () => {
  reset(); const { driver } = makeDriver(); await driver.onInit(); const p = await pair(driver);
  const preview = await p.handlers.cloud_preview({ hubId: 'hub1' }); assert.equal(preview.commands.length, 10); assert.equal(preview.commands[9].name, 'Remote / RF9');
  const result = await p.handlers.cloud_complete({ hubId: 'hub1' });
  const exposed = JSON.stringify([p.login, p.discovery, preview, result]);
  for (const secret of ['secret-password', 'secret-session', 'private-cookie', 'aabb00', 'aabb09']) assert.equal(exposed.includes(secret), false, secret);
});
test('Magic Home entries without supported actions cannot be added', async () => {
  reset(); const { driver } = makeDriver(); await driver.onInit(); const p = await pair(driver, 'magic_home');
  assert.deepEqual(p.discovery.summary, { devices: 2, hubs: 1, credentialSets: 1 }); assert.equal(p.discovery.commandImportSupported, true);
  const preview = await p.handlers.cloud_preview({ hubId: 'hub1' }); assert.equal(preview.canAdd, false); assert.equal(preview.commands.length, 0); assert.match(preview.reason, /No supported/);
  await assert.rejects(p.handlers.cloud_complete({ hubId: 'hub1' })); assert.equal(JSON.stringify([p.login, p.discovery, preview]).includes('secret-token'), false);
});
test('Magic Home discovery logs safe endpoint capabilities and numbers matching choices', async () => {
  reset(); scenario.endpoints = [{ ...hub, friendlyName: 'private name', cookie: 'private-cookie', capabilities: [{ interface: 'private interface', actions: { supported: [{ name: 'ChangePowerState' }, { name: 'private action' }] } }] }];
  const { driver } = makeDriver(); const logs = []; driver.log = message => logs.push(message); await driver.onInit();
  const p = await pair(driver, 'magic_home');
  assert.equal(p.discovery.hubs[0].name, '#1 private name');
  assert.match(logs.join('\n'), /knownActions.*ChangePowerState/);
  for (const secret of ['private name', 'private-cookie', 'private interface', 'private action', 'secret-token']) assert.equal(logs.join('\n').includes(secret), false, secret);
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
