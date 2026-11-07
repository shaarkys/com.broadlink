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
  focus() { this.focused = true; }
  scrollIntoView(options) { this.scrolled = options; }
  dispatch(name, force = false) { if (!this.disabled || force) this.events[name]?.(); }
}

function fixture(overrides = {}, language = 'en', view = source) {
  const elements = new Map();
  for (const match of view.matchAll(/<([a-z0-9]+)[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(match[2], new Element(match[1]));
  for (const match of view.matchAll(/<select[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    for (const item of match[2].matchAll(/<option value="([^"]+)"/g)) { const option = new Element('option'); option.value = item[1]; elements.get(match[1]).appendChild(option); }
  }
  const descendants = node => (node?.children || []).flatMap(child => [child, ...descendants(child)]);
  const calls = []; const devices = []; let done = 0;
  const preview = { commands: [{ id: 'on', name: '<img src=x onerror=alert(1)>' }, { id: 'off', name: 'Off' }], skipped: 2,
    skipReasons: { unsupported: 2 }, roles: [{ id: 'power_on', title: { en: 'Power On', nl: 'Aan' } }],
    mappings: { power_on: 'on' }, buttons: ['off'], maxButtons: 12, canAdd: true };
  const handlers = {
    cloud_context: () => ({ modelName: 'RM4 Mini', repair: false, configured: false }),
    cloud_request_code: () => ({ retryAfter: 60 }),
    cloud_login: () => ({ homes: [{ id: 'home1', name: 'Home' }, { id: 'home2', name: 'Second' }] }),
    cloud_discover: () => ({ hubs: [{ id: 'hub1', name: 'Hub' }], summary: { devices: 3, hubs: 1 } }),
    cloud_remotes: () => ({ remotes: [{ id: 'remote1', name: 'TV' }] }),
    cloud_preview: () => preview,
    cloud_current: () => ({ ...preview, hubId: 'saved-hub', remoteId: 'saved-remote', remoteName: '<saved>' }),
    cloud_save_controls: () => ({ repair: true }),
    cloud_complete: () => ({ repair: false, device: { name: 'TV', data: { id: 'safe' } } }),
    ...overrides,
  };
  let now = 0; let nextTimer = 0; const timers = new Map(); const windowEvents = {};
  const context = vm.createContext({
    Date: { now: () => now }, setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; }, clearTimeout: id => timers.delete(id),
    window: { addEventListener: (event, handler) => { windowEvents[event] = handler; } },
    navigator: { language }, document: { getElementById: id => elements.get(id), createElement: tag => new Element(tag),
      querySelectorAll: () => [...elements.values(), ...descendants(elements.get('roles')), ...descendants(elements.get('buttons'))]
        .filter(element => ['input', 'select', 'button'].includes(element.tagName)) },
    Homey: { emit: async (event, data = {}) => { calls.push({ event, data: JSON.parse(JSON.stringify(data)) }); return handlers[event](data); },
      createDevice: async device => { devices.push(device); }, done: () => { done++; } },
  });
  vm.runInContext(view.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  const $ = id => elements.get(id);
  const click = async id => { $(id).dispatch('click'); await settle(); };
  const login = async () => { $('email').value = 'owner@example.invalid'; $('password').value = 'test-pass'; await click('login'); };
  const openPreview = async () => { await settle(); await login(); await click('discover'); await click('remotes'); await click('preview'); };
  const advance = milliseconds => { now += milliseconds; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); } };
  return { $, click, login, openPreview, calls, devices, preview, advance, close: () => windowEvents.pagehide(), get timers() { return timers.size; }, get done() { return done; } };
}

test('all declared pairing and Repair views exist and match their source', () => {
  for (const driver of ['RM3_mini_cloud', 'RM4_mini_cloud', 'RM4_pro_cloud', 'RM5_plus_cloud']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'drivers', driver, 'driver.compose.json'), 'utf8'));
    for (const mode of ['pair', 'repair']) for (const view of manifest[mode]) {
      assert.equal(fs.readFileSync(path.join(root, 'drivers', driver, mode, view.id + '.html'), 'utf8'), source);
    }
  }
  assert.equal(fs.readFileSync(path.join(root, 'drivers/RM_max/repair/cloud.html'), 'utf8'), fs.readFileSync(path.join(root, 'drivers/RM_max/pair/cloud.html'), 'utf8'));
});

