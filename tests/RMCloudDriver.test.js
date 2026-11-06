'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const realCloud = require('../lib/BroadlinkCloud');
const commands = require('../lib/RMCloudCommands');
test.mock.method(require('node:https'), 'request', () => { throw new Error('Real cloud network access forbidden in unit tests'); });
const systemCaps = new Set(require('./fixtures/homey-rmmax-capabilities.json').systemCapabilities);
const copy = value => JSON.parse(JSON.stringify(value));
const IR = '2600040011223344';
const key = '00112233445566778899aabbccddeeff';
const account = { provider: 'broadlink_eu', userId: 'owner', loginSession: 'private-session' };
const remote = { endpointId: 'remote1', gatewayId: 'hub1', friendlyName: 'TV' };
const row = (name, fn, code = IR) => ({ name, function: fn, codeList: [{ code }] });
const rows = [row('On', 'power_on'), row('Off', 'power_off', '2600040044332211'), row('Louder', 'volume_up', '2600040010203040'), row('Favorite', 'favorite', '2600040040302010'), row('Another', 'another', '2600040020304050')];
const types = { rm3_mini: 0x2737, rm4_mini: 0x51da, rm4_pro: 0x520b };
function hub(model = 'rm4_pro') {
  const pid = Buffer.alloc(16); pid.writeUInt16LE(types[model], 12);
  return { endpointId: 'hub1', productId: pid.toString('hex'), friendlyName: 'Room hub', mac: 'aabbccddeeff', devicetypeFlag: 1, cookie: Buffer.from(JSON.stringify({ terminalid: 123, aeskey: key })).toString('base64') };
}
let state;
function reset(model = 'rm4_pro') { state = { endpoints: [hub(model), copy(remote)], rows: copy(rows), sends: [], reads: 0, inventories: 0 }; }
class EU extends realCloud.BroadlinkCloud {
  static async login() { return copy(state.account || account); }
  async listHomes() { return [{ id: 'home1', name: 'Home' }, { id: 'home2', name: 'Other home' }]; }
  async listDevices() { state.inventories++; if (state.inventoryError) throw state.inventoryError; return copy(state.endpoints); }
  async getRemote(id) { state.reads++; return { endpointId: id, irData: copy(state.rows) }; }
  async sendRMCode(endpoint, code) { state.sends.push({ endpoint: copy(endpoint), code }); if (state.send) return state.send(); }
  async sendCode() { throw new Error('Legacy RM Max send must not be used'); }
}
function knownCapability(id) {
  const root = id.split('.')[0];
  return systemCaps.has(root) || fs.existsSync(path.join(__dirname, '../.homeycompose/capabilities', root + '.json'));
}
class HomeyDevice {
  constructor() { this.caps = new Set(['rmmax_status', 'button.refresh', 'button.check_connection']); this.options = {}; }
  hasCapability(id) { return this.caps.has(id); }
  getCapabilities() { return [...this.caps]; }
  async addCapability(id) { if (!knownCapability(id)) throw new Error('Invalid Capability: ' + id); this.caps.add(id); }
  async removeCapability(id) { this.caps.delete(id); }
  getCapabilityOptions(id) { if (!this.hasCapability(id) || !knownCapability(id)) throw new Error('Invalid Capability: ' + id); return this.options[id] || {}; }
  async setCapabilityOptions(id, options) { this.getCapabilityOptions(id); this.options[id] = copy(options); }
}
const originalLoad = Module._load;
let Device, ThinDrivers;
try {
  Module._load = function (request, parent, isMain) {
    if (request === 'homey') return { Driver: class {}, Device: HomeyDevice };
    if (request.endsWith('/BroadlinkCloud')) return { ...realCloud, BroadlinkCloud: EU };
    if (request.endsWith('/RMMaxLocal')) return { isPrivateIPv4: () => false, async sendCode() { throw new Error('Real/local device access forbidden'); }, async probe() { throw new Error('Real/local device access forbidden'); } };
    return originalLoad.call(this, request, parent, isMain);
  };
  ThinDrivers = Object.fromEntries(Object.entries(commands.MODELS).map(([model, config]) => [model, require(`../drivers/${config.driverId}/driver`)]));
  Device = require('../lib/RMCloudDevice');
} finally { Module._load = originalLoad; }

