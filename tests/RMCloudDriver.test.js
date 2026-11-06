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
  static async requestEmailCode(email) { (state.codeEmails ||= []).push(email); if (state.codeSend) await state.codeSend(); }
  static async loginWithEmailCode(email, code) { (state.codeLogins ||= []).push({ email, code }); return state.codeLogin ? state.codeLogin() : copy(state.account || account); }
  async listHomes() { state.homesReads = (state.homesReads || 0) + 1; return [{ id: 'home1', name: 'Home' }, { id: 'home2', name: 'Other home' }]; }
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
  getCapabilityOptions(id) {
    if (!this.hasCapability(id) || !knownCapability(id)) throw new Error('Invalid Capability: ' + id);
    if (!this.options[id]) throw new Error('Missing Capability Options');
    return this.options[id];
  }
  async setCapabilityOptions(id, options) {
    assert(this.hasCapability(id) && knownCapability(id));
    assert.equal(typeof options.title, 'string', 'runtime capability titles must be strings');
    this.options[id] = copy(options);
  }
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
  const timers = new Map(), actions = new Map(), triggers = [], triggerIds = [], logs = [];
  const savedSettings = new Map();
  let nextTimer = 0;
  const trigger = { async trigger(...args) { triggers.push(args); } };
  driver.homey = { settings: { get: key => savedSettings.get(key), set: (key, value) => savedSettings.set(key, copy(value)) }, i18n: { getLanguage: () => 'en' }, setTimeout(fn, ms) { timers.set(++nextTimer, { fn, ms }); return nextTimer; }, clearTimeout(id) { timers.delete(id); }, flow: {
    getActionCard(id) { const card = { registerRunListener(fn) { this.run = fn; return this; }, getArgument(name) { assert.equal(name, 'variable'); return { registerAutocompleteListener(fn) { card.autocomplete = fn; } }; } }; actions.set(id, card); return card; },
    getDeviceTriggerCard(id) { triggerIds.push(id); return trigger; }
  } };
  driver.getDevices = () => []; driver.log = message => logs.push(message);
  return { driver, timers, actions, triggers, triggerIds, logs };
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
  assert.deepEqual(p.preview.buttons, [], 'new pairings start with no named buttons selected');
  const mapped = new Set(Object.values(p.preview.mappings));
  const buttons = p.preview.commands.filter(command => !mapped.has(command.id)).slice(0, 2).map(command => command.id);
  const result = await p.handlers.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: p.preview.mappings, buttons });
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
  assert.equal(d.device.getCapabilityOptions(customId).title, 'Favorite');
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

test('named button titles use strings, preserve other options and do not rewrite unchanged titles', async () => {
  const x = await paired(); const d = deviceFor(x);
  const id = commands.buttonCapability(x.bundle.buttons[0]);
  d.device.options[id] = { title: { en: 'Old title', nl: 'Oude titel' }, preventTag: true };
  const original = d.device.setCapabilityOptions.bind(d.device); let writes = 0;
  d.device.setCapabilityOptions = async (...args) => { writes++; return original(...args); };
  await d.device.onInit();
  assert.equal(d.device.unavailable, false);
  assert.deepEqual(d.device.getCapabilityOptions(id), { title: 'Favorite', preventTag: true });
  const initialWrites = writes;
  await d.device._syncCapabilities(); assert.equal(writes, initialWrites);
  x.driver.homey.i18n.getLanguage = () => 'nl';
  state.rows = [];
  await d.device.refreshCommands();
  assert.equal(d.device.getCapabilityOptions(id).title, 'Favorite (niet beschikbaar)');
  await d.device.onUninit(); x.driver.onUninit();
});