test('cloud views contain only the supported browser API surface', () => {
  assert.doesNotThrow(() => new vm.Script(script));
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|localStorage|sessionStorage|fetch\(|XMLHttpRequest|cloud_probe|cloud_send|accessToken|refreshToken|loginSession|cookie|codeList/);
  assert.deepEqual([...new Set([...script.matchAll(/Homey\.([A-Za-z]+)/g)].map(match => match[1]))].sort(), ['createDevice', 'done', 'emit']);
});

test('numeric and named command labels remain exact and are given readable checkbox layout', async () => {
  const commands = [{ id: 'zero', name: '0' }, { id: 'one', name: '1' }, { id: 'menu', name: 'MENÚ' }];
  const f = fixture({ cloud_preview: () => ({ commands, roles: [], buttons: [], mappings: {}, canAdd: true }) });
  await f.openPreview();
  assert.deepEqual(f.$('buttons').children.map(label => label.children[1].textContent), ['0', '1', 'MENÚ']);
  assert(f.$('buttons').children.every(label => !label.children[0].checked && !label.children[0].disabled));
  assert.match(source, /#rm-cloud #buttons label span\s*\{[^}]*font-size:\s*16px/);
  assert.match(source, /#rm-cloud #buttons label\s*\{[^}]*display:\s*flex/);
  await f.click('complete');
  assert.deepEqual(f.calls.at(-1).data.buttons, []);
});

test('a single Power key can be mapped directly without selecting an additional button', async () => {
  const roles = require('../lib/RMCloudCommands').ROLES;
  const f = fixture({ cloud_preview: () => ({ commands: [{ id: 'power-key', name: 'Power' }], roles, buttons: [], mappings: {}, canAdd: true }) });
  await f.openPreview();
  const index = roles.findIndex(role => role.id === 'power_toggle');
  const select = f.$('roles').children[index].children[1];
  select.value = 'power-key'; select.dispatch('change');
  assert.equal(f.$('buttonsTitle').textContent, 'Additional buttons');
  assert.match(f.$('powerHelp').textContent, /Power mappings use Homey’s standard on\/off switch/);
  await f.click('complete');
  assert.deepEqual(f.calls.at(-1).data.mappings, { power_toggle: 'power-key' });
  assert.deepEqual(f.calls.at(-1).data.buttons, []);
});

test('pairing retains the email, clears secrets, renders text safely and creates only the completed device', async () => {
  const f = fixture(); await f.openPreview();
  assert.equal(f.$('email').value, 'owner@example.invalid'); assert.equal(f.$('password').value, '');
  assert.deepEqual(f.calls.find(call => call.event === 'cloud_login').data, { email: 'owner@example.invalid', password: 'test-pass' });
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
  assert.equal(f.$('password').value, ''); assert.equal(f.$('email').value, 'owner@example.invalid');
  assert.equal(f.calls.filter(call => call.event === 'cloud_login').length, 1);
  resolveLogin({ homes: [] }); await settle(); assert.match(f.$('error').textContent, /No homes/);
});

test('Dutch labels and errors remain readable when loading cached controls fails', async () => {
  const f = fixture({ cloud_context: () => ({ repair: true, configured: true }), cloud_current: () => { throw Error('Saved controls could not be loaded'); } }, 'nl-NL');
  await settle(); await f.click('current');
  assert.equal(f.$('current').textContent, 'Bediening wijzigen'); assert.match(f.$('error').textContent, /Saved controls/);
  assert.equal(f.$('complete').disabled, true); assert.equal(f.$('authorize').disabled, false);
});

const maxSource = fs.readFileSync(path.join(root, 'drivers/RM_max/pair/cloud.html'), 'utf8');
for (const [name, view, provider] of [['RM cloud', source, {}], ['RM Max', maxSource, { provider: 'broadlink_eu' }]]) {
  const otp = async f => {
    await settle(); f.$('loginMethod').value = 'email_code'; f.$('loginMethod').dispatch('change');
    f.$('email').value = 'owner@example.invalid'; f.$('email').dispatch('input');
    await f.click('requestCode');
  };
  test(name + ' email code request, cooldown, secret clearing and repair workflow', async () => {
    let resolveLogin;
    const f = fixture({ cloud_context: () => ({ repair: true, configured: false }),
      cloud_login: () => new Promise(resolve => { resolveLogin = resolve; }), cloud_complete: () => ({ repair: true }) }, 'en', view);
    await otp(f);
    assert.deepEqual(f.calls.at(-1), { event: 'cloud_request_code', data: { ...provider, email: 'owner@example.invalid' } });
    assert.equal(f.$('email').value, 'owner@example.invalid'); assert.match(f.$('codeStatus').textContent, /Code requested/);
    f.$('requestCode').dispatch('click', true); await settle();
    assert.equal(f.calls.filter(call => call.event === 'cloud_request_code').length, 1);
    f.advance(59999); assert.equal(f.$('requestCode').disabled, true);
    f.advance(1); assert.equal(f.$('requestCode').disabled, false);
    f.$('code').value = 'aB123longerthansix'; f.$('login').dispatch('click'); f.$('login').dispatch('click', true);
    assert.equal(f.$('code').value, ''); assert.equal(f.$('email').value, 'owner@example.invalid');
    assert.deepEqual(f.calls.at(-1), { event: 'cloud_login', data: { ...provider, email: 'owner@example.invalid', code: 'aB123longerthansix', method: 'email_code' } });
    assert.equal(f.calls.filter(call => call.event === 'cloud_login').length, 1);
    resolveLogin({ homes: [{ id: 'home1', name: 'Home' }] }); await settle();
    assert.equal(f.$('email').value, 'owner@example.invalid');
    await f.click('discover'); if (name === 'RM cloud') await f.click('remotes');
    await f.click('preview'); await f.click('complete');
    assert.equal(f.calls.at(-1).event, 'cloud_complete'); assert.equal(f.devices.length, 0); assert.equal(f.done, 1);
    f.close(); assert.equal(f.timers, 0);
  });
  test(name + ' can retry a corrected code without requesting another email', async () => {
    let attempts = 0;
    const f = fixture({ cloud_login: () => {
      if (++attempts === 1) throw Error('Invalid verification code');
      return { homes: [{ id: 'home1', name: 'Home' }] };
    } }, 'en', view);
    await otp(f); f.$('code').value = 'wrong123'; await f.click('login');
    assert.match(f.$('error').textContent, /Invalid verification code/);
    assert.equal(f.$('email').value, 'owner@example.invalid'); assert.equal(f.$('code').value, '');
    assert.equal(f.$('requestCode').disabled, true);
    f.advance(5000); f.$('code').value = 'correct456'; await f.click('login');
    assert.equal(f.calls.filter(call => call.event === 'cloud_request_code').length, 1);
    assert.deepEqual(f.calls.filter(call => call.event === 'cloud_login').map(call => call.data), [
      { ...provider, email: 'owner@example.invalid', code: 'wrong123', method: 'email_code' },
      { ...provider, email: 'owner@example.invalid', code: 'correct456', method: 'email_code' },
    ]);
    assert.equal(f.$('email').value, 'owner@example.invalid'); assert.equal(f.$('code').value, ''); assert.equal(f.$('home').value, 'home1');
    assert.equal(f.$('error').textContent, ''); f.close();
  });
  test(name + ' failed code sends never claim success and stale requests are ignored', async () => {
    let resolveSend; let fail = true;
    const f = fixture({ cloud_request_code: () => { if (fail) throw Error('Send failed'); return new Promise(resolve => { resolveSend = resolve; }); } }, 'en', view);
    await otp(f); assert.match(f.$('error').textContent, /Send failed/); assert.equal(f.$('codeStatus').textContent, '');
    f.$('code').value = 'not-requested'; await f.click('login'); assert.equal(f.calls.some(call => call.event === 'cloud_login'), false);
    fail = false; f.$('requestCode').dispatch('click'); f.$('requestCode').dispatch('click', true);
    f.$('email').value = 'other@example.invalid'; f.$('email').dispatch('input', true);
    resolveSend({ retryAfter: 60 }); await settle();
    assert.equal(f.$('codeStatus').textContent, ''); assert.equal(f.$('code').value, '');
    assert.equal(f.calls.filter(call => call.event === 'cloud_request_code').length, 2);
    assert.equal(f.$('requestCode').disabled, true); f.advance(60000); assert.equal(f.$('requestCode').disabled, false);
    f.$('code').value = 'stale'; await f.click('login'); assert.equal(f.calls.some(call => call.event === 'cloud_login'), false);
    f.close(); assert.equal(f.timers, 0);
  });
  test(name + ' auth changes discard an in-flight preview and method changes clear secrets', async () => {
    let resolvePreview;
    const f = fixture({ cloud_preview: () => new Promise(resolve => { resolvePreview = resolve; }) }, 'nl-NL', view);
    await settle(); await f.login(); await f.click('discover'); if (name === 'RM cloud') await f.click('remotes');
    f.$('preview').dispatch('click'); f.$('code').value = 'stale';
    f.$('loginMethod').value = 'email_code'; f.$('loginMethod').dispatch('change', true);
    resolvePreview(f.preview); await settle();
    assert.equal(f.$('code').value, ''); assert.equal(f.$('previewSection').hidden, true); assert.equal(f.$('complete').disabled, true);
    f.$('complete').dispatch('click', true); await settle(); assert.equal(f.calls.some(call => call.event === 'cloud_complete'), false);
    assert.equal(f.$('codeLabel').textContent, 'E-mailverificatiecode');
  });
  test(name + ' changing email discards a late successful login', async () => {
    let resolveLogin;
    const f = fixture({ cloud_login: () => new Promise(resolve => { resolveLogin = resolve; }) }, 'en', view);
    await otp(f); f.$('code').value = 'secret'; f.$('login').dispatch('click');
    f.$('email').value = 'different@example.invalid'; f.$('email').dispatch('input', true);
    resolveLogin({ homes: [{ id: 'stale', name: 'Old account home' }] }); await settle();
    assert.equal(f.$('home').children.length, 0); assert.equal(f.$('code').value, ''); assert.equal(f.$('complete').disabled, true);
    f.close();
  });
  test(name + ' closing a view clears cooldown timer and ignores late login', async () => {
    let resolveLogin;
    const f = fixture({ cloud_login: () => new Promise(resolve => { resolveLogin = resolve; }) }, 'en', view);
    await otp(f); assert.equal(f.timers, 1); f.$('code').value = 'secret'; f.$('login').dispatch('click');
    f.close(); assert.equal(f.timers, 0); assert.equal(f.$('code').value, '');
    resolveLogin({ homes: [{ id: 'h', name: 'Home' }] }); await settle(); assert.equal(f.$('home').children.length, 0);
  });
}

test('RM Max preserves password and Magic Home authorization payloads and clears provider secrets', async () => {
  const password = fixture({}, 'en', maxSource); await settle(); await password.login();
  assert.deepEqual(password.calls.at(-1), { event: 'cloud_login', data: { provider: 'broadlink_eu', email: 'owner@example.invalid', password: 'test-pass' } });
  const f = fixture({}, 'en', maxSource); await settle();
  f.$('code').value = 'email-secret'; f.$('password').value = 'old-password';
  f.$('provider').value = 'magic_home'; f.$('provider').dispatch('change');
  assert.equal(f.$('code').value, ''); assert.equal(f.$('password').value, ''); assert.equal(f.$('euFields').hidden, true);
  f.$('authCode').value = 'official-auth'; f.$('region').value = 'us'; await f.click('login');
  assert.deepEqual(f.calls.at(-1), { event: 'cloud_login', data: { provider: 'magic_home', authCode: 'official-auth', region: 'us' } });
  assert.equal(f.$('authCode').value, '');
});

test('RM Max provider changes discard a late preview and cannot request email codes for Magic Home', async () => {
  let resolvePreview;
  const f = fixture({ cloud_preview: () => new Promise(resolve => { resolvePreview = resolve; }) }, 'en', maxSource);
  await settle(); await f.login(); await f.click('discover'); f.$('preview').dispatch('click');
  f.$('provider').value = 'magic_home'; f.$('provider').dispatch('change', true);
  resolvePreview(f.preview); await settle();
  assert.equal(f.$('previewSection').hidden, true); assert.equal(f.$('complete').disabled, true);
  f.$('loginMethod').value = 'email_code'; f.$('requestCode').dispatch('click', true); await settle();
  assert.equal(f.calls.some(call => call.event === 'cloud_request_code'), false);
});

for (const [name, view] of [['RM cloud', source], ['RM Max', maxSource]]) {
  test(name + ' preselects remembered login details and exposes errors without automatically requesting a code', async () => {
    const f = fixture({ cloud_context: () => ({ repair: true, configured: true, login: { email: 'remembered@example.org', method: 'email_code' } }),
      cloud_request_code: () => { throw Error('Pairing session expired. Request a new verification code.'); } }, 'en', view);
    await settle();
    assert.equal(f.$('error').textContent, '');
    assert.equal(f.$('loginMethod').value, 'email_code'); assert.equal(f.$('email').value, 'remembered@example.org');
    assert.equal(f.$('password').value, ''); assert.equal(f.$('code').value, '');
    assert.equal(f.calls.some(call => call.event === 'cloud_request_code'), false);
    if (name === 'RM cloud') await f.click('authorize');
    assert.equal(f.$('email').value, 'remembered@example.org');
    await f.click('requestCode');
    assert.equal(f.calls.at(-1).data.email, 'remembered@example.org');
    assert.equal(f.$('error').focused, true); assert.equal(f.$('error').scrolled.block, 'nearest');
    assert.match(f.$('error').textContent, /session expired/);
    assert.equal(f.$('codeStatus').textContent, '');
    f.close();
  });
}