function makeDriver(model = 'rm4_pro') {
  const driver = new ThinDrivers[model]();
  const timers = new Map(), actions = new Map(), triggers = [], triggerIds = [];
  let nextTimer = 0;
  const trigger = { async trigger(...args) { triggers.push(args); } };
  driver.homey = { setTimeout(fn, ms) { timers.set(++nextTimer, { fn, ms }); return nextTimer; }, clearTimeout(id) { timers.delete(id); }, flow: {
    getActionCard(id) { const card = { registerRunListener(fn) { this.run = fn; return this; }, getArgument(name) { assert.equal(name, 'variable'); return { registerAutocompleteListener(fn) { card.autocomplete = fn; } }; } }; actions.set(id, card); return card; },
    getDeviceTriggerCard(id) { triggerIds.push(id); return trigger; }
  } };
  driver.getDevices = () => []; driver.log = () => {};
  return { driver, timers, actions, triggers, triggerIds };
}
function socket(driver, repairDevice) {
  const handlers = {};
  const connection = { setHandler(name, fn) { handlers[name] = fn; } };
  if (repairDevice) driver.onRepair(connection, repairDevice); else driver.onPair(connection);
  return handlers;
}
async function select(driver, repairDevice, homeId = 'home1') {
  const handlers = socket(driver, repairDevice);
  const login = await handlers.cloud_login({ email: 'mail@example.org', password: 'private-password' });
  const discovery = await handlers.cloud_discover({ homeId });
  const remotes = await handlers.cloud_remotes({ hubId: 'hub1' });
  const preview = await handlers.cloud_preview({ hubId: 'hub1', remoteId: 'remote1' });
  return { handlers, login, discovery, remotes, preview };
}
async function paired(model = 'rm4_pro') {
  reset(model);
  const d = makeDriver(model); await d.driver.onInit();
  const p = await select(d.driver);
  const result = await p.handlers.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: p.preview.mappings, buttons: p.preview.buttons });
  const bundle = d.driver.takePairingBundle(result.device.store.bootstrapToken, result.device.data.id);
  return { ...d, ...p, result, bundle };
}
function deviceFor(context, bundle = context.bundle, durableId = context.result.device.data.id) {
  const device = new Device(), store = new Map(bundle === undefined ? [] : [['rm_cloud', copy(bundle)]]), listeners = {}, values = {}, writes = [];
  Object.assign(device, { driver: context.driver, homey: context.driver.homey, log() {}, getData: () => ({ id: durableId }), getSetting: () => undefined,
    getStoreValue: key => store.get(key), async setStoreValue(key, value) { writes.push({ key, value: copy(value) }); store.set(key, copy(value)); }, async unsetStoreValue(key) { store.delete(key); },
    registerCapabilityListener(id, fn) { assert(knownCapability(id), 'undeclared capability ' + id); listeners[id] = fn; }, async setCapabilityValue(id, value) { assert(device.hasCapability(id)); values[id] = value; },
    async setAvailable() { device.unavailable = false; }, async setUnavailable(message) { device.unavailable = message; }
  });
  return { device, store, listeners, values, writes };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('each model pairs one remote with safe frontend metadata and single-use bootstrap', async () => {
  for (const model of Object.keys(types)) {
    const x = await paired(model);
    assert.equal(x.bundle.model, model);
    const manifest = require(`../drivers/${commands.MODELS[model].driverId}/driver.compose.json`);
    assert.equal(x.driver.cloudModel, model);
    assert.deepEqual(manifest.pair.map(view => view.id), ['cloud']);
    assert.deepEqual(manifest.repair.map(view => view.id), ['cloud']);
    assert.deepEqual(manifest.$flow.actions.map(card => card.id).sort(), [...x.actions.keys()].sort());
    assert.deepEqual(manifest.$flow.triggers.map(card => card.id), x.triggerIds);
    assert.equal(x.bundle.commands.length, rows.length);
    assert.equal(x.result.device.data.id, commands.deviceId(x.bundle.session, x.bundle.hub, x.bundle.remote));
    for (const response of [x.login, x.discovery, x.remotes, x.preview, x.result]) {
      const serialized = JSON.stringify(response);
      for (const secret of ['private-session', 'private-password', key, x.bundle.hub.cookie, IR]) assert(!serialized.includes(secret));
    }
    assert(x.result.device.capabilities.includes('onoff'));
    assert(x.result.device.capabilities.includes('volume_up'));
    assert(!x.result.device.capabilities.includes('button.local_test'));
    assert.throws(() => x.driver.takePairingBundle(x.result.device.store.bootstrapToken, x.result.device.data.id), /expired/);
    assert.deepEqual(await x.actions.get(`send_command_${commands.MODELS[model].driverId.toLowerCase()}`).autocomplete('', { device: { onAutoComplete: query => { assert.equal(query, ''); return x.preview.commands; } } }), x.preview.commands);
    x.driver.onUninit();
  }
});

test('pairing rejects wrong model, hub binding, duplicate discovery IDs and already paired identity', async () => {
  reset(); const { driver } = makeDriver(); await driver.onInit();
  state.endpoints.push(hub('rm4_mini'), { ...hub(), endpointId: 'unknown', productId: 'not-a-pid', friendlyName: 'RM4 Pro' });
  // Duplicate hub1 is an error regardless of the friendly model name.
  const h = socket(driver); await h.cloud_login({ email: 'x@y.z', password: 'secret' });
  await assert.rejects(h.cloud_discover({ homeId: 'home1' }), /ambiguous/);
  state.endpoints = [hub(), { ...hub('rm4_mini'), endpointId: 'mini' }, { ...remote, gatewayId: 'mini' }];
  const discovery = await h.cloud_discover({ homeId: 'home1' });
  assert.deepEqual(discovery.hubs.map(item => item.id), ['hub1']);
  await assert.rejects(h.cloud_preview({ hubId: 'mini', remoteId: 'remote1' }), /supported hub/);
  const reads = state.reads;
  await assert.rejects(h.cloud_preview({ hubId: 'hub1', remoteId: 'remote1' }));
  assert.equal(state.reads, reads);
  state.endpoints = [hub(), copy(remote)];
  await h.cloud_discover({ homeId: 'home1' });
  const preview = await h.cloud_preview({ hubId: 'hub1', remoteId: 'remote1' });
  await assert.rejects(h.cloud_complete({ hubId: 'other', remoteId: 'remote1', mappings: {}, buttons: [] }), /supported hub/);
  const id = commands.deviceId({ ...account, familyId: 'home1' }, hub(), remote);
  driver.getDevices = () => [{ getData: () => ({ id }) }];
  await assert.rejects(h.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: preview.mappings, buttons: preview.buttons }), /already paired/);
  driver.onUninit();
});