test('Repair keeps named selections and recovers a control initialization failure without deleting the device', async () => {
  const x = await paired(); const d = deviceFor(x); const logs = [];
  d.device.log = message => logs.push(message);
  const original = d.device.setCapabilityOptions.bind(d.device);
  d.device.setCapabilityOptions = async () => { throw new TypeError('private-session Favorite secret@example.org'); };
  await d.device.onInit();
  assert.match(d.device.unavailable, /Homey controls/);
  assert(logs.some(line => /capability title update failed: rmcloud_button\.[a-f0-9]{24}; TypeError/.test(line)));
  assert(!logs.join('\n').includes('private-session')); assert(!logs.join('\n').includes('Favorite')); assert(!logs.join('\n').includes('secret@example.org'));
  assert.equal(d.device._pollTimer, undefined);
  const handlers = socket(x.driver, d.device);
  assert.equal((await handlers.cloud_context()).configured, true);
  assert.deepEqual((await handlers.cloud_current()).buttons, x.bundle.buttons);
  d.device.setCapabilityOptions = original;
  await handlers.cloud_save_controls({ mappings: x.bundle.mappings, buttons: x.bundle.buttons });
  assert.equal(d.device.unavailable, false); assert.equal(d.device._controlsInitializationFailed, false);
  assert.equal(x.timers.get(d.device._pollTimer).ms, 1000);
  assert.equal(d.device.getData().id, x.result.device.data.id);
  assert.equal(state.sends.length, 0);
  await d.device.onUninit(); x.driver.onUninit();
});

test('editing controls does not override an existing cloud outage or expired authorization', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  d.device._controlsInitializationFailed = true;
  state.inventoryError = new Error('network failure');
  await assert.rejects(d.device.refreshCommands());
  const unavailable = d.device.unavailable;
  await d.device.updateControls({ mappings: x.bundle.mappings, buttons: x.bundle.buttons });
  assert.equal(d.device.unavailable, unavailable);
  d.device._controlsInitializationFailed = true; d.device._authRequired = true;
  await d.device.updateControls({ mappings: x.bundle.mappings, buttons: x.bundle.buttons });
  assert.equal(d.device.unavailable, unavailable);
  await d.device.onUninit(); x.driver.onUninit();
});

test('stopping during the control recovery status update cannot restore availability or polling', async () => {
  for (const stop of ['onUninit', 'onDeleted']) {
    const x = await paired(); const d = deviceFor(x); await d.device.onInit();
    d.device._controlsInitializationFailed = true;
    await d.device.setUnavailable('Homey controls could not be initialized');
    const status = deferred(); const entered = deferred();
    const write = d.device.setCapabilityValue.bind(d.device);
    d.device.setCapabilityValue = async (id, value) => {
      if (id === 'rmmax_status') { entered.resolve(); await status.promise; }
      return write(id, value);
    };
    let availabilityWrites = 0;
    d.device.setAvailable = async () => { availabilityWrites++; d.device.unavailable = false; };
    const edit = d.device.updateControls({ mappings: x.bundle.mappings, buttons: x.bundle.buttons });
    const rejected = assert.rejects(edit, /cancelled/);
    await entered.promise;
    const stopping = d.device[stop]();
    status.resolve(); await rejected; await stopping;
    assert.equal(availabilityWrites, 0);
    assert.match(d.device.unavailable, /Homey controls/);
    assert.equal(d.device._pollTimer, undefined);
    assert.equal(state.sends.length, 0);
    x.driver.onUninit();
  }
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
  assert.equal(d.device.getCapabilityOptions(commands.buttonCapability(favorite.id)).title, 'Favorite (unavailable)');
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


test('all three cloud drivers add remotes through email-code authentication without persisting the code', async t => {
  let now = 2100000000000; t.mock.method(Date, 'now', () => now);
  for (const model of Object.keys(types)) {
    now += 1000000; reset(model);
    const x = makeDriver(model); await x.driver.onInit(); const h = socket(x.driver);
    assert.deepEqual(await h.cloud_request_code({ email: 'owner@example.org' }), { retryAfter: 60 });
    const login = await h.cloud_login({ email: 'owner@example.org', code: '001234', method: 'email_code' });
    assert.equal(login.homes.length, 2);
    await h.cloud_discover({ homeId: 'home1' });
    const preview = await h.cloud_preview({ hubId: 'hub1', remoteId: 'remote1' });
    const result = await h.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: preview.mappings, buttons: preview.buttons });
    const bundle = x.driver.takePairingBundle(result.device.store.bootstrapToken, result.device.data.id);
    assert.deepEqual(state.codeEmails, ['owner@example.org']);
    assert.deepEqual(state.codeLogins, [{ email: 'owner@example.org', code: '001234' }]);
    assert.deepEqual(bundle.session, { ...account, familyId: 'home1' });
    assert.equal(result.device.data.id, commands.deviceId({ ...account, familyId: 'home1' }, hub(model), remote));
    assert(!JSON.stringify(bundle).includes('001234'));
    assert(!JSON.stringify([login, preview, result]).includes(account.loginSession));
    const d = deviceFor({ ...x, bundle, result }); await d.device.onInit();
    assert.equal(d.device.unavailable, false); assert.deepEqual(d.store.get('rm_cloud').session, bundle.session);
    await d.device.onUninit(); x.driver.onUninit();
  }
});

