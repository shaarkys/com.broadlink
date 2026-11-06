"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { getLoginPreferences, rememberLoginPreferences } = require("../lib/CloudLoginPreferences");

function fixture() {
  let saved;
  const homey = { settings: { get() { return saved; }, set(key, value) { saved = JSON.parse(JSON.stringify(value)); } } };
  return { homey, saved: () => saved, corrupt(value) { saved = value; } };
}

test("login preferences retain only email/method and select the original account for Repair", () => {
  const f = fixture();
  assert.equal(getLoginPreferences(f.homey), null);
  rememberLoginPreferences(f.homey, " owner@example.org ", "email_code", "owner");
  const expected = { email: "owner@example.org", method: "email_code" };
  assert.deepEqual(getLoginPreferences(f.homey), expected);
  rememberLoginPreferences(f.homey, "second@example.org", "password", "second");
  assert.deepEqual(getLoginPreferences(f.homey), { email: "second@example.org", method: "password" });
  assert.deepEqual(getLoginPreferences(f.homey, { provider: "broadlink_eu", userId: "owner" }), expected);
  assert.equal(getLoginPreferences(f.homey, { provider: "broadlink_eu", userId: "unknown" }), null);
  assert.equal(getLoginPreferences(f.homey, { provider: "magic_home" }), null);
  assert.deepEqual(Object.keys(f.saved()).sort(), ["accounts", "last"]);
  for (const entry of f.saved().accounts) assert.deepEqual(Object.keys(entry).sort(), ["email", "method", "userId"]);
});

test("login preferences bound accounts, replace prior methods and discard malformed/secret fields", () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) rememberLoginPreferences(f.homey, `user${i}@example.org`, "password", "account" + i);
  assert.equal(f.saved().accounts.length, 10);
  rememberLoginPreferences(f.homey, "changed@example.org", "email_code", "account19");
  assert.equal(f.saved().accounts.length, 10);
  assert.equal(f.saved().accounts[0].method, "email_code");
  f.corrupt({ last: { email: "owner@example.org", method: "email_code", password: "secret", code: "001234" },
    accounts: [{ userId: "owner", email: "owner@example.org", method: "password", loginSession: "secret" }] });
  rememberLoginPreferences(f.homey, "owner@example.org", "email_code", "owner");
  assert(!JSON.stringify(f.saved()).includes("secret")); assert(!JSON.stringify(f.saved()).includes("001234"));
  for (const value of [null, "invalid", { last: { email: "invalid", method: "password" } }, { accounts: [null, {}, { userId: "x", email: "x@y.z", method: "invalid" }] }]) {
    f.corrupt(value); assert.equal(getLoginPreferences(f.homey), null);
  }
});

test("safe command-response messages expose only allowlisted diagnostics", () => {
  const { safeError } = require('../lib/RMMaxCommands');
  const expected = 'Cloud command response rejected (reason=ack_unrecognized, deviceStatus=-5, ackBytes=16). No command was retried.';
  assert.equal(safeError({ code: 'RM_CLOUD_RESPONSE', reason: 'ack_unrecognized', deviceStatus: -5, ackBytes: 16, message: 'secret response' }), expected);
  const text = safeError({ code: 'RM_CLOUD_RESPONSE', reason: 'secret response', remoteStatus: 'secret token', deviceStatus: Infinity, ackBytes: 'private command' });
  assert.equal(text, 'Cloud command response rejected (reason=unclassified). No command was retried.');
});