test('selected native controls and declared custom buttons send exact saved codes; all commands remain in Flow', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  assert.equal(d.device.unavailable, false);
  await d.device.updateControls({ mappings: x.bundle.mappings, buttons: [x.bundle.buttons[0]] });
  assert(fs.existsSync(path.join(__dirname, '../.homeycompose/capabilities/rmcloud_button.json')), 'root rmcloud_button must be declared');
  assert.deepEqual(d.device.onAutoComplete(), x.preview.commands);
  await d.listeners.onoff(true); await d.listeners.volume_up();
  const customId = commands.buttonCapability(x.bundle.buttons[0]);
  assert.equal(d.device.getCapabilityOptions(customId).title.en, 'Favorite');
  await d.listeners[customId]();
  assert.equal(state.sends.length, 3);
  assert.deepEqual(state.sends.map(sent => sent.code), [rows[0].codeList[0].code, rows[2].codeList[0].code, rows[3].codeList[0].code]);
  assert(state.sends.every(sent => sent.endpoint.endpointId === 'hub1'));
  assert.equal(d.values.onoff, true);
  assert.equal(x.triggers.length, 3);
  const flowOnly = x.bundle.commands.find(command => command.function === 'another');
  assert(!d.device.hasCapability(commands.buttonCapability(flowOnly.id)));
  await d.device.executeCommand({ variable: { id: flowOnly.id } });
  assert.equal(state.sends.length, 4);
  await d.device.onUninit(); x.driver.onUninit();
});

