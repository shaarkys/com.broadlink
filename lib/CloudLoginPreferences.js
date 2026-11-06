"use strict";

const { normalizeEmail } = require("./EmailCodeLogin");
const KEY = "broadlink_cloud_login_preferences";
const userId = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

function hint(value) {
  if (!value || !["password", "email_code"].includes(value.method)) return null;
  try { return { email: normalizeEmail(value.email), method: value.method }; }
  catch (_) { return null; }
}

function read(homey) {
  const saved = homey.settings.get(KEY);
  return { last: hint(saved?.last), accounts: (Array.isArray(saved?.accounts) ? saved.accounts.slice(0, 10) : [])
    .filter(entry => userId(entry?.userId) && hint(entry)).map(entry => ({ userId: entry.userId, ...hint(entry) })) };
}

function getLoginPreferences(homey, session) {
  if (session?.provider === "magic_home") return null;
  const saved = read(homey);
  // Repair must use the original account, rather than a different last-used account.
  const selected = session?.userId ? saved.accounts.find(entry => entry.userId === session.userId) : saved.last;
  return hint(selected);
}

function rememberLoginPreferences(homey, email, method, accountId) {
  const selected = hint({ email, method });
  if (!selected) return;
  const saved = read(homey);
  const accounts = userId(accountId) ? [{ userId: accountId, ...selected }, ...saved.accounts.filter(entry => entry.userId !== accountId)].slice(0, 10) : saved.accounts;
  homey.settings.set(KEY, { last: selected, accounts });
}

module.exports = { getLoginPreferences, rememberLoginPreferences };
