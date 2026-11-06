'use strict';

// Protocol adapted from homebridge-broadlink-cloud (MIT); see docs/licenses/homebridge-broadlink-cloud.txt.
const https = require('https');
const crypto = require('crypto');
const { encodeCommand } = require('./RMCloudModels');
const { normalizeEmail } = require('./EmailCodeLogin');
const EU = 'https://app-service-deu-6dc239d5.ibroadlink.com';
const MAGIC = 'https://ha-magic-home-mfdddeskcg.cn-hangzhou.fcapp.run';
const LICENSE = '5eda600025ae5057181daaa2124f79b7';
const SDK_LICENSE = 'XtpgACWuUFcYHaqiEk95t2wiEUaVgDbdm0MtQp5owJTWQbqjHLP46QRO/uZNfe0oclcgXAAAAAAygcbadDq9A72sMSyv3i+zUDfIrMkRKPdWOeDfqdEWwCTBt6/f7KAScKhmP5XJhzUJgVPNWb8gShFuD8z4NFgAsEkbxXTfoUSQjDzWcfVjcAAAAAA=';
const EXPIRED = new Set([-1012, -1009, -1000, 10011, -30129]);
const RM_ERROR_TYPES = new Set(['ENDPOINT_UNREACHABLE', 'NO_SUCH_ENDPOINT', 'INVALID_REQ', 'DEVICE_RESET', 'INVALID_DIRECTIVE', 'INVALID_ACCESSTOKEN', 'INVALID_SIGNATURE', 'INTERNAL_ERROR', 'VALUE_OUT_OF_RANGE', 'FUNCTION_NOT_SUPPORT', 'UNDERSTAND_FAILURE', 'SERVICE_UNAVAILABLE', 'NETWOEK_TIME_OUT']);
const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
const valid = v => typeof v === 'string' && v.length > 0 && v.length <= 2048 && !/[\x00-\x1f\x7f]/.test(v);
const invalid = () => new Error('Invalid cloud response');
const COMPANY_ID = 'b0491bc574dfa144908c3cd671f56370';
function fail(status) {
  const e = new Error(EXPIRED.has(status) ? 'Cloud authentication required' : 'Cloud request rejected');
  if (Number.isSafeInteger(status)) e.remoteStatus = status;
  if (EXPIRED.has(status)) e.code = 'AUTH_REQUIRED';
  return e;
}
function rmResponseError(reason, value) {
  const error = new Error('RM cloud command response rejected');
  error.code = 'RM_CLOUD_RESPONSE'; error.reason = reason;
  const boundedStatus = status => Number.isInteger(status) && status >= -2147483648 && status <= 2147483647;
  if (boundedStatus(value?.status)) error.remoteStatus = value.status;
  const payload = value?.event?.payload;
  if (boundedStatus(payload?.status)) error.deviceStatus = payload.status;
  if (RM_ERROR_TYPES.has(payload?.type)) error.errorType = payload.type;
  if (reason === 'error_response') {
    if (error.errorType === 'INVALID_ACCESSTOKEN') error.code = 'AUTH_REQUIRED';
    if (error.errorType === 'ENDPOINT_UNREACHABLE') error.code = 'ENDPOINT_OFFLINE';
    if (error.errorType === 'NO_SUCH_ENDPOINT') error.code = 'ENDPOINT_MISSING';
  }
  // Device data can echo a learned code. Retain only the decoded byte count,
  // never response text, IDs, messages, cookies or any payload bytes.
  const data = payload?.data;
  if (typeof data === 'string' && data.length <= 131072 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') === data) error.ackBytes = bytes.length;
  }
  return error;
}
function requestHttps(url, options) {
  return new Promise((resolve, reject) => {
    let done = false;
    let req;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => {
      if (req) req.destroy();
      const e = new Error('Cloud request timed out'); e.code = 'TIMEOUT'; finish(e);
    }, options.timeoutMs);
    try {
      req = https.request(url, { method: 'POST', headers: options.headers }, res => {
        if (res.statusCode !== 200) {
          const e = new Error('Cloud HTTP request failed'); e.httpStatus = res.statusCode;
          if (res.statusCode === 401 || res.statusCode === 403) e.code = 'AUTH_REQUIRED';
          finish(e); res.destroy(); req.destroy(); return;
        }
        let size = 0; const chunks = [];
        res.on('data', chunk => {
          if (done) return;
          size += chunk.length;
          if (size > 2 * 1024 * 1024) { req.destroy(); finish(invalid()); return; }
          chunks.push(chunk);
        });
        res.on('error', () => finish(new Error('Cloud request failed')));
        res.on('aborted', () => finish(new Error('Cloud request failed')));
        res.on('end', () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { finish(invalid()); } });
      });
      req.on('error', () => finish(new Error('Cloud request failed')));
      req.end(options.body);
    } catch (_) { finish(new Error('Cloud request failed')); }
  });
}
// Injected request(url, { headers, body, timeoutMs }) returns decoded JSON.
async function call(options, url, headers, body) {
  const timeoutMs = options.timeoutMs === undefined ? 10000 : options.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('Invalid request timeout');
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => (options.request || requestHttps)(url, { headers, body, timeoutMs })),
      new Promise((resolve, reject) => { timer = setTimeout(() => { const e = new Error('Cloud request timed out'); e.code = 'TIMEOUT'; reject(e); }, timeoutMs); }),
    ]);
  } catch (error) {
    const e = new Error(error && error.code === 'TIMEOUT' ? 'Cloud request timed out' : 'Cloud request failed');
    if (error && (error.code === 'TIMEOUT' || error.code === 'AUTH_REQUIRED')) e.code = error.code;
    if (error && Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) e.httpStatus = error.httpStatus;
    throw e;
  } finally { clearTimeout(timer); }
}
function sessionEU(s) {
  if (!record(s) || s.provider !== 'broadlink_eu' || !valid(s.userId) || !valid(s.loginSession) || (s.familyId !== undefined && !valid(s.familyId))) throw new Error('Invalid cloud session');
  return { provider: s.provider, userId: s.userId, loginSession: s.loginSession, ...(s.familyId ? { familyId: s.familyId } : {}) };
}
function headersEU(s) {
  return { userid: s.userId, loginsession: s.loginSession, familyid: s.familyId, licenseid: LICENSE, lid: LICENSE, appVersion: '1.8.33.1a7fbc2ce', language: 'en-us', 'content-type': 'application/json' };
}
function parseCookie(cookie) {
  if (record(cookie)) return cookie;
  if (!valid(cookie) || cookie.length > 16384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cookie)) return null;
  try { const obj = JSON.parse(Buffer.from(cookie, 'base64').toString('utf8')); return record(obj) ? obj : null; } catch (_) { return null; }
}
function rawKey(key) {
  if (typeof key !== 'string') return null;
  if (/^[a-f\d]{32}$/i.test(key)) return Buffer.from(key, 'hex');
  if (/^[A-Za-z0-9+/]{22}==$/.test(key)) { const b = Buffer.from(key, 'base64'); if (b.length === 16 && b.toString('base64') === key) return b; }
  return null;
}
function extractCredentials(endpoint) {
  if (!record(endpoint) || typeof endpoint.mac !== 'string') return null;
  const mac = endpoint.mac.replace(/[:-]/g, '').toLowerCase();
  if (!/^[a-f\d]{12}$/.test(mac)) return null;
  const cookie = parseCookie(endpoint.cookie); if (!cookie) return null;
  const device = record(cookie.device) ? cookie.device : cookie;
  const n = device.terminalid === undefined ? device.id : device.terminalid;
  const key = rawKey(device.aeskey || device.key);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff || !key) return null;
  const id = Buffer.alloc(4); id.writeUInt32LE(n, 0);
  return { id: Array.from(id), key: Array.from(key), mac };
}
function isRMMaxEndpoint(endpoint) {
  if (!record(endpoint)) return false;
  const cookie = parseCookie(endpoint.cookie) || {};
  return [endpoint.productId, cookie.pid, cookie.Pid].some(pid => typeof pid === 'string' && pid.toLowerCase() === '0000000000000000000000008baf0000') || endpoint.devtype === 0xaf8b;
}
async function accountRequest(path, data, email, options) {
  const json = JSON.stringify(data);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = crypto.createHash('md5').update(json + 'xgx3d*fe3478$ukx').digest('hex');
  const key = crypto.createHash('md5').update(timestamp + 'kdixkdqp54545^#*').digest();
  const clear = Buffer.from(json); const padded = Buffer.alloc(Math.ceil(clear.length / 16) * 16 + 16); clear.copy(padded);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.from('eaaaaa3abb5862a21918b5771d1615aa', 'hex')); cipher.setAutoPadding(false);
  const body = Buffer.concat([cipher.update(padded), cipher.final()]);
  const result = await call(options, EU + path, { timestamp, token, email, lid: LICENSE, licenseId: LICENSE, 'content-type': 'application/x-java-serialized-object', system: 'android', appPlatform: 'android', language: 'en-us', appVersion: '1.8.33.1a7fbc2ce', messageId: String(Date.now()) }, body);
  if (!record(result)) throw invalid();
  if (result.error !== 0) throw fail(result.error);
  return result;
}
function accountSession(result) {
  if (!valid(result.userid) || !valid(result.loginsession)) throw invalid();
  return { provider: 'broadlink_eu', userId: result.userid, loginSession: result.loginsession };
}
class BroadlinkCloud {
  constructor(session, options = {}) { this.session = sessionEU(session); this.options = options; }
  getSession() { return { ...this.session }; }
  static async login(email, password, options = {}) {
    if (!valid(email) || !email.includes('@') || !valid(password)) throw new Error('Invalid account credentials');
    return accountSession(await accountRequest('/account/login', { email, password: crypto.createHash('sha1').update(password + '4969fj#k23#').digest('hex'), companyid: COMPANY_ID, lid: LICENSE }, email, options));
  }
  static async requestEmailCode(value, options = {}) {
    const email = normalizeEmail(value);
    // BLLetAccountAndroid 2.13.2: sendFastVCode, not registration/password reset.
    await accountRequest('/account/fastlogincode', { email, companyid: COMPANY_ID, lid: LICENSE }, email, options);
  }
  static async loginWithEmailCode(value, code, options = {}) {
    const email = normalizeEmail(value);
    if (typeof code === 'string') code = code.trim();
    if (typeof code !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(code)) throw Object.assign(new Error('Invalid verification code'), { code: 'EMAIL_LOGIN_INPUT' });
    try {
      // The official Android demo explicitly uses logintry=true. No registration fallback.
      return accountSession(await accountRequest('/account/fastlogin', { email, companyid: COMPANY_ID, lid: LICENSE, code, logintry: 'true' }, email, options));
    } catch (error) {
      if ([-1002, -1007, -1039].includes(error.remoteStatus)) error.code = 'EMAIL_CODE_INVALID';
      if (error.remoteStatus === -1031) error.code = 'EMAIL_CODE_EXPIRED';
      throw error;
    }
  }
  async listHomes() {
    const s = this.session;
    const result = await call(this.options, EU + '/appsync/group/member/getfamilylist', { userid: s.userId, loginsession: s.loginSession, licenseid: LICENSE, language: 'en-us', appVersion: '1.8.33.1a7fbc2ce', timestamp: String(Math.floor(Date.now() / 1000)), messageId: String(Date.now()) }, Buffer.alloc(0));
    if (!record(result)) throw invalid(); if (result.status !== 0) throw fail(result.status);
    if (!record(result.data) || !Array.isArray(result.data.familyList) || result.data.familyList.length > 500) throw invalid();
    const ids = new Set(); return result.data.familyList.map(f => { const id = f && (f.familyid || f.familyId); if (!record(f) || !valid(id) || !valid(f.name) || (f.familyid && f.familyId && f.familyid !== f.familyId) || ids.has(id)) throw invalid(); ids.add(id); return { id, name: f.name }; });
  }
  async request(path, body) {
    if (!this.session.familyId) throw new Error('Family selection required');
    const value = await call(this.options, EU + path, headersEU(this.session), JSON.stringify(body));
    if (!record(value)) throw invalid(); if (value.status !== 0) throw fail(value.status);
    if (!record(value.data)) throw invalid(); return value.data;
  }
  async listDevices() {
    const data = await this.request('/appsync/group/dev/query?action=select', { pids: [] });
    if (!Array.isArray(data.endpoints) || data.endpoints.length > 500 || !data.endpoints.every(e => record(e) && valid(e.endpointId))) throw invalid();
    return data.endpoints;
  }
  async getRemote(endpointId) {
    if (!valid(endpointId)) throw new Error('Invalid endpoint ID');
    const data = await this.request('/appsync/group/ircode/query', { endpointId });
    if (data.endpointId !== endpointId || typeof data.ircodeDesc !== 'string' || data.ircodeDesc.length > 1048576 || !(data.channelList === null || Array.isArray(data.channelList)) || !(data.irData === null || Array.isArray(data.irData))) throw invalid();
    let description; try { description = JSON.parse(data.ircodeDesc); } catch (_) { throw invalid(); }
    if (!record(description) || (data.irData && data.irData.length > 500) || (data.channelList && data.channelList.length > 500)) throw invalid();
    const irData = (data.irData || []).map(c => {
      if (!record(c) || !Array.isArray(c.codeList) || c.codeList.length > 500 || !c.codeList.every(x => record(x) && typeof x.code === 'string' && x.code.length > 0 && x.code.length <= 131072 && !/[\x00-\x1f\x7f]/.test(x.code))) throw invalid();
      return !valid(c.name) && valid(c.function) ? { ...c, name: c.function } : c;
    });
    return { ...data, endpointId, irData, description };
  }
  async sendCode(hub, hex) {
    if (!this.session.familyId || !record(hub) || !valid(hub.endpointId) || !valid(hub.productId) || !valid(hub.mac) || !Number.isSafeInteger(hub.devicetypeFlag) || hub.devicetypeFlag < 0 || typeof hub.cookie !== 'string') throw new Error('Invalid hub endpoint');
    if (typeof hex !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(hex) || hex.length > 131072) throw new Error('Invalid saved code');
    const c = parseCookie(hub.cookie); if (!c || !Number.isSafeInteger(c.terminalid) || c.terminalid < 0 || c.terminalid > 0xffffffff || !rawKey(c.aeskey)) throw new Error('Invalid hub cookie');
    const cookie = Buffer.from(JSON.stringify({ device: { id: c.terminalid, key: c.aeskey, aeskey: c.aeskey, did: hub.endpointId, pid: hub.productId, mac: hub.mac } })).toString('base64');
    const seconds = String(Math.floor(Date.now() / 1000)); const messageId = `${hub.endpointId}-${seconds}`;
    const body = { directive: { header: { namespace: 'DNA.TransmissionControl', name: 'commonControl', interfaceVersion: '2', messageId, timstamp: seconds }, endpoint: { devicePairedInfo: { did: hub.endpointId, pid: hub.productId, mac: hub.mac, devicetypeflag: hub.devicetypeFlag, cookie }, endpointId: hub.endpointId, cookie: {} }, payload: { data: Buffer.concat([Buffer.from('02000000', 'hex'), Buffer.from(hex, 'hex')]).toString('base64'), notpadding: 0 } } };
    const value = await call(this.options, `${EU}/device/control/v2/sdkcontrol?license=${encodeURIComponent(SDK_LICENSE)}`, headersEU(this.session), JSON.stringify(body));
    if (record(value) && EXPIRED.has(value.status)) throw fail(value.status);
    const event = value && value.event;
    if (!record(event) || !record(event.header) || event.header.namespace !== 'DNA.TransmissionControl' || event.header.name !== 'Response' || event.header.interfaceVersion !== '2' || event.header.messageId !== messageId || !record(event.endpoint) || event.endpoint.endpointId !== hub.endpointId || !record(event.payload) || event.payload.data !== 'AgAAAAAAAAAAAAAAAAAAAA==') throw invalid();
  }
  async sendRMCode(hub, hex) {
    const command = encodeCommand(hub, hex);
    if (!this.session.familyId || !record(hub) || !valid(hub.endpointId) || !valid(hub.productId) || !valid(hub.mac) || !Number.isSafeInteger(hub.devicetypeFlag) || hub.devicetypeFlag < 0) throw new Error('Invalid hub endpoint');
    const credentials = extractCredentials(hub);
    if (!credentials) throw new Error('Invalid hub cookie');
    const source = parseCookie(hub.cookie); const device = record(source.device) ? source.device : source;
    if ((device.id !== undefined && device.terminalid !== undefined && device.id !== device.terminalid) || (device.key !== undefined && device.aeskey !== undefined && (!rawKey(device.key) || !rawKey(device.aeskey) || !rawKey(device.key).equals(rawKey(device.aeskey))))) throw new Error('Conflicting hub credentials');
    const endpointId = hub.endpointId;
    const aeskey = Buffer.from(credentials.key).toString('hex');
    const cookie = Buffer.from(JSON.stringify({ device: { id: Buffer.from(credentials.id).readUInt32LE(), key: aeskey, aeskey, did: endpointId, pid: hub.productId, mac: hub.mac } })).toString('base64');
    const seconds = String(Math.floor(Date.now() / 1000)); const messageId = `${endpointId}-${uuid()}`;
    const body = { directive: { header: { namespace: 'DNA.TransmissionControl', name: 'commonControl', interfaceVersion: '2', messageId, timstamp: seconds }, endpoint: { devicePairedInfo: { did: endpointId, pid: hub.productId, mac: hub.mac, devicetypeflag: hub.devicetypeFlag, cookie }, endpointId, cookie: {} }, payload: { data: command.toString('base64'), notpadding: 0 } } };
    const value = await call(this.options, `${EU}/device/control/v2/sdkcontrol?license=${encodeURIComponent(SDK_LICENSE)}`, headersEU(this.session), JSON.stringify(body));
    if (record(value) && value.status !== undefined && value.status !== 0) {
      if (EXPIRED.has(value.status)) throw fail(value.status);
      throw rmResponseError('cloud_rejected', value);
    }
    const event = value && value.event;
    // SDK replies can contain only the send-command word or retain AES padding.
    // Accept those exact forms after response binding/status checks; neither
    // an arbitrary four-byte response nor an unfamiliar reply implies success.
    if (!record(event) || !record(event.header)) throw rmResponseError('response_shape', value);
    if (event.header.name === 'ErrorResponse') throw rmResponseError('error_response', value);
    if (event.header.namespace !== 'DNA.TransmissionControl') throw rmResponseError('header_namespace', value);
    if (event.header.name !== 'Response') throw rmResponseError('header_name', value);
    if (event.header.interfaceVersion !== '2') throw rmResponseError('header_version', value);
    if (event.header.messageId !== messageId) throw rmResponseError('message_binding', value);
    if (!record(event.endpoint) || event.endpoint.endpointId !== endpointId) throw rmResponseError('endpoint_binding', value);
    if (!record(event.payload)) throw rmResponseError('payload_shape', value);
    if (event.payload.status !== undefined && event.payload.status !== 0) throw rmResponseError('payload_rejected', value);
    if (!['AgAAAA==', 'AgAAAAAAAAAAAAAAAAAAAA=='].includes(event.payload.data)) throw rmResponseError('ack_unrecognized', value);
  }
}
function uuid() { const b = crypto.randomBytes(16); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128; const h = b.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }
function magicSession(s) {
  if (!record(s) || s.provider !== 'magic_home' || !['cn', 'us', 'eu'].includes(s.region) || !valid(s.accessToken) || !valid(s.refreshToken) || !Number.isFinite(s.expiresAt) || s.expiresAt <= 0) throw new Error('Invalid cloud session');
  return { provider: s.provider, region: s.region, accessToken: s.accessToken, refreshToken: s.refreshToken, expiresAt: s.expiresAt };
}
function tokenResponse(data, region) {
  if (!record(data)) throw invalid();
  if (!Number.isFinite(data.expires_in) || data.expires_in <= 0) { const e = fail(Number.isInteger(data.status) ? data.status : undefined); e.code = 'AUTH_REQUIRED'; throw e; }
  return magicSession({ provider: 'magic_home', region, accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000 });
}
class MagicHomeCloud {
  constructor(session, options = {}) { this.session = magicSession(session); this.options = options; }
  getSession() { return { ...this.session }; }
  static async authorize(authCode, region, options = {}) {
    if (!valid(authCode) || !['cn', 'us', 'eu'].includes(region)) throw new Error('Invalid authorization');
    const url = `${MAGIC}/oauth/v2/token?grant_type=authorization_code&code=${encodeURIComponent(authCode)}&client_id=&redirect_uri=${encodeURIComponent('http://homeassistant.local:8123')}`;
    return tokenResponse(await call(options, url, { CLOUD_SERVERS_DOMAIN: region, 'content-type': 'application/json' }, JSON.stringify({ auth_code: authCode })), region);
  }
  async refresh() {
    const s = this.session;
    const data = await call(this.options, `${MAGIC}/oauth/v2/token?grant_type=refresh_token&refresh_token=${encodeURIComponent(s.refreshToken)}`, { CLOUD_SERVERS_DOMAIN: s.region }, '');
    this.session = tokenResponse(data, s.region); return this.getSession();
  }
  async ensureSession() { if (Date.now() >= this.session.expiresAt - 30000) await this.refresh(); }
  async directive(path, directive) {
    const value = await call(this.options, `${MAGIC}/dnaproxy/v2/${path}?license=`, { CLOUD_SERVERS_DOMAIN: this.session.region, 'content-type': 'application/json' }, JSON.stringify({ directive }));
    if (!record(value) || !record(value.event) || !record(value.event.payload) || !Number.isInteger(value.event.payload.status)) throw invalid();
    if (value.event.payload.status !== 0) throw fail(value.event.payload.status);
    return { ...value.event, context: value.context };
  }
  async listDevices() {
    await this.ensureSession();
    const event = await this.directive('discover', { header: { namespace: 'DNA.Discovery', name: 'Discover', interfaceVersion: '2', messageId: uuid() }, payload: { scope: { type: 'BearerToken', token: this.session.accessToken } } });
    if (!Array.isArray(event.endpoints) || event.endpoints.length > 500 || !event.endpoints.every(e => record(e) && valid(e.endpointId))) throw invalid();
    return event.endpoints;
  }
  async control(endpoint, namespace, action, payload, version = '2') {
    if (!record(endpoint) || !valid(endpoint.endpointId) || !record(endpoint.cookie) || !valid(namespace) || !valid(action) || !record(payload) || Buffer.byteLength(JSON.stringify(payload)) > 131072) throw new Error('Invalid control request');
    if (!['2', '3'].includes(version)) throw new Error('Unsupported interface version');
    await this.ensureSession();
    return this.directive('control', { header: { namespace, name: action, interfaceVersion: version, messageId: uuid() }, endpoint: { scope: { type: 'BearerToken', token: this.session.accessToken }, cookie: endpoint.cookie, endpointId: endpoint.endpointId }, payload });
  }
}
module.exports = { BroadlinkCloud, MagicHomeCloud, extractCredentials, isRMMaxEndpoint };