test('initialization consumes bootstrap once, persists authorization and restarts from its cache', async () => {
  const x = await paired();
  const result = await x.handlers.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: x.preview.mappings, buttons: x.preview.buttons });
  const d = deviceFor(x); d.store.clear(); d.store.set('bootstrapToken', result.device.store.bootstrapToken);
  const inventories = state.inventories;
  await d.device.onInit();
  assert.equal(d.device.unavailable, false); assert.equal(d.store.has('bootstrapToken'), false);
  assert.equal(d.store.get('rm_cloud').session.loginSession, account.loginSession);
  assert.throws(() => x.driver.takePairingBundle(result.device.store.bootstrapToken, result.device.data.id), /expired/);
  await d.device.onInit();
  assert.equal(d.device.unavailable, false); assert.equal(state.inventories, inventories);
  await d.device.onUninit(); x.driver.onUninit();
});

test('cached controls edit offline, preserve missing IDs, explicitly clear and reject new unknown IDs', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  const favorite = x.bundle.commands.find(command => command.function === 'favorite');
  const inventories = state.inventories;
  await d.device.updateControls({ mappings: { play: favorite.id }, buttons: [favorite.id] });
  assert(d.device.hasCapability('rmmax_play')); assert(!d.device.hasCapability('onoff')); assert(!d.device.hasCapability('volume_up'));
  assert.equal(state.inventories, inventories);
  state.rows = [row('Other survives', 'another')];
  await d.device.refreshCommands();
  const stored = d.store.get('rm_cloud');
  assert.equal(stored.mappings.play, favorite.id); assert.deepEqual(stored.buttons, [favorite.id]);
  assert.equal(d.device.getCapabilityOptions(commands.buttonCapability(favorite.id)).title.en, 'Favorite (unavailable)');
  await assert.rejects(d.listeners.rmmax_play(), /Mapped command is unavailable/);
  await assert.rejects(d.listeners[commands.buttonCapability(favorite.id)](), /no longer exists/);
  assert.equal(state.sends.length, 0);
  await d.device.updateControls({ mappings: {}, buttons: [] });
  assert(!d.device.hasCapability('rmmax_play')); assert(!d.device.hasCapability(commands.buttonCapability(favorite.id)));
  await assert.rejects(d.device.updateControls({ mappings: { play: favorite.id }, buttons: [] }), /no longer available/);
  await d.device.onUninit(); x.driver.onUninit();
});

test('refresh preserves function IDs after rename/code update and never remaps removed commands', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  const on = x.bundle.mappings.power_on;
  state.rows = [row('New display label', 'power_on', '2600040044332211'), row('Off renamed', 'power_off')];
  await d.device.refreshCommands();
  assert.equal(d.store.get('rm_cloud').mappings.power_on, on);
  await d.listeners.onoff(true);
  assert.equal(state.sends[0].code, '2600040044332211');
  state.rows = [row('Replacement looks like On', 'different')];
  await d.device.refreshCommands();
  await assert.rejects(d.listeners.onoff(true), /Mapped command is unavailable/);
  assert.equal(state.sends.length, 1);
  await d.device.onUninit(); x.driver.onUninit();
});