test('email-code Repair retains the original remote, controls and Flow IDs', async t => {
  t.mock.method(Date, 'now', () => 2200000000000);
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  const original = copy(d.store.get('rm_cloud'));
  state.account = { ...account, loginSession: 'renewed-by-code' };
  const h = socket(x.driver, d.device);
  await h.cloud_request_code({ email: 'owner@example.org' });
  await h.cloud_login({ email: 'owner@example.org', code: '001234', method: 'email_code' });
  await h.cloud_discover({ homeId: 'home1' });
  const preview = await h.cloud_preview({ hubId: 'hub1', remoteId: 'remote1' });
  assert.deepEqual(await h.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: preview.mappings, buttons: preview.buttons }), { repair: true });
  const saved = d.store.get('rm_cloud');
  assert.equal(saved.session.loginSession, 'renewed-by-code');
  assert.deepEqual(saved.mappings, original.mappings); assert.deepEqual(saved.buttons, original.buttons);
  assert.deepEqual(saved.commands.map(c => c.id), original.commands.map(c => c.id));
  assert.equal(d.device.getData().id, x.result.device.data.id);
  await d.device.onUninit(); x.driver.onUninit();
});

test('code requests clear prior previews, reject Magic Home and respect disconnect/driver shutdown', async t => {
  let now = 2300000000000; t.mock.method(Date, 'now', () => now);
  const x = await paired(); const h = x.handlers;
  await assert.rejects(h.cloud_request_code({ provider: 'magic_home', email: 'owner@example.org' }), /BroadLink EU/);
  assert.equal(state.codeEmails, undefined);
  await assert.rejects(h.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: {}, buttons: [] }));
  const send = deferred(); state.codeSend = () => send.promise;
  const pending = h.cloud_request_code({ email: 'owner@example.org' });
  await h.disconnect(); send.resolve(); await assert.rejects(pending, /expired/);
  const h2 = socket(x.driver); now += 60000; state.codeSend = undefined;
  await h2.cloud_request_code({ email: 'owner@example.org' });
  const login = deferred(); state.codeLogin = () => login.promise;
  const verifying = h2.cloud_login({ email: 'owner@example.org', code: '001234', method: 'email_code' });
  const reads = state.homesReads;
  x.driver.onUninit(); login.resolve(copy(account));
  await assert.rejects(verifying, /expired/); assert.equal(state.homesReads, reads);
});

