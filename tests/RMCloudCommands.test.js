'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const commands = require('../lib/RMCloudCommands');
const { identifyHub } = require('../lib/RMCloudModels');
const remote = { endpointId: 'remote1', gatewayId: 'hub1', friendlyName: 'TV' };
const hub = { endpointId: 'hub1', devtype: 0x520b };
const IR = '2600040011223344', RF = 'b200040011223344';
const row = (name, fn, code = IR) => ({ name, ...(fn ? { function: fn } : {}), codeList: [{ code }] });
const normalize = (rows, model = 'rm4_pro') => commands.normalizeCommands(remote, { endpointId: remote.endpointId, irData: rows }, model);

test('machine function identity survives display rename, reorder and code refresh', () => {
  const original = normalize([row('Power', 'power_on'), row('Louder', 'volume_up')]).commands;
  const refreshed = normalize([row('Volume changed', 'volume_up', '2600040044332211'), row('Start TV', 'power_on')]).commands;
  for (const before of original) {
    const after = refreshed.find(command => command.function === before.function);
    assert.equal(after.id, before.id);
    assert.notEqual(after.name, before.name);
  }
  assert.notEqual(refreshed[0].code, original[1].code);
  const named = normalize([row('User label')]).commands[0];
  assert.equal(named.id, normalize([row('User label', null, RF)]).commands[0].id);
  assert.notEqual(named.id, normalize([row('New label')]).commands[0].id);
  assert.notEqual(named.id, commands.normalizeCommands({ ...remote, endpointId: 'remote2' }, { endpointId: 'remote2', irData: [row('User label')] }, 'rm4_pro').commands[0].id);
});

test('normalization excludes duplicate labels, sequences, malformed and model-unsupported codes', () => {
  const result = normalize([row('Duplicate', 'a'), row('Duplicate', 'b'), { name: 'Sequence', codeList: [{ code: IR }, { code: IR }] }, row('Malformed', 'bad', 'aabb'), row('Radio', 'radio', RF), row('Good', 'play')], 'rm4_mini');
  assert.deepEqual(result.commands.map(command => command.name), ['Good']);
  assert.deepEqual(result.skipReasons, { ambiguous: 2, sequence: 1, invalid: 2 });
  assert.equal(result.skipped, 5);
  assert.equal(normalize([row('RF', 'radio', RF)]).commands.length, 1);
  assert.throws(() => commands.normalizeCommands(remote, { endpointId: 'wrong', irData: [] }, 'rm4_pro'), /Invalid remote/);
  assert.throws(() => normalize(Array(501).fill(row('x'))), /Too many/);
});

test('suggestions use unambiguous machine functions and never user-facing names', () => {
  const result = normalize([row('Power on'), row('Volume up'), row('Actual on', 'power_on'), row('First louder', 'volume_up'), row('Other louder', 'vol_up'), row('Play', 'unrecognized'), row('Pause in any language', 'PAUSE')]);
  const mapping = commands.suggestMappings(result.commands);
  assert.deepEqual(Object.keys(mapping).sort(), ['pause', 'power_on']);
  assert.equal(mapping.power_on, result.commands.find(command => command.name === 'Actual on').id);
  const duplicateFunctions = normalize([row('A', 'play'), row('B', 'play')]).commands;
  assert.notEqual(duplicateFunctions[0].id, duplicateFunctions[1].id);
  assert.deepEqual(commands.suggestMappings(duplicateFunctions), {});
});

test('saved missing selections survive refresh until explicitly cleared; new unknown selections fail', () => {
  const [on, off] = normalize([row('On', 'power_on'), row('Off', 'power_off')]).commands;
  const previous = { mappings: { power_on: on.id }, buttons: [off.id] };
  assert.deepEqual(commands.preferences([], previous, previous), previous);
  assert.deepEqual(commands.preferences([], { mappings: { power_on: '' }, buttons: [] }, previous), { mappings: {}, buttons: [] });
  assert.throws(() => commands.preferences([], previous), /no longer available/);
  assert.throws(() => commands.preferences([on], { mappings: { power_on: on.id, power_off: on.id }, buttons: [] }), /different commands/);
  assert.throws(() => commands.preferences([on], { mappings: { unknown: on.id }, buttons: [] }), /Unknown/);
  assert.throws(() => commands.preferences([on], { mappings: {}, buttons: [on.id, on.id] }), /no longer available/);
  assert.throws(() => commands.preferences([on], { mappings: {}, buttons: Array(13).fill(on.id) }), /up to 12/);
});

test('one durable remote identity includes provider, account, home, hub and remote', () => {
  const session = { provider: 'broadlink_eu', userId: 'owner', familyId: 'home' };
  const id = commands.deviceId(session, hub, remote);
  assert.equal(id, commands.deviceId({ ...session, loginSession: 'renewed' }, { ...hub, friendlyName: 'New hub name' }, { ...remote, friendlyName: 'New name' }));
  const variants = [commands.deviceId({ ...session, provider: 'other' }, hub, remote), commands.deviceId({ ...session, userId: 'other' }, hub, remote), commands.deviceId({ ...session, familyId: 'other' }, hub, remote), commands.deviceId(session, { ...hub, endpointId: 'hub2' }, remote), commands.deviceId(session, hub, { ...remote, endpointId: 'remote2' })];
  assert.equal(new Set([id, ...variants]).size, 6);
});

test('collection requires exact model and remote-to-hub binding before reading commands', async () => {
  let reads = 0;
  const client = { async getRemote(id) { reads++; return { endpointId: id, irData: [row('Play', 'play')] }; } };
  assert.equal(identifyHub(hub).model, 'rm4_pro');
  await assert.rejects(commands.collectRemoteCommands(client, [{ ...remote, gatewayId: 'other' }], hub, remote.endpointId), /original hub/);
  await assert.rejects(commands.collectRemoteCommands(client, [remote, remote], hub, remote.endpointId), /original hub/);
  await assert.rejects(commands.collectRemoteCommands(client, [remote], { ...hub, devtype: 0xaf8b }, remote.endpointId), /Unknown/);
  await assert.rejects(commands.collectRemoteCommands(client, [{ ...remote, isReachable: false }], hub, remote.endpointId), error => error.code === 'ENDPOINT_OFFLINE');
  assert.equal(reads, 0);
  const result = await commands.collectRemoteCommands(client, [remote], hub, remote.endpointId);
  assert.equal(result.commands.length, 1); assert.equal(reads, 1);
});

test('preview exposes selection metadata only, while controls contain only explicitly mapped roles', () => {
  const result = normalize([row('Play', 'play'), row('Power', 'power_on')]);
  const prefs = { mappings: { play: result.commands[0].id, power_on: result.commands[1].id }, buttons: [result.commands[1].id] };
  const ids = commands.capabilityIds(prefs);
  assert(ids.includes('rmmax_play')); assert(!ids.includes('onoff')); assert(!ids.includes('volume_up'));
  assert(ids.includes(commands.buttonCapability(prefs.buttons[0])));
  const preview = commands.preview(result, prefs);
  assert.deepEqual(preview.commands, result.commands.map(({ id, name }) => ({ id, name })));
  assert(!JSON.stringify(preview).includes(IR));
  assert(!JSON.stringify(preview).includes('gatewayId'));
});