test('authoritative empty refresh removes executable cached codes while keeping reviewable mappings', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  const before = copy(d.store.get('rm_cloud'));
  state.rows = [];
  await d.device.refreshCommands();
  const stored = d.store.get('rm_cloud');
  assert.deepEqual(stored.commands, []);
  assert.deepEqual(stored.mappings, before.mappings);
  assert.deepEqual(stored.buttons, before.buttons);
  assert.deepEqual(d.device.onAutoComplete(), []);
  await assert.rejects(d.listeners.onoff(true), /Mapped command is unavailable/);
  await assert.rejects(d.device.executeCommand({ variable: { id: before.commands[0].id } }), /no longer exists/);
  await assert.rejects(d.listeners[commands.buttonCapability(before.buttons[0])](), /no longer exists/);
  assert.equal(state.sends.length, 0);
  const repair = socket(x.driver, d.device);
  const preview = await repair.cloud_current();
  assert.deepEqual(preview.commands, []);
  await repair.cloud_save_controls({ mappings: {}, buttons: [] });
  assert.deepEqual(d.store.get('rm_cloud').mappings, {});
  assert.deepEqual(d.store.get('rm_cloud').buttons, []);
  assert(!d.device.hasCapability('onoff'));
  await d.device.onUninit(); x.driver.onUninit();
});

test('authorization failure marks unavailable and requires Repair without another send', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  state.send = async () => { throw Object.assign(new Error('private secret'), { code: 'AUTH_REQUIRED' }); };
  await assert.rejects(d.listeners.volume_up(), error => !error.message.includes('private'));
  assert.match(d.device.unavailable, /Repair/); assert.equal(state.sends.length, 1);
  await assert.rejects(d.listeners.volume_up()); assert.equal(state.sends.length, 1);
  assert.equal(d.device._pollTimer, undefined);
  const repair = await select(x.driver, d.device);
  state.send = undefined;
  assert.deepEqual(await repair.handlers.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: repair.preview.mappings, buttons: repair.preview.buttons }), { repair: true });
  assert.equal(d.device.unavailable, false);
  await d.listeners.volume_up(); assert.equal(state.sends.length, 2);
  await d.device.onUninit(); x.driver.onUninit();
});

test('transient cloud failure preserves cached selections and recovers on refresh', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  const before = copy(d.store.get('rm_cloud'));
  state.inventoryError = new Error('private request detail');
  await assert.rejects(d.device.refreshCommands(), error => !error.message.includes('private'));
  assert.match(d.device.unavailable, /Checking again/);
  assert.deepEqual(d.store.get('rm_cloud'), before);
  assert.equal(d.device._authRequired, false);
  assert.equal(x.timers.get(d.device._pollTimer).ms, 60000);
  state.inventoryError = undefined;
  await d.device.refreshCommands(); assert.equal(d.device.unavailable, false);
  assert.equal(state.sends.length, 0);
  await d.device.onUninit(); x.driver.onUninit();
});

test('Repair rejects another account/home and recovers missing or corrupt store from durable identity', async () => {
  const x = await paired();
  for (const initial of [undefined, { broken: true }]) {
    const d = deviceFor(x); d.store.clear(); if (initial) d.store.set('rm_cloud', initial);
    await d.device.onInit(); assert.match(d.device.unavailable, /Repair/);
    const wrongHome = await select(x.driver, d.device, 'home2');
    await assert.rejects(wrongHome.handlers.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: wrongHome.preview.mappings, buttons: wrongHome.preview.buttons }), /original account/);
    assert.equal(d.writes.length, 0);
    state.account = { ...account, userId: 'another-owner' };
    const wrongOwner = await select(x.driver, d.device);
    await assert.rejects(wrongOwner.handlers.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: wrongOwner.preview.mappings, buttons: wrongOwner.preview.buttons }), /original account/);
    state.account = undefined;
    const good = await select(x.driver, d.device);
    await good.handlers.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: good.preview.mappings, buttons: good.preview.buttons });
    assert.equal(d.device.unavailable, false); assert.equal(d.store.get('rm_cloud').remote.endpointId, 'remote1');
    await d.device.onUninit();
  }
  x.driver.onUninit();
});