test('a new code request renews an expired cloud pairing session and invalidates its old preview', async t => {
  let now = 2400000000000; t.mock.method(Date, 'now', () => now);
  for (const model of Object.keys(types)) {
    now += 1000000; reset(model);
    const x = makeDriver(model); await x.driver.onInit();
    const selected = await select(x.driver); const h = selected.handlers;
    now += 600001;
    await assert.rejects(h.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: {}, buttons: [] }), e => e.code === 'PAIRING_EXPIRED');
    await assert.rejects(h.cloud_login({ email: 'owner@example.org', code: '001234', method: 'email_code' }), e => e.code === 'PAIRING_EXPIRED');
    assert.equal(state.codeEmails, undefined); assert.equal(state.codeLogins, undefined);
    assert.deepEqual(await h.cloud_request_code({ email: 'owner@example.org' }), { retryAfter: 60 });
    await assert.rejects(h.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: {}, buttons: [] }));
    await h.cloud_login({ email: 'owner@example.org', code: '001234', method: 'email_code' });
    await h.cloud_discover({ homeId: 'home1' });
    const preview = await h.cloud_preview({ hubId: 'hub1', remoteId: 'remote1' });
    const completed = await h.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: preview.mappings, buttons: [] });
    assert.equal(completed.device.data.id, commands.deviceId({ ...account, familyId: 'home1' }, hub(model), remote));
    assert(x.logs.some(line => /session renewed after expiry/.test(line)));
    assert(x.logs.some(line => /cloud_complete failed.*Pairing session expired/.test(line)));
    assert(x.logs.some(line => /cloud_request_code started/.test(line)));
    assert(x.logs.some(line => /cloud_request_code succeeded; durationMs=/.test(line)));
    assert(x.logs.some(line => /cloud_login succeeded/.test(line)));
    assert(!x.logs.join('\n').includes('owner@example.org')); assert(!x.logs.join('\n').includes('001234')); assert(!x.logs.join('\n').includes(account.loginSession));
    x.driver.onUninit();
  }
});

test('pairing logs blocked and failed requests without releasing another in-flight request or exposing secrets', async t => {
  t.mock.method(Date, 'now', () => 2500000000000); reset();
  const x = makeDriver(); await x.driver.onInit(); const h = socket(x.driver);
  const sending = deferred(); state.codeSend = () => sending.promise;
  const request = h.cloud_request_code({ email: 'owner@example.org' });
  await assert.rejects(h.cloud_request_code({ email: 'other@example.org' }), e => e.code === 'PAIRING_BUSY');
  await assert.rejects(h.cloud_context(), e => e.code === 'PAIRING_BUSY');
  sending.resolve(); await request;
  await h.disconnect();
  await assert.rejects(h.cloud_request_code({ email: 'owner@example.org' }), e => e.code === 'PAIRING_CLOSED');
  assert.equal(state.codeEmails.length, 1);
  assert(x.logs.some(line => /cloud_context failed.*still running/.test(line)));
  assert(x.logs.some(line => /session disconnected/.test(line)));
  assert(x.logs.some(line => /cloud_request_code failed.*session expired or closed/.test(line)));
  const next = socket(x.driver);
  state.codeLogin = async () => { throw Error('owner@example.org 001234 private-session'); };
  // Use the existing requested challenge in a fresh session only after another request.
  await assert.rejects(next.cloud_login({ email: 'owner@example.org', code: '001234', method: 'email_code' }));
  assert(!x.logs.join('\n').includes('owner@example.org')); assert(!x.logs.join('\n').includes('001234')); assert(!x.logs.join('\n').includes('private-session'));
  x.driver.onUninit();
  await assert.rejects(next.cloud_request_code({ email: 'owner@example.org' }), e => e.code === 'PAIRING_CLOSED');
});

