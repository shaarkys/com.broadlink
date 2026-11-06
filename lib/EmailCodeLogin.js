"use strict";

const crypto = require("crypto");
const RESEND_MS = 60000;
const CHALLENGE_MS = 10 * 60000;
const MAX_ATTEMPTS = 5;
// Shared by all cloud drivers, so reopening pairing cannot bypass resend limits.
const requests = new Map();
let nextRequest = 0;
const failure = (code, retryAfter) => Object.assign(new Error("Email verification sign-in failed"), { code, ...(retryAfter ? { retryAfter } : {}) });

function normalizeEmail(value) {
  if (typeof value !== "string") throw failure("EMAIL_LOGIN_INPUT");
  const email = value.trim();
  if (email.length > 254 || !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(email)) throw failure("EMAIL_LOGIN_INPUT");
  return email;
}

class EmailCodeLogin {
  constructor() { this.challenge = null; this.closed = false; }
  _assertOpen() { if (this.closed) throw failure("EMAIL_LOGIN_CLOSED"); }
  close() { this.closed = true; this.challenge = null; }

  async request(value, send) {
    this._assertOpen();
    const email = normalizeEmail(value), now = Date.now();
    const key = crypto.createHash("sha256").update(email.toLowerCase()).digest("hex");
    for (const [id, entry] of requests) if (entry.expires <= now) requests.delete(id);
    const previous = requests.get(key);
    const retryAt = Math.max(nextRequest, previous ? previous.sentAt + RESEND_MS : 0);
    if (retryAt > now) throw failure("EMAIL_SEND_LIMIT", Math.ceil((retryAt - now) / 1000));
    if (!previous && requests.size >= 100) throw failure("EMAIL_SEND_LIMIT", 60);
    const entry = { sentAt: now, expires: now + CHALLENGE_MS, attempts: 0 };
    requests.set(key, entry); nextRequest = now + 5000;
    this.challenge = null;
    // Reserve the limit before sending, including timeouts with unknown delivery.
    await send(email);
    this._assertOpen();
    this.challenge = { email, key, entry };
    return { retryAfter: RESEND_MS / 1000 };
  }

  async login(value, code, exchange) {
    this._assertOpen();
    const email = normalizeEmail(value);
    if (typeof code === "string") code = code.trim();
    if (typeof code !== "string" || !/^[A-Za-z0-9]{1,32}$/.test(code)) throw failure("EMAIL_LOGIN_INPUT");
    const challenge = this.challenge;
    if (!challenge || challenge.email !== email) throw failure("EMAIL_CODE_REQUIRED");
    if (Date.now() >= challenge.entry.expires || requests.get(challenge.key) !== challenge.entry) {
      this.challenge = null; throw failure("EMAIL_CODE_EXPIRED");
    }
    if (challenge.entry.attempts >= MAX_ATTEMPTS) throw failure("EMAIL_CODE_LIMIT");
    challenge.entry.attempts++;
    const account = await exchange(email, code);
    this._assertOpen();
    this.challenge = null;
    return account;
  }
}

module.exports = { EmailCodeLogin, normalizeEmail };
