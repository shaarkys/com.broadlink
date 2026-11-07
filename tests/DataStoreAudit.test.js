'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let state;
const error = code => Object.assign(new Error(`Mock filesystem ${code}`), { code });
const fakeFs = { promises: {
  async readFile(path) {
    state.calls.push(['read', path]);
    if (state.readError) throw error(state.readError);
    if (!state.files.has(path)) throw error('ENOENT');
    return state.files.get(path);
  },
  async writeFile(path, data) {
    state.calls.push(['write', path, data]);
    if (state.beforeWrite) await state.beforeWrite(path, data);
    if (state.fail === 'write') throw error('ENOSPC');
    state.files.set(path, data);
  },
  async rename(source, target) {
    state.calls.push(['rename', source, target]);
    if (state.fail === 'rename') throw error('EACCES');
    if (!state.files.has(source)) throw error('ENOENT');
    state.files.set(target, state.files.get(source)); state.files.delete(source);
  },
  async unlink(path) {
    state.calls.push(['unlink', path]);
    if (state.beforeUnlink) await state.beforeUnlink(path);
    if (state.fail === 'unlink') throw error('EACCES');
    if (!state.files.has(path)) throw error('ENOENT');
    state.files.delete(path);
  }
} };
const originalLoad = Module._load;
let DataStore;
try {
  Module._load = function (request, ...args) {
    if (request === 'fs') return fakeFs;
    if (request.includes('BroadlinkUtils')) return class { debugLog() {} };
    return originalLoad.call(this, request, ...args);
  };
  DataStore = require('../lib/DataStore');
} finally { Module._load = originalLoad; }

const item = (name, bytes = [1, 2, 3]) => ({ name, cmd: new Uint8Array(bytes) });
const file = name => `/userdata/${name}.json`;
const names = name => JSON.parse(state.files.get(file(name))).map(command => command.name);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function setup(name = 'mock', commands = [item('saved')]) {
  state = { files: new Map([[file(name), JSON.stringify(commands)]]), calls: [] };
  return new DataStore(name, {});
}

test('failed add and rename preserve committed disk and memory through all three retries', async () => {
  for (const failure of ['write', 'rename']) {
    const store = setup(); await store.readCommands(); state.fail = failure;
    assert.equal(await store.addCommand('new', new Uint8Array([4])), false);
    assert.equal(await store.renameCommand('saved', 'renamed'), false);
    assert.deepEqual(store.getCommandNameList(), ['saved']); assert.deepEqual(names('mock'), ['saved']);
    assert.deepEqual([...store.getCommandData('saved')], [1, 2, 3]);
    assert.equal(state.calls.filter(call => call[0] === 'write').length, 6);
    state.fail = null;
    assert.equal(await store.addCommand('new', new Uint8Array([4])), true);
    assert.deepEqual(names('mock'), ['saved', 'new']);
  }
});

test('failed full replacement rolls back its instance snapshot including mutated command bytes', async () => {
  const store = setup(); await store.readCommands();
  store.dataArray[0].name = 'mutated'; store.dataArray[0].cmd[0] = 99;
  state.fail = 'rename';
  await assert.rejects(store.storeCommands(), /three|3 attempts/);
  assert.deepEqual(store.getCommandNameList(), ['saved']); assert.deepEqual([...store.getCommandData('saved')], [1, 2, 3]);
  assert.deepEqual(names('mock'), ['saved']);
  store.dataArray = [null];
  await assert.rejects(store.storeCommands(), /Invalid command storage/);
  assert.deepEqual(store.getCommandNameList(), ['saved']);
});

test('failed delete rejects without changing committed state and later queued work succeeds', async () => {
  const store = setup(); await store.readCommands(); state.fail = 'rename';
  await assert.rejects(store.deleteCommand('saved'), /3 attempts/);
  assert.deepEqual(store.getCommandNameList(), ['saved']); assert.deepEqual(names('mock'), ['saved']);
  state.fail = null;
  assert.equal(await store.deleteCommand('saved'), undefined);
  assert.deepEqual(names('mock'), []); assert.deepEqual(store.getCommandNameList(), []);
});

test('delete-all awaits unlink, serializes a following add and treats only ENOENT as success', async () => {
  const store = setup(); await store.readCommands(); const entered = deferred(), gate = deferred();
  state.beforeUnlink = async () => { entered.resolve(); await gate.promise; };
  let complete = false;
  const deleting = store.deleteAllCommands().then(() => { complete = true; });
  await entered.promise;
  const adding = store.addCommand('new', new Uint8Array([4]));
  await tick(); assert.equal(complete, false); assert.deepEqual(names('mock'), ['saved']);
  assert.deepEqual(store.getCommandNameList(), ['saved']);
  gate.resolve(); await deleting; assert.equal(await adding, true);
  assert.deepEqual(names('mock'), ['new']);
  state.beforeUnlink = null; state.fail = 'unlink';
  await assert.rejects(store.deleteAllCommands(), { code: 'EACCES' });
  assert.deepEqual(names('mock'), ['new']); assert.deepEqual(store.getCommandNameList(), ['new']);
  state.fail = null; assert.equal(await store.deleteAllCommands(), undefined);
  assert.equal(await store.deleteAllCommands(), undefined);
  assert.equal(state.files.has(file('mock')), false); assert.deepEqual(store.getCommandNameList(), []);
  assert.equal(await store.addCommand('after-delete', new Uint8Array([5])), true);
  assert.deepEqual(names('mock'), ['after-delete']);
});