test('remembered login method and email carry across cloud drivers and follow the original Repair account', async t => {
  t.mock.method(Date, 'now', () => 2600000000000); reset();
  const x = makeDriver(); await x.driver.onInit(); const h = socket(x.driver);
  assert.equal((await h.cloud_context()).login, null);
  await h.cloud_request_code({ email: 'owner@example.org' });
  await h.cloud_login({ email: 'owner@example.org', code: '001234', method: 'email_code' });
  const expected = { email: 'owner@example.org', method: 'email_code' };
  const another = makeDriver('rm3_mini'); another.driver.homey.settings = x.driver.homey.settings;
  await another.driver.onInit();
  assert.deepEqual((await socket(another.driver).cloud_context()).login, expected);
  const repairDevice = { getStoreValue: () => ({ session: { ...account } }), controlsPreview() { return {}; } };
  assert.deepEqual((await socket(x.driver, repairDevice).cloud_context()).login, expected);
  const other = socket(x.driver);
  state.account = { ...account, userId: 'second' };
  await other.cloud_login({ email: 'second@example.org', password: 'secret-password' });
  assert.deepEqual((await socket(x.driver).cloud_context()).login, { email: 'second@example.org', method: 'password' });
  assert.deepEqual((await socket(x.driver, repairDevice).cloud_context()).login, expected);
  const saved = JSON.stringify(x.driver.homey.settings.get('broadlink_cloud_login_preferences'));
  for (const secret of ['001234', 'secret-password', 'private-session']) assert(!saved.includes(secret));
  x.driver.onUninit(); another.driver.onUninit();
});

test('new single-toggle pairings expose standard onoff without an automatic named power button', async () => {
  for (const model of Object.keys(types)) {
    reset(model); state.rows = [row('Power', 'power_toggle')];
    const x = makeDriver(model); await x.driver.onInit(); const selected = await select(x.driver);
    const result = await selected.handlers.cloud_complete({ hubId: 'hub1', remoteId: 'remote1', mappings: selected.preview.mappings, buttons: [] });
    assert(result.device.capabilities.includes('onoff'));
    assert(!result.device.capabilities.some(id => id.startsWith('rmcloud_button.')));
    const bundle = x.driver.takePairingBundle(result.device.store.bootstrapToken, result.device.data.id);
    const d = deviceFor({ ...x, result, bundle }); await d.device.onInit();
    assert(d.device.hasCapability('onoff')); assert.equal(typeof d.listeners.onoff, 'function');
    assert.equal(d.values.onoff, undefined, 'pairing does not infer appliance state');
    await d.device.onUninit(); x.driver.onUninit();
  }
});

test('single-toggle onoff sends each requested value once and updates only after acknowledgment', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  const power = x.bundle.commands.find(command => command.function === 'power_on');
  await d.device.updateControls({ mappings: { power_toggle: power.id }, buttons: [power.id] });
  const id = commands.buttonCapability(power.id);
  assert(d.device.hasCapability('onoff')); assert(d.device.hasCapability(id));
  assert.equal(d.device.getCapabilityOptions(id).title, 'On');
  const originalSend = d.device._sendCloudCommand.bind(d.device); const sentCommands = [];
  d.device._sendCloudCommand = (client, command) => { sentCommands.push(copy(command)); return originalSend(client, command); };
  for (const value of [true, false, false]) {
    const acknowledgment = deferred(); state.send = () => acknowledgment.promise;
    const before = d.values.onoff; const sends = state.sends.length; const triggers = x.triggers.length;
    const pending = d.listeners.onoff(value); await tick();
    assert.equal(state.sends.length, sends + 1); assert.equal(d.values.onoff, before); assert.equal(x.triggers.length, triggers);
    acknowledgment.resolve(); assert.equal(await pending, true);
    assert.equal(d.values.onoff, value); assert.equal(x.triggers.length, triggers + 1);
  }
  state.send = undefined;
  await d.listeners[id]();
  assert.equal(d.values.onoff, false, 'an additional raw toggle button does not guess a new state');
  assert.equal(state.sends.length, 4); assert(state.sends.every(send => send.code === power.code));
  assert(sentCommands.every(command => command.namespace === undefined && command.payload === undefined));
  await d.device.onUninit(); x.driver.onUninit();
});

