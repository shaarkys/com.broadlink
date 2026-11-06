'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'assets/rm-cloud/cloud.html'), 'utf8');
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1];
const settle = () => new Promise(resolve => setImmediate(resolve));

// A small DOM mock exercises the actual inline script without network or a Homey.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.events = {}; this.attributes = {};
    this._value = ''; this.textContent = ''; this.disabled = false; this.hidden = false;
  }
  get value() { return this.tagName === 'select' && !this._value ? this.children[0]?.value || '' : this._value; }
  set value(value) { this._value = value; }
  replaceChildren() { this.children = []; this._value = ''; }
  appendChild(child) { this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.events[name] = handler; }
  focus() {}
  dispatch(name, force = false) { if (!this.disabled || force) this.events[name]?.(); }
}

function fixture(overrides = {}, language = 'en') {
  const elements = new Map();
  for (const match of source.matchAll(/<([a-z0-9]+)[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(match[2], new Element(match[1]));
  const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
  const calls = []; const devices = []; let done = 0;
  const preview = { commands: [{ id: 'on', name: '<img src=x onerror=alert(1)>' }, { id: 'off', name: 'Off' }], skipped: 2,
    skipReasons: { unsupported: 2 }, roles: [{ id: 'power_on', title: { en: 'Power On', nl: 'Aan' } }],
    mappings: { power_on: 'on' }, buttons: ['off'], maxButtons: 12, canAdd: true };
  const handlers = {
    cloud_context: () => ({ modelName: 'RM4 Mini', repair: false, configured: false }),
    cloud_login: () => ({ homes: [{ id: 'home1', name: 'Home' }, { id: 'home2', name: 'Second' }] }),
    cloud_discover: () => ({ hubs: [{ id: 'hub1', name: 'Hub' }], summary: { devices: 3, hubs: 1 } }),
    cloud_remotes: () => ({ remotes: [{ id: 'remote1', name: 'TV' }] }),
    cloud_preview: () => preview,
    cloud_current: () => ({ ...preview, hubId: 'saved-hub', remoteId: 'saved-remote', remoteName: '<saved>' }),
    cloud_save_controls: () => ({ repair: true }),
    cloud_complete: () => ({ repair: false, device: { name: 'TV', data: { id: 'safe' } } }),
    ...overrides,
  };
  const context = vm.createContext({
    navigator: { language }, document: { getElementById: id => elements.get(id), createElement: tag => new Element(tag),
      querySelectorAll: () => [...elements.values(), ...descendants(elements.get('roles')), ...descendants(elements.get('buttons'))]
        .filter(element => ['input', 'select', 'button'].includes(element.tagName)) },
    Homey: { emit: async (event, data) => { calls.push({ event, data: JSON.parse(JSON.stringify(data)) }); return handlers[event](data); },
      createDevice: async device => { devices.push(device); }, done: () => { done++; } },
  });
  vm.runInContext(script, context);
  const $ = id => elements.get(id);
  const click = async id => { $(id).dispatch('click'); await settle(); };
  const login = async () => { $('email').value = 'owner@example.invalid'; $('password').value = 'test-pass'; await click('login'); };
  const openPreview = async () => { await settle(); await login(); await click('discover'); await click('remotes'); await click('preview'); };
  return { $, click, login, openPreview, calls, devices, preview, get done() { return done; } };
}

test('all generated pairing views are byte-identical and contain only the supported browser API surface', () => {
  for (const driver of ['RM3_mini_cloud', 'RM4_mini_cloud', 'RM4_pro_cloud']) {
    assert.equal(fs.readFileSync(path.join(root, 'drivers', driver, 'pair/cloud.html'), 'utf8'), source);
  }
  assert.doesNotThrow(() => new vm.Script(script));
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|localStorage|sessionStorage|fetch\(|XMLHttpRequest|cloud_probe|cloud_send|accessToken|refreshToken|loginSession|cookie|codeList/);
  assert.deepEqual([...new Set([...script.matchAll(/Homey\.([A-Za-z]+)/g)].map(match => match[1]))].sort(), ['createDevice', 'done', 'emit']);
});

test('pairing clears credentials, renders text safely and creates only the completed device', async () => {
  const f = fixture(); await f.openPreview();
  assert.equal(f.$('email').value, ''); assert.equal(f.$('password').value, '');
  assert.equal(f.$('buttons').children[0].children[1].textContent, f.preview.commands[0].name);
  assert.equal(f.$('skipped').textContent, 'Skipped commands: 2. Reasons: unsupported: 2');
  await f.click('complete');
  assert.deepEqual(f.calls.at(-1), { event: 'cloud_complete', data: { hubId: 'hub1', remoteId: 'remote1', mappings: { power_on: 'on' }, buttons: ['off'] } });
  assert.equal(f.devices.length, 1); assert.equal(f.done, 1);
});

test('selection changes remove stale payloads and disable completion', async () => {
  const f = fixture(); await f.openPreview();
  f.$('home').value = 'home2'; f.$('home').dispatch('change');
  assert.equal(f.$('previewSection').hidden, true); assert.equal(f.$('complete').disabled, true);
  assert.equal(f.$('hubSection').hidden, true); assert.equal(f.$('remoteSection').hidden, true);
  f.$('complete').dispatch('click', true); await settle();
  assert.equal(f.calls.some(call => call.event === 'cloud_complete'), false);
});

test('Repair edits cached controls without login and preserves missing saved selections until cleared', async () => {
  const f = fixture({ cloud_context: () => ({ repair: true, configured: true }),
    cloud_current: () => ({ commands: [{ id: 'valid', name: 'Valid' }], roles: [{ id: 'power_on', title: { en: 'Power On', nl: 'Aan' } }], mappings: { power_on: 'removed-role' },
      buttons: ['removed-button'], maxButtons: 12, canAdd: true, hubId: 'saved', remoteId: 'saved-remote', remoteName: 'Saved TV' }) });
  await settle(); await f.click('current');
  const select = f.$('roles').children[0].children[1];
  assert.equal(select.value, 'removed-role'); assert.match(select.children.at(-1).textContent, /Saved command unavailable/);
  const missingButton = f.$('buttons').children[1].children[0]; assert.equal(missingButton.checked, true);
  await f.click('complete');
  assert.deepEqual(f.calls.map(call => call.event), ['cloud_context', 'cloud_current', 'cloud_save_controls']);
  assert.deepEqual(f.calls.at(-1).data, { mappings: { power_on: 'removed-role' }, buttons: ['removed-button'] });
  assert.equal(f.devices.length, 0); assert.equal(f.done, 1);
});

test('local Repair can switch to renewed authorization without reusing cached selections', async () => {
  const f = fixture({ cloud_context: () => ({ repair: true, configured: true }), cloud_complete: () => ({ repair: true }) });
  await settle(); await f.click('current'); await f.click('authorize');
  assert.equal(f.$('previewSection').hidden, true); assert.equal(f.$('complete').disabled, true); assert.equal(f.$('authSection').hidden, false);
  await f.login(); await f.click('discover'); await f.click('remotes'); await f.click('preview'); await f.click('complete');
  assert.equal(f.calls.at(-1).event, 'cloud_complete'); assert.equal(f.calls.at(-1).data.hubId, 'hub1'); assert.equal(f.devices.length, 0);
});

test('500 supported commands stay available while named buttons are limited to 12', async () => {
  const commands = Array.from({ length: 500 }, (_, i) => ({ id: 'c' + i, name: 'Command ' + i }));
  const f = fixture({ cloud_preview: () => ({ commands, roles: [{ id: 'play', title: { en: 'Play' } }], buttons: [], mappings: {}, canAdd: true, maxButtons: 12 }) });
  await f.openPreview();
  assert.equal(f.$('buttons').children.length, 500); assert.equal(f.$('roles').children[0].children[1].children.length, 501);
  const inputs = f.$('buttons').children.map(label => label.children[0]);
  for (const input of inputs.slice(0, 12)) { input.checked = true; input.dispatch('change'); }
  assert.equal(inputs[12].disabled, true); assert.equal(inputs[0].disabled, false);
  inputs[0].checked = false; inputs[0].dispatch('change'); assert.equal(inputs[12].disabled, false);
  await f.click('complete'); assert.equal(f.calls.at(-1).data.buttons.length, 11);
});

test('busy guards block duplicate actions and credentials clear before login resolves', async () => {
  let resolveLogin;
  const f = fixture({ cloud_login: () => new Promise(resolve => { resolveLogin = resolve; }) });
  await settle(); f.$('email').value = 'owner@example.invalid'; f.$('password').value = 'test-pass';
  f.$('login').dispatch('click'); f.$('login').dispatch('click', true);
  assert.equal(f.$('password').value, ''); assert.equal(f.$('email').value, '');
  assert.equal(f.calls.filter(call => call.event === 'cloud_login').length, 1);
  resolveLogin({ homes: [] }); await settle(); assert.match(f.$('error').textContent, /No homes/);
});

test('Dutch labels and errors remain readable when loading cached controls fails', async () => {
  const f = fixture({ cloud_context: () => ({ repair: true, configured: true }), cloud_current: () => { throw Error('Saved controls could not be loaded'); } }, 'nl-NL');
  await settle(); await f.click('current');
  assert.equal(f.$('current').textContent, 'Bediening wijzigen'); assert.match(f.$('error').textContent, /Saved controls/);
  assert.equal(f.$('complete').disabled, true); assert.equal(f.$('authorize').disabled, false);
});