test('Repair rejects changed physical identity and another remote on the same hub', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  state.endpoints[0].mac = 'ffeeddccbbaa';
  const changed = await select(x.driver, d.device);
  await assert.rejects(changed.handlers.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: changed.preview.mappings, buttons: changed.preview.buttons }), /original account/);
  state.endpoints[0] = { ...hub(), devtype: 0x5213, productId: '00000000000000000000000013520000' };
  const changedType = await select(x.driver, d.device);
  await assert.rejects(changedType.handlers.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: changedType.preview.mappings, buttons: changedType.preview.buttons }), /original account/);
  state.endpoints[0] = hub(); state.endpoints.push({ ...remote, endpointId: 'remote2' });
  const other = await select(x.driver, d.device);
  const preview = await other.handlers.cloud_preview({ hubId: 'hub1', remoteId: 'remote2' });
  await assert.rejects(other.handlers.cloud_complete({ hubId: 'hub1', remoteId: 'remote2', mappings: preview.mappings, buttons: preview.buttons }), /original account/);
  assert.equal(d.writes.length, 0);
  await d.device.onUninit(); x.driver.onUninit();
});

test('disconnected queued Repair and control edits never persist; queued send waits for active completion', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  const repair = await select(x.driver, d.device);
  const wait = deferred(); state.send = () => wait.promise;
  const active = d.listeners.volume_up(); await tick();
  const writes = d.writes.length;
  const pending = repair.handlers.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: repair.preview.mappings, buttons: repair.preview.buttons });
  const rejected = assert.rejects(pending, /expired/);
  const controls = socket(x.driver, d.device);
  const edit = controls.cloud_save_controls({ mappings: {}, buttons: [] });
  const editRejected = assert.rejects(edit, /expired/);
  await repair.handlers.disconnect();
  await controls.disconnect();
  const queuedSend = d.device.executeCommand({ variable: { id: x.bundle.commands[0].id } });
  assert.equal(state.sends.length, 1);
  wait.resolve(); await active; await rejected; await editRejected; await queuedSend;
  assert.equal(d.writes.length, writes); assert.equal(state.sends.length, 2);
  await d.device.onUninit(); x.driver.onUninit();
});

test('uninitialization cancels waiting operations without sending them', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  const wait = deferred(); state.send = () => wait.promise;
  const active = d.listeners.volume_up(); const activeRejected = assert.rejects(active, /cancelled/); await tick();
  const queued = d.device.executeCommand({ variable: { id: x.bundle.commands[0].id } });
  const cancelled = assert.rejects(queued, /cancelled/);
  const stop = d.device.onUninit(); wait.resolve(); await activeRejected; await cancelled; await stop;
  assert.equal(state.sends.length, 1); assert.equal(d.device._waitingOperations.length, 0);
  x.driver.onUninit();
});

test('operation queue rejects excess and expired work without sending it', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  const wait = deferred(); state.send = () => wait.promise;
  const active = d.listeners.volume_up(); await tick();
  const first = d.device.executeCommand({ variable: { id: x.bundle.commands[0].id } });
  const expired = assert.rejects(first, /not started/);
  const second = d.device.executeCommand({ variable: { id: x.bundle.commands[1].id } });
  const third = d.device.executeCommand({ variable: { id: x.bundle.commands[2].id } });
  await assert.rejects(d.device.executeCommand({ variable: { id: x.bundle.commands[3].id } }), /three waiting/);
  const firstTimer = d.device._waitingOperations[0].timer;
  x.timers.get(firstTimer).fn(); await expired;
  assert.equal(state.sends.length, 1);
  wait.resolve(); await active; await second; await third;
  assert.equal(state.sends.length, 3);
  await d.device.onUninit(); x.driver.onUninit();
});