test('failed toggle acknowledgment leaves onoff unchanged and emits no sent-command Flow trigger', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  await d.device.updateControls({ mappings: { power_toggle: x.bundle.mappings.power_on }, buttons: [] });
  await d.device.setCapabilityValue('onoff', false);
  state.send = async () => { throw Object.assign(Error('unrecognized response'), { code: 'RM_CLOUD_RESPONSE', reason: 'ack_unrecognized', ackBytes: 16 }); };
  await assert.rejects(d.listeners.onoff(true), /ack_unrecognized/);
  assert.equal(state.sends.length, 1); assert.equal(d.values.onoff, false); assert.equal(x.triggers.length, 0);
  assert.equal(d.device.unavailable, false);
  await d.device.onUninit(); x.driver.onUninit();
});

test('one-sided discrete onoff rejects the missing direction before sending and retains explicit additional buttons', async () => {
  for (const [role, supported] of [['power_on', true], ['power_off', false]]) {
    const x = await paired(); const d = deviceFor(x); await d.device.onInit();
    const power = x.bundle.commands.find(command => command.id === x.bundle.mappings[role]);
    const id = commands.buttonCapability(power.id);
    await d.device.updateControls({ mappings: { [role]: power.id }, buttons: [power.id] });
    assert(d.device.hasCapability('onoff')); assert(d.device.hasCapability(id));
    assert.equal(d.device.getCapabilityOptions(id).title, power.name);
    await assert.rejects(d.listeners.onoff(!supported), /map the missing direction or use Power button \(toggle\)/);
    assert.equal(state.sends.length, 0); assert.equal(x.triggers.length, 0); assert.equal(d.values.onoff, undefined);
    await d.listeners.onoff(supported);
    assert.deepEqual(state.sends.map(send => send.code), [power.code]); assert.equal(d.values.onoff, supported);
    await d.listeners[id](); assert.equal(state.sends.length, 2);
    await d.device.onUninit(); x.driver.onUninit();
  }
});

test('discrete onoff directions take precedence over an explicit toggle fallback', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  const { power_on: on, power_off: off } = x.bundle.mappings;
  const toggle = x.bundle.buttons[0];
  await d.device.updateControls({ mappings: { power_on: on, power_off: off, power_toggle: toggle }, buttons: [] });
  await d.listeners.onoff(true); await d.listeners.onoff(false);
  assert.deepEqual(state.sends.map(send => send.code), [on, off].map(id => x.bundle.commands.find(command => command.id === id).code));
  await d.device.updateControls({ mappings: { power_on: on, power_toggle: toggle }, buttons: [] });
  await d.listeners.onoff(false);
  assert.equal(state.sends[2].code, x.bundle.commands.find(command => command.id === toggle).code);
  assert.equal(d.values.onoff, false);
  assert(!d.device.getCapabilities().some(id => id.startsWith('rmcloud_button.')));
  await d.device.onUninit(); x.driver.onUninit();
});

test('old automatic power buttons migrate to onoff before removal and preserve explicit additional buttons idempotently', async () => {
  const x = await paired(); const power = x.bundle.mappings.power_on;
  x.bundle.mappings = { power_toggle: power };
  const d = deviceFor(x); const oldId = commands.buttonCapability(power); const explicitId = commands.buttonCapability(x.bundle.buttons[0]);
  d.device.caps.add(oldId); d.device.caps.add(explicitId);
  const changes = []; const logs = []; d.device.log = message => logs.push(message);
  const add = d.device.addCapability.bind(d.device), remove = d.device.removeCapability.bind(d.device);
  d.device.addCapability = async id => { changes.push(['add', id]); await add(id); };
  d.device.removeCapability = async id => { changes.push(['remove', id]); await remove(id); };
  const saved = copy(d.store.get('rm_cloud'));
  await d.device.onInit();
  assert(d.device.hasCapability('onoff')); assert(!d.device.hasCapability(oldId)); assert(d.device.hasCapability(explicitId));
  assert(changes.findIndex(([action, id]) => action === 'add' && id === 'onoff') < changes.findIndex(([action, id]) => action === 'remove' && id === oldId));
  assert(logs.some(line => /capability migration completed: onoff/.test(line)));
  assert(!logs.join('\n').includes(account.loginSession)); assert(!logs.join('\n').includes('Favorite'));
  const count = changes.length; await d.device._syncCapabilities(); assert.equal(changes.length, count);
  assert.deepEqual(d.store.get('rm_cloud'), saved); assert.equal(d.device.getData().id, x.result.device.data.id);
  assert.deepEqual(d.device.onAutoComplete(), x.preview.commands);
  await d.device.onUninit(); x.driver.onUninit();
});