test('two stale instances serialize add, rename and delete against the latest committed file', async () => {
  const first = setup('mock', [item('saved'), item('remove')]); const second = new DataStore('mock', {});
  await Promise.all([first.readCommands(), second.readCommands()]);
  const results = await Promise.all([first.addCommand('new', new Uint8Array([4])), second.renameCommand('saved', 'renamed'), first.deleteCommand('remove')]);
  assert.deepEqual(results, [true, true, undefined]); assert.deepEqual(names('mock'), ['renamed', 'new']);
  await second.readCommands(); assert.deepEqual(second.getCommandNameList(), ['renamed', 'new']);
  assert(second.getCommandData('new') instanceof Uint8Array);
});

test('duplicate additions and rename conflicts are rechecked after serialization', async () => {
  const first = setup(); const second = new DataStore('mock', {});
  assert.deepEqual(await Promise.all([first.addCommand('new', new Uint8Array([4])), second.addCommand('new', new Uint8Array([5]))]), [true, false]);
  assert.deepEqual(await Promise.all([first.renameCommand('saved', 'renamed'), second.renameCommand('new', 'renamed')]), [true, false]);
  assert.deepEqual(names('mock'), ['renamed', 'new']);
  assert.equal(await second.renameCommand('missing', 'other'), false);
});

test('blocked writes for one filename do not block another filename', async () => {
  const first = setup('first'); const second = new DataStore('second', {});
  const entered = deferred(), gate = deferred();
  state.beforeWrite = async path => { if (path === file('first') + '.tmp') { entered.resolve(); await gate.promise; } };
  const pending = first.addCommand('new', new Uint8Array([4])); await entered.promise;
  assert.equal(await second.addCommand('independent', new Uint8Array([5])), true);
  assert.deepEqual(names('second'), ['independent']);
  gate.resolve(); assert.equal(await pending, true);
});

test('explicit full replacements capture immutable invocation snapshots and do not merge', async () => {
  const store = setup(); await store.readCommands(); const entered = deferred(), gate = deferred(); let first = true;
  state.beforeWrite = async () => { if (first) { first = false; entered.resolve(); await gate.promise; } };
  const adding = store.addCommand('temporary', new Uint8Array([4])); await entered.promise;
  const replacement = [item('replacement', [7, 8])]; store.dataArray = replacement;
  const storing = store.storeCommands();
  replacement[0].name = 'changed'; replacement[0].cmd[0] = 99; replacement.push(item('extra'));
  gate.resolve(); await adding; assert.equal(await storing, undefined);
  assert.deepEqual(names('mock'), ['replacement']); assert.deepEqual([...store.getCommandData('replacement')], [7, 8]);
  assert.deepEqual(JSON.parse(state.files.get(file('mock'))), [{ name: 'replacement', cmd: { 0: 7, 1: 8 } }]);
});

test('replacement retries use the captured candidate despite mutation during the write', async () => {
  const store = setup(); await store.readCommands(); store.dataArray = [item('replacement', [7])];
  const snapshots = []; let attempt = 0;
  state.beforeWrite = async (_, data) => {
    snapshots.push(data); store.dataArray = [item('changed')];
    if (++attempt < 3) throw error('EIO');
  };
  await store.storeCommands();
  assert.equal(snapshots.length, 3); assert.equal(new Set(snapshots).size, 1);
  assert.deepEqual(names('mock'), ['replacement']); assert.deepEqual(store.getCommandNameList(), ['replacement']);
});

test('malformed reads and permission failures preserve the complete previous memory snapshot', async () => {
  const store = setup(); await store.readCommands();
  for (const malformed of ['{bad', '{}', JSON.stringify([item('partial'), null])]) {
    state.files.set(file('mock'), malformed);
    await assert.rejects(store.readCommands());
    assert.deepEqual(store.getCommandNameList(), ['saved']); assert.deepEqual([...store.getCommandData('saved')], [1, 2, 3]);
  }
  state.readError = 'EACCES'; await assert.rejects(store.readCommands(), { code: 'EACCES' });
  assert.deepEqual(store.getCommandNameList(), ['saved']);
});

test('read callbacks run after the queue is released, are awaited and propagate errors', async () => {
  const store = setup(); const entered = deferred(), gate = deferred(); let complete = false;
  const reading = store.readCommands(async () => {
    assert.deepEqual(store.getCommandNameList(), ['saved']);
    assert.equal(await store.addCommand('callback-added', new Uint8Array([4])), true);
    entered.resolve(); await gate.promise;
  }).then(() => { complete = true; });
  await entered.promise; assert.equal(complete, false); assert.deepEqual(names('mock'), ['saved', 'callback-added']);
  gate.resolve(); await reading; assert.equal(complete, true);
  await assert.rejects(store.readCommands(() => { throw new Error('callback failure'); }), /callback failure/);
  assert.equal(await store.renameCommand('saved', 'renamed'), true);
  await store.deleteAllCommands(); let calls = 0;
  await store.readCommands(() => { calls++; }); assert.equal(calls, 1); assert.deepEqual(store.getCommandNameList(), []);
});
