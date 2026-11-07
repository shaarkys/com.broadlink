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
test('EU email code endpoints use account encryption and return the existing session contract', async () => {
  const calls = [];
  const request = async (url, req) => {
    const aes = crypto.createHash('md5').update(req.headers.timestamp + 'kdixkdqp54545^#*').digest();
    const decipher = crypto.createDecipheriv('aes-128-cbc', aes, Buffer.from('eaaaaa3abb5862a21918b5771d1615aa', 'hex')); decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(req.body), decipher.final()]).toString().replace(/\0+$/, '');
    assert.equal(req.headers.token, crypto.createHash('md5').update(plain + 'xgx3d*fe3478$ukx').digest('hex'));
    assert.equal(req.headers.email, 'owner@example.org'); assert.equal(req.timeoutMs, 10000);
    assert.equal(req.headers['content-type'], 'application/x-java-serialized-object');
    const fields = JSON.parse(plain);
    assert.equal(fields.lid, req.headers.lid); assert.equal(fields.companyid, 'b0491bc574dfa144908c3cd671f56370');
    assert.equal(fields.email, 'owner@example.org');
    calls.push({ path: new URL(url).pathname, fields });
    if (url.endsWith('/fastlogincode')) { assert.deepEqual(Object.keys(fields).sort(), ['companyid', 'email', 'lid']); return { error: 0, msg: 'sent' }; }
    assert.equal(fields.code, '001234'); assert.equal(fields.logintry, 'true'); assert(!('password' in fields));
    return { error: 0, userid: 'owner', loginsession: 'existing-session', email: 'unnecessary@example.org' };
  };
  assert.equal(await BroadlinkCloud.requestEmailCode(' owner@example.org ', { request }), undefined);
  const session = await BroadlinkCloud.loginWithEmailCode('owner@example.org', '001234', { request });
  assert.deepEqual(calls.map(c => c.path), ['/account/fastlogincode', '/account/fastlogin']);
  assert.deepEqual(session, { provider: 'broadlink_eu', userId: 'owner', loginSession: 'existing-session' });
});

test('email-code failures preserve safe status details, require complete sessions and never retry', async () => {
  for (const [status, code] of [[-1002, 'EMAIL_CODE_INVALID'], [-1007, 'EMAIL_CODE_INVALID'], [-1039, 'EMAIL_CODE_INVALID'], [-1031, 'EMAIL_CODE_EXPIRED'], [-1012, 'AUTH_REQUIRED']]) {
    let calls = 0;
    await assert.rejects(BroadlinkCloud.loginWithEmailCode('owner@example.org', '001234', { request: async () => { calls++; return { error: status, msg: 'secret-code-and-address' }; } }), e => e.code === code && e.remoteStatus === status && !e.message.includes('secret'));
    assert.equal(calls, 1);
  }
  for (const value of [null, {}, { error: '0' }, { error: 0 }, { error: 0, userid: 'owner' }, { error: 0, userid: 'owner', loginsession: '' }]) await assert.rejects(BroadlinkCloud.loginWithEmailCode('owner@example.org', '001234', { request: async () => value }));
  let calls = 0;
  const request = async () => { calls++; throw Error('secret request code'); };
  await assert.rejects(BroadlinkCloud.requestEmailCode('owner@example.org', { request }), e => !e.message.includes('secret'));
  assert.equal(calls, 1);
  await assert.rejects(BroadlinkCloud.requestEmailCode('owner@example.org', { timeoutMs: 5, request: () => { calls++; return new Promise(() => {}); } }), e => e.code === 'TIMEOUT');
  assert.equal(calls, 2);
  for (const email of ['bad', 'x@y.z\nsecret']) await assert.rejects(BroadlinkCloud.requestEmailCode(email, { request }));
  for (const code of ['', 1234, '1'.repeat(33), '1234\nsecret']) await assert.rejects(BroadlinkCloud.loginWithEmailCode('owner@example.org', code, { request }));
  assert.equal(calls, 2);
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
    const license = new URL(url).searchParams.get('license');
    assert.match(license, /^[A-Za-z0-9+/]+={0,2}$/);
    assert(license.includes('+'), 'the original license plus must survive query decoding');
    assert.equal(Buffer.from(license, 'base64').toString('base64'), license);
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

test('RM Max EU rejects explicit failures even with a matching padded acknowledgment and never retries', async () => {
  const cases = [
    { mutate: response => { response.status = -5; }, code: 'RM_CLOUD_RESPONSE', reason: 'cloud_rejected' },
    { mutate: response => { response.event.payload.status = -5; }, code: 'RM_CLOUD_RESPONSE', reason: 'payload_rejected' },
    { mutate: response => { response.status = -1012; }, code: 'AUTH_REQUIRED' },
    ...[['INVALID_ACCESSTOKEN', 'AUTH_REQUIRED'], ['ENDPOINT_UNREACHABLE', 'ENDPOINT_OFFLINE'], ['NO_SUCH_ENDPOINT', 'ENDPOINT_MISSING']].map(([type, code]) => ({
      mutate: response => { response.event.header.name = 'ErrorResponse'; response.event.payload.type = type; }, code, reason: 'error_response'
    }))
  ];
  for (const expected of cases) {
    let requests = 0;
    const client = new BroadlinkCloud(euSession, { request: async (_, { body }) => {
      requests++;
      const directive = JSON.parse(body).directive;
      const response = { status: 0, event: { header: { ...directive.header, name: 'Response' }, endpoint: { endpointId: hub.endpointId },
        payload: { status: 0, data: 'AgAAAAAAAAAAAAAAAAAAAA==' } } };
      expected.mutate(response);
      return response;
    } });
    await assert.rejects(client.sendCode(hub, 'aabb'), error => error.code === expected.code && (!expected.reason || error.reason === expected.reason));
    assert.equal(requests, 1);
  }
});

test('RM Max EU retains response binding and its padded acknowledgment contract', async () => {
  for (const mutate of [
    response => { response.event.header.namespace = 'DNA.Other'; },
    response => { response.event.header.interfaceVersion = '3'; },
    response => { response.event.header.messageId = 'unrelated'; },
    response => { response.event.endpoint.endpointId = 'unrelated'; },
    response => { response.event.payload.data = 'AgAAAA=='; }
  ]) {
    let requests = 0;
    const client = new BroadlinkCloud(euSession, { request: async (_, { body }) => {
      requests++;
      const directive = JSON.parse(body).directive;
      const response = { event: { header: { ...directive.header, name: 'Response' }, endpoint: { endpointId: hub.endpointId },
        payload: { data: 'AgAAAAAAAAAAAAAAAAAAAA==' } } };
      mutate(response); return response;
    } });
    await assert.rejects(client.sendCode(hub, 'aabb'), error => error.code === 'RM_CLOUD_RESPONSE');
    assert.equal(requests, 1);
  }
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