test('a failed onoff capability migration retains the old automatic power button', async () => {
  const x = await paired(); const power = x.bundle.mappings.power_on;
  x.bundle.mappings = { power_toggle: power }; x.bundle.buttons = []; x.bundle.buttonLabels = {};
  const d = deviceFor(x); const oldId = commands.buttonCapability(power); const logs = [];
  d.device.caps.add(oldId); d.device.log = message => logs.push(message);
  const add = d.device.addCapability.bind(d.device);
  d.device.addCapability = async id => { if (id === 'onoff') throw Error('SDK rejected capability'); return add(id); };
  await d.device.onInit();
  assert(d.device.hasCapability(oldId)); assert(!d.device.hasCapability('onoff'));
  assert.match(d.device.unavailable, /Homey controls/);
  assert(logs.some(line => /capability migration failed: onoff/.test(line)));
  d.device.addCapability = add; await d.device._syncCapabilities();
  assert(d.device.hasCapability('onoff')); assert(!d.device.hasCapability(oldId));
  await d.device.onUninit(); x.driver.onUninit();
});

test('unrecognized command acknowledgements stay distinct from authorization and inventory availability', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  const logs = []; d.device.log = message => logs.push(message);
  state.send = async () => { throw Object.assign(Error('private session and command echo'), { code: 'RM_CLOUD_RESPONSE', reason: 'ack_unrecognized', ackBytes: 16 }); };
  await assert.rejects(d.listeners.volume_up(), /reason=ack_unrecognized, ackBytes=16/);
  assert.equal(d.device.unavailable, false); assert.equal(d.device._authRequired, false);
  assert.equal(state.sends.length, 1); assert.equal(x.triggers.length, 0);
  assert(!logs.join('\n').includes('private')); assert(!d.values.rmmax_status.includes('Repair'));
  assert(x.timers.has(d.device._pollTimer));
  state.send = undefined;
  await d.listeners.volume_up(); assert.equal(state.sends.length, 2); assert.equal(x.triggers.length, 1);
  await d.device.onUninit(); x.driver.onUninit();
});

test('explicit token, offline and missing command errors still enter the appropriate recovery path', async () => {
  for (const [errorType, code] of [['INVALID_ACCESSTOKEN', 'AUTH_REQUIRED'], ['ENDPOINT_UNREACHABLE', 'ENDPOINT_OFFLINE'], ['NO_SUCH_ENDPOINT', 'ENDPOINT_MISSING']]) {
    const x = await paired(); const d = deviceFor(x); await d.device.onInit();
    state.send = async () => { throw Object.assign(Error('private response'), { code, reason: 'error_response', errorType, deviceStatus: -3 }); };
    await assert.rejects(d.listeners.volume_up(), new RegExp('errorType=' + errorType));
    assert.equal(state.sends.length, 1); assert.equal(x.triggers.length, 0);
    assert.equal(d.device._authRequired, code === 'AUTH_REQUIRED');
    if (code === 'AUTH_REQUIRED') {
      assert.match(d.device.unavailable, /Repair/); assert.equal(d.device._pollTimer, undefined);
    } else {
      assert.match(d.device.unavailable, /Checking again/); assert(x.timers.has(d.device._pollTimer));
      assert(!d.device.unavailable.includes('private'));
    }
    await d.device.onUninit(); x.driver.onUninit();
  }
});

