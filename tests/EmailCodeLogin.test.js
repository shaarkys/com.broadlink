"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EmailCodeLogin } = require("../lib/EmailCodeLogin");
const { safeError } = require("../lib/RMMaxCommands");
let epoch = 2000000000000;
function clock(t) {
  let now = epoch += 1000000;
  t.mock.method(Date, "now", () => now);
  return ms => { now += ms; };
}

test("email-code request binds its email, consumes successful login once and stores no code", async t => {
  clock(t); const auth = new EmailCodeLogin(); const sends = [];
  assert.deepEqual(await auth.request("  owner@example.org ", async email => sends.push(email)), { retryAfter: 60 });
  assert.deepEqual(sends, ["owner@example.org"]);
  let calls = 0;
  await assert.rejects(auth.login("other@example.org", "001234", async () => calls++), e => e.code === "EMAIL_CODE_REQUIRED");
  const account = await auth.login("owner@example.org", "001234", async (email, code) => {
    calls++; assert.equal(email, "owner@example.org"); assert.equal(code, "001234");
    return { provider: "broadlink_eu", userId: "owner", loginSession: "session" };
  });
  assert.equal(calls, 1); assert.equal(account.userId, "owner");
  assert(!JSON.stringify(auth).includes("001234")); assert(!JSON.stringify(auth).includes("session"));
  await assert.rejects(auth.login("owner@example.org", "001234", async () => calls++), e => e.code === "EMAIL_CODE_REQUIRED");
  assert.equal(calls, 1);
});

test("resend protection is shared across pairing sessions, cloud drivers and failed sends", async t => {
  const advance = clock(t); let sends = 0;
  const send = async () => sends++;
  await new EmailCodeLogin().request("owner@example.org", send);
  const reopened = new EmailCodeLogin();
  await assert.rejects(reopened.request("OWNER@example.org", send), e => e.code === "EMAIL_SEND_LIMIT" && e.retryAfter === 60);
  await assert.rejects(reopened.request("different@example.org", send), e => e.retryAfter === 5);
  advance(60000);
  await assert.rejects(reopened.request("owner@example.org", async () => { sends++; throw Error("timeout"); }));
  advance(5000);
  await assert.rejects(new EmailCodeLogin().request("owner@example.org", send), e => e.retryAfter === 55);
  assert.equal(sends, 2);
});

test("five verification attempts require a new code, and local challenge expiry cannot send a login", async t => {
  const advance = clock(t); const auth = new EmailCodeLogin(); let calls = 0;
  await auth.request("owner@example.org", async () => {});
  const invalid = async () => { calls++; throw Object.assign(Error("not exposed"), { code: "EMAIL_CODE_INVALID" }); };
  for (let i = 0; i < 5; i++) await assert.rejects(auth.login("owner@example.org", "1234", invalid));
  await assert.rejects(auth.login("owner@example.org", "1234", invalid), e => e.code === "EMAIL_CODE_LIMIT");
  assert.equal(calls, 5);
  advance(60000); await auth.request("owner@example.org", async () => {});
  await auth.login("owner@example.org", "4321", async () => { calls++; return {}; });
  assert.equal(calls, 6);
  advance(60000); await auth.request("owner@example.org", async () => {});
  advance(600000);
  await assert.rejects(auth.login("owner@example.org", "4321", invalid), e => e.code === "EMAIL_CODE_EXPIRED");
  assert.equal(calls, 6);
});

test("a resend invalidates an earlier session challenge and closing ignores late results", async t => {
  const advance = clock(t), first = new EmailCodeLogin(), second = new EmailCodeLogin();
  await first.request("owner@example.org", async () => {});
  advance(60000); await second.request("owner@example.org", async () => {});
  await assert.rejects(first.login("owner@example.org", "1234", async () => assert.fail("stale code sent")), e => e.code === "EMAIL_CODE_EXPIRED");
  let release;
  const pending = second.login("owner@example.org", "1234", () => new Promise(resolve => { release = resolve; }));
  second.close(); release({ userId: "owner" });
  await assert.rejects(pending, e => e.code === "EMAIL_LOGIN_CLOSED");
  assert.equal(second.challenge, null);
  advance(60000); const late = new EmailCodeLogin();
  const sending = late.request("owner@example.org", () => new Promise(resolve => { release = resolve; }));
  late.close(); release(); await assert.rejects(sending, e => e.code === "EMAIL_LOGIN_CLOSED");
  assert.equal(late.challenge, null);
});

test("invalid inputs do not request emails or reach verification, and errors never expose values", async t => {
  clock(t); const auth = new EmailCodeLogin(); let calls = 0;
  for (const email of ["", "invalid", "a@b\nsecret", "x".repeat(255) + "@a.com"]) await assert.rejects(auth.request(email, async () => calls++), e => e.code === "EMAIL_LOGIN_INPUT");
  await assert.rejects(auth.login("owner@example.org", "1234", async () => calls++), e => e.code === "EMAIL_CODE_REQUIRED");
  await auth.request("owner@example.org", async () => {});
  for (const code of ["", "1234\nsecret", "a".repeat(33), 1234]) await assert.rejects(auth.login("owner@example.org", code, async () => calls++), e => e.code === "EMAIL_LOGIN_INPUT");
  assert.equal(calls, 0);
  for (const code of ["EMAIL_LOGIN_INPUT", "EMAIL_CODE_REQUIRED", "EMAIL_CODE_EXPIRED", "EMAIL_CODE_INVALID", "EMAIL_CODE_LIMIT", "EMAIL_LOGIN_CLOSED", "EMAIL_SEND_LIMIT"]) {
    const message = safeError({ code, message: "secret email and code", retryAfter: 42 });
    assert(!message.includes("secret")); assert.notEqual(message, "The request failed. Check the selected app/account, Internet connection and device availability.");
  }
});
