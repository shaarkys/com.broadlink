'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { BroadlinkCloud, MagicHomeCloud, extractCredentials, isRMMaxEndpoint } = require('../lib/BroadlinkCloud');
const euSession = { provider: 'broadlink_eu', userId: 'uid', loginSession: 'session', familyId: 'home' };
const magicSession = { provider: 'magic_home', region: 'eu', accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 500000 };
const key = '00112233445566778899aabbccddeeff';
const cookie = Buffer.from(JSON.stringify({ terminalid: 0x12345678, aeskey: key })).toString('base64');
const hub = { endpointId: 'hub', productId: '0000000000000000000000008baf0000', mac: 'aa:bb:cc:dd:ee:ff', devicetypeFlag: 1, cookie };
test('EU login is encrypted with SDK hash, token, padding and headers', async () => {
  const session = await BroadlinkCloud.login('test@example.org', 'password', { request: async (url, { headers, body }) => {
    assert.match(url, /\/account\/login$/); assert.equal(headers.lid, '5eda600025ae5057181daaa2124f79b7');
    const aes = crypto.createHash('md5').update(headers.timestamp + 'kdixkdqp54545^#*').digest();
    const decipher = crypto.createDecipheriv('aes-128-cbc', aes, Buffer.from('eaaaaa3abb5862a21918b5771d1615aa', 'hex')); decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(body), decipher.final()]).toString().replace(/\0+$/, '');
    assert.deepEqual(JSON.parse(plain), { email: 'test@example.org', password: crypto.createHash('sha1').update('password4969fj#k23#').digest('hex'), companyid: 'b0491bc574dfa144908c3cd671f56370', lid: headers.lid });
    assert.equal(headers.token, crypto.createHash('md5').update(plain + 'xgx3d*fe3478$ukx').digest('hex'));
    return { error: 0, userid: 'u', loginsession: 's' };
  } });
  assert.deepEqual(session, { provider: 'broadlink_eu', userId: 'u', loginSession: 's' });
});
test('EU family, discovery, remotes preserve ten codes, duplicate and sequence', async () => {
  const commands = Array.from({ length: 10 }, (_, i) => ({ function: `RF${i}`, codeList: [{ code: i < 2 ? 'aaaa' : 'bbbb' }, { code: 'cccc' }] }));
  const cloud = new BroadlinkCloud(euSession, { request: async (url, req) => {
    if (url.includes('getfamilylist')) return { status: 0, data: { familyList: [{ familyid: 'home', name: 'House' }] } };
    assert.equal(req.headers.familyid, 'home');
    if (url.includes('dev/query')) return { status: 0, data: { endpoints: [hub] } };
    assert.deepEqual(JSON.parse(req.body), { endpointId: 'remote' });
    return { status: 0, data: { endpointId: 'remote', irData: commands, ircodeDesc: '{"name":"Remote"}', channelList: null } };
  } });
  assert.deepEqual(await cloud.listHomes(), [{ id: 'home', name: 'House' }]);
  assert.equal((await cloud.listDevices())[0].endpointId, 'hub');
  const remote = await cloud.getRemote('remote'); assert.equal(remote.irData.length, 10); assert.equal(remote.irData[0].name, 'RF0'); assert.equal(remote.irData[1].codeList.length, 2); assert.equal(remote.irData[0].codeList[0].code, remote.irData[1].codeList[0].code);
});
test('EU send uses exact envelope, validates ack and never retries', async () => {
  let count = 0;
  const cloud = new BroadlinkCloud(euSession, { request: async (url, req) => {
    count++; assert.match(url, /\/device\/control\/v2\/sdkcontrol\?license=/);
    const d = JSON.parse(req.body).directive; assert.equal(d.payload.data, Buffer.from('02000000aabb', 'hex').toString('base64'));
    assert.equal(JSON.parse(Buffer.from(d.endpoint.devicePairedInfo.cookie, 'base64')).device.id, 0x12345678);
    return { event: { header: { namespace: 'DNA.TransmissionControl', name: 'Response', interfaceVersion: '2', messageId: d.header.messageId }, endpoint: { endpointId: 'hub' }, payload: { data: 'AgAAAAAAAAAAAAAAAAAAAA==' } } };
  } });
  await cloud.sendCode(hub, 'aabb'); assert.equal(count, 1);
  const bad = new BroadlinkCloud(euSession, { request: async () => { count++; throw new Error('secret in url'); } });
  await assert.rejects(bad.sendCode(hub, 'aabb'), e => !e.message.includes('secret')); assert.equal(count, 2);
});
test('credential extraction requires valid complete credentials and known device identity', () => {
  assert.deepEqual(extractCredentials(hub), { id: [0x78, 0x56, 0x34, 0x12], key: [...Buffer.from(key, 'hex')], mac: 'aabbccddeeff' });
  assert.equal(extractCredentials({ ...hub, mac: null }), null);
  assert.equal(extractCredentials({ ...hub, cookie: { device: { id: 1, key: 'bad' } } }), null);
  assert.equal(extractCredentials({ ...hub, cookie: { device: { id: 1, aeskeyToken: key } } }), null);
  assert.equal(extractCredentials({ ...hub, cookie: { device: { id: 0x100000000, key } } }), null);
  assert.equal(isRMMaxEndpoint(hub), true); assert.equal(isRMMaxEndpoint({ devtype: 0xaf8b }), true); assert.equal(isRMMaxEndpoint({ name: 'RM Max' }), false);
});
test('Magic Home authorization, refresh, discovery and control use official directives', async () => {
  const calls = [];
  const request = async (url, req) => {
    calls.push({ url, req });
    if (url.includes('oauth')) return { access_token: 'new', refresh_token: 'next', expires_in: 100 };
    const d = JSON.parse(req.body).directive;
    if (url.includes('discover')) { assert.equal(d.payload.scope.token, 'new'); return { event: { payload: { status: 0 }, endpoints: [{ endpointId: 'dev', cookie: {} }] } }; }
    assert.deepEqual(d.endpoint.scope, { type: 'BearerToken', token: 'new' }); assert.equal(d.header.namespace, 'DNA.Power'); assert.equal(d.header.name, 'Set'); assert.deepEqual(d.payload, { power: 1 });
    return { event: { payload: { status: 0 } } };
  };
  const session = await MagicHomeCloud.authorize('code', 'eu', { request }); assert.equal(session.provider, 'magic_home'); assert.match(calls[0].url, /grant_type=authorization_code/);
  const cloud = new MagicHomeCloud({ ...magicSession, expiresAt: 1 }, { request });
  const endpoints = await cloud.listDevices(); assert.equal(endpoints.length, 1); assert.equal(cloud.getSession().refreshToken, 'next');
  await cloud.control(endpoints[0], 'DNA.Power', 'Set', { power: 1 }); assert.equal(calls.length, 4);
});
test('malformed, expired, timeout and secret-bearing failures are safe', async () => {
  await assert.rejects(new BroadlinkCloud(euSession, { request: async () => ({ status: -1012, msg: 'secret' }) }).listDevices(), e => e.code === 'AUTH_REQUIRED' && e.remoteStatus === -1012 && !e.message.includes('secret'));
  await assert.rejects(new BroadlinkCloud(euSession, { request: async () => ({ status: 0, data: { endpoints: Array(501).fill({ endpointId: 'a' }) } }) }).listDevices(), /Invalid cloud response/);
  await assert.rejects(new BroadlinkCloud(euSession, { timeoutMs: 5, request: () => new Promise(() => {}) }).listDevices(), e => e.code === 'TIMEOUT');
  await assert.rejects(MagicHomeCloud.authorize('secret', 'eu', { request: async () => { throw new Error('secret token URL'); } }), e => !e.message.includes('secret'));
  await assert.rejects(MagicHomeCloud.authorize('code', 'eu', { request: async () => ({ expires_in: 0, status: 3 }) }), e => e.code === 'AUTH_REQUIRED');
});

test('Magic Home sensor query preserves context and the advertised interface version', async () => {
  const cloud = new MagicHomeCloud(magicSession, { request: async (url, req) => {
    const directive = JSON.parse(req.body).directive;
    assert.equal(directive.header.interfaceVersion, '3');
    assert.equal(directive.header.name, 'ReportState');
    return { event: { payload: { status: 0 } }, context: { properties: [{ namespace: 'DNA.TemperatureSensor', name: 'temperature', value: { value: 22, scale: 'CELSIUS' } }] } };
  } });
  const response = await cloud.control({ endpointId: 'sensor', cookie: {} }, 'DNA.TemperatureSensor', 'ReportState', {}, '3');
  assert.equal(response.context.properties[0].value.value, 22);
});