test('the reported -5 control response means no device response, without alleging expired login or powered-off state', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  state.send = async () => { throw Object.assign(Error('private response'), { code: 'ENDPOINT_OFFLINE', reason: 'error_response', errorType: 'ENDPOINT_UNREACHABLE', deviceStatus: -5 }); };
  await assert.rejects(d.listeners.volume_up(), /deviceStatus=-5/);
  assert.match(d.device.unavailable, /no response.*status -5/);
  assert(!/offline|Repair|authorization/.test(d.device.unavailable));
  assert.equal(d.device._authRequired, false); assert.equal(state.sends.length, 1); assert.equal(x.triggers.length, 0);
  assert.equal(x.timers.get(d.device._pollTimer).ms, 60000);
  await d.device.onUninit(); x.driver.onUninit();
});

test('stopping while a toggle acknowledgment updates onoff cancels the old operation without additional commands', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  await d.device.updateControls({ mappings: { power_toggle: x.bundle.mappings.power_on }, buttons: [] });
  const status = deferred(); const entered = deferred(); const write = d.device.setCapabilityValue.bind(d.device);
  d.device.setCapabilityValue = async (id, value) => {
    if (id === 'onoff') { entered.resolve(); await status.promise; }
    return write(id, value);
  };
  const power = d.listeners.onoff(true); const rejected = assert.rejects(power, /cancelled/);
  await entered.promise;
  const stopping = d.device.onUninit(); status.resolve(); await rejected; await stopping;
  assert.equal(state.sends.length, 1); assert.equal(x.triggers.length, 0);
  assert.equal(d.device._pollTimer, undefined);
  x.driver.onUninit();
});

test('sent-command Flows observe the acknowledged requested state for the standard toggle power control', async () => {
  const x = await paired(); const d = deviceFor(x); await d.device.onInit();
  await d.device.updateControls({ mappings: { power_toggle: x.bundle.mappings.power_on }, buttons: [] });
  const observed = [];
  x.driver.commandSent.trigger = async () => { observed.push(d.values.onoff); };
  await d.listeners.onoff(true); await d.listeners.onoff(false);
  assert.deepEqual(observed, [true, false]); assert.equal(state.sends.length, 2);
  await d.device.onUninit(); x.driver.onUninit();
});

test('real cloud short-ack parsing completes controls, power values and sent-command Flows without resending', async () => {
  const x = await paired('rm4_mini'); const d = deviceFor(x); await d.device.onInit();
  let requests = 0;
  const client = new realCloud.BroadlinkCloud(x.bundle.session, { request: async (url, req) => {
    requests++;
    const directive = JSON.parse(req.body).directive;
    return { event: { header: { namespace: 'DNA.TransmissionControl', name: 'Response', interfaceVersion: '2', messageId: directive.header.messageId },
      endpoint: { endpointId: directive.endpoint.endpointId }, payload: { data: 'AgAAAA==' } } };
  } });
  state.send = () => { const sent = state.sends.at(-1); return client.sendRMCode(sent.endpoint, sent.code); };
  const observed = [];
  x.driver.commandSent.trigger = async () => { observed.push(d.values.onoff); };
  await d.listeners.onoff(true); await d.listeners.volume_up(); await d.listeners.onoff(false);
  assert.deepEqual(observed, [true, true, false]);
  assert.equal(d.values.onoff, false); assert.equal(d.device.unavailable, false);
  assert.equal(d.values.rmmax_status, 'Command acknowledged via cloud');
  assert.equal(requests, 3); assert.equal(state.sends.length, 3);
  assert.deepEqual(state.sends.map(sent => sent.code), [rows[0].codeList[0].code, rows[2].codeList[0].code, rows[1].codeList[0].code]);
  await d.device.onUninit(); x.driver.onUninit();
});
