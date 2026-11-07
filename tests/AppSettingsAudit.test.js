'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function settings() {
  const alerts = [];
  const Homey = { alert: (...args) => alerts.push(args) };
  const context = vm.createContext({ console: { error() {} }, setTimeout, clearTimeout,
    document: { getElementById: () => null }, Homey });
  vm.runInContext(fs.readFileSync(path.join(root, 'settings/js/settings.js'), 'utf8'), context);
  return { context, state: vm.runInContext('rfState', context), Homey, alerts };
}

test('app API absence keeps the settings bridge available instead of throwing at startup', () => {
  const filename = path.join(root, 'app.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, process,
    require: name => name === 'homey' ? { App: class {}, Device: class { async setWarning() {} } } : localRequire(name) });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const app = new module.exports();
  const messages = [];
  app._utils = { debugLog: (_, message) => messages.push(message) };
  assert.equal(app.registerApiRoutes(undefined), false);
  assert.match(messages[0], /using settings storage/);
});

test('settings bridge serializes its single result slot and a rejection does not block the next request', async () => {
  const { context } = settings();
  const writes = [], waiting = [];
  context.settingsSet = async (_, key, request) => { assert.equal(key, 'rfManagerAction'); writes.push(request.type); };
  context.waitForResult = (_, requestId) => { const pending = deferred(); waiting.push({ requestId, ...pending }); return pending.promise; };
  const first = context.callAction({}, { type: 'first' });
  const rejected = assert.rejects(first, /mock bridge failure/);
  const second = context.callAction({}, { type: 'second' });
  await tick();
  assert.deepEqual(writes, ['first']);
  waiting[0].reject(new Error('mock bridge failure'));
  await rejected; await tick();
  assert.deepEqual(writes, ['first', 'second']);
  assert.notEqual(waiting[0].requestId, waiting[1].requestId);
  waiting[1].resolve({ ok: true });
  assert.equal((await second).ok, true);
});

test('late command reads cannot replace a different device or a newer refresh', async () => {
  for (const nextMac of ['second', 'first']) {
    const { context, state, alerts } = settings();
    const reads = [], renders = [];
    context.callAction = async () => ({});
    context.renderCommands = () => renders.push(Array.from(state.commands));
    context.setUsageText = () => {};
    const homey = { get: (key, done) => reads.push({ key, done }), alert: (...args) => alerts.push(args) };
    state.selectedMac = 'first'; state.commands = ['old clickable command'];
    const old = context.loadCommands(homey);
    assert.deepEqual(Array.from(state.commands), []);
    await tick();
    state.selectedMac = nextMac;
    const latest = context.loadCommands(homey);
    await tick();
    assert.equal(reads[0].key, 'rfCommands_first');
    assert.equal(reads[1].key, `rfCommands_${nextMac}`);
    reads[1].done(null, ['latest']); await latest;
    reads[0].done(null, ['stale']); await old;
    assert.deepEqual(Array.from(state.commands), ['latest']);
    assert.deepEqual(renders.at(-1), ['latest']);
    assert.equal(alerts.length, 0);
  }
});

test('stale command errors do not show an error for the currently selected device', async () => {
  const { context, state, Homey, alerts } = settings();
  const request = deferred();
  context.callAction = () => request.promise;
  state.selectedMac = 'first';
  const pending = context.loadCommands(Homey);
  state.selectedMac = 'second';
  request.reject(new Error('old request failed'));
  await pending;
  assert.equal(alerts.length, 0);
});

test('delete confirmation cannot send a command deletion to a newly selected device', async () => {
  const { context, state, Homey } = settings();
  const confirmation = deferred(); const actions = [];
  context.askDeleteConfirmation = () => confirmation.promise;
  context.callAction = async (_, action) => { actions.push(action); return {}; };
  state.selectedMac = 'first';
  const pending = context.onDeleteCommand('Power');
  state.selectedMac = 'second';
  confirmation.resolve(true);
  await pending;
  assert.equal(actions.length, 0);
});

test('Pronto results from a previous device cannot replace the current device output', async () => {
  const { context, state } = settings();
  const request = deferred(); let renders = 0;
  context.callAction = () => request.promise;
  context.renderProntoResult = () => { renders++; };
  state.selectedMac = 'first';
  const pending = context.onGeneratePronto('Power');
  state.selectedMac = 'second';
  request.resolve({ prontoHex: 'old device code' });
  await pending;
  assert.equal(state.prontoResult, null);
  assert.equal(renders, 0);
});

test('settings become visible while optional command-manager loading is still pending', () => {
  const { context } = settings(); const order = [];
  context.bindDebugSettings = () => order.push('bind');
  context.loadDebugSettings = () => order.push('debug');
  context.wireRfEvents = () => order.push('events');
  context.loadDevices = () => { order.push('load'); return new Promise(() => {}); };
  context.onHomeyReady({ ready: () => order.push('ready') });
  assert.deepEqual(order, ['bind', 'debug', 'events', 'ready', 'load']);
});
