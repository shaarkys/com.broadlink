"use strict";

const crypto = require("crypto");
const { identifyHub, validateCode } = require("./RMCloudModels");

const MAX_BUTTONS = 12;
const MODELS = {
  rm3_mini: { driverId: "RM3_mini_cloud", name: "RM3 Mini", assetDriver: "RM3_mini" },
  rm4_mini: { driverId: "RM4_mini_cloud", name: "RM4 Mini", assetDriver: "RM4_mini" },
  rm4_pro: { driverId: "RM4_pro_cloud", name: "RM4 Pro", assetDriver: "RM4_pro" }
};
const ROLES = [
  ["power_on", "Power on", "Inschakelen"], ["power_off", "Power off", "Uitschakelen"],
  ["volume_up", "Volume up", "Volume omhoog"], ["volume_down", "Volume down", "Volume omlaag"],
  ["channel_up", "Channel up", "Kanaal omhoog"], ["channel_down", "Channel down", "Kanaal omlaag"],
  ["play", "Play", "Afspelen"], ["pause", "Pause", "Pauzeren"], ["stop", "Stop", "Stop"],
  ["next", "Next", "Volgende"], ["previous", "Previous", "Vorige"]
].map(([id, en, nl]) => ({ id, title: { en, nl } }));
const CAPABILITIES = { volume_up: "volume_up", volume_down: "volume_down", channel_up: "channel_up", channel_down: "channel_down",
  play: "rmmax_play", pause: "rmmax_pause", stop: "speaker_stop", next: "speaker_next", previous: "speaker_prev" };
const FUNCTIONS = {
  on: "power_on", poweron: "power_on", off: "power_off", poweroff: "power_off",
  volumeup: "volume_up", volup: "volume_up", voladd: "volume_up", volumedown: "volume_down", voldown: "volume_down", volsub: "volume_down",
  channelup: "channel_up", chup: "channel_up", chadd: "channel_up", channeldown: "channel_down", chdown: "channel_down", chsub: "channel_down",
  play: "play", pause: "pause", stop: "stop", next: "next", previous: "previous", prev: "previous"
};
const record = v => !!v && typeof v === "object" && !Array.isArray(v);
const text = v => typeof v === "string" && v.trim().length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v);
const commandId = v => typeof v === "string" && /^[a-f\d]{64}$/.test(v);
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function deviceId(session, hub, remote) {
  return `rmcloud:${hash([session.provider, session.userId, session.familyId, hub.endpointId, remote.endpointId])}`;
}

function remoteFor(endpoints, hub, remoteId) {
  const matches = endpoints.filter(e => e && e.endpointId === remoteId && e.endpointId !== hub.endpointId && e.gatewayId === hub.endpointId);
  if (matches.length !== 1) throw Object.assign(new Error("Saved remote is missing from its original hub. Use Repair if it persists."), { code: "ENDPOINT_MISSING" });
  return matches[0];
}

function normalizeCommands(remote, data, model) {
  if (!record(remote) || !text(remote.endpointId) || !record(data) || data.endpointId !== remote.endpointId || !Array.isArray(data.irData)) throw new Error("Invalid remote command collection");
  if (data.irData.length > 500) throw new Error("Too many cloud commands (maximum 500)");
  const names = new Map(), functions = new Map();
  for (const row of data.irData) {
    if (text(row?.name)) names.set(row.name, (names.get(row.name) || 0) + 1);
    if (text(row?.function)) functions.set(row.function, (functions.get(row.function) || 0) + 1);
  }
  const commands = [], skipReasons = { ambiguous: 0, sequence: 0, invalid: 0 };
  for (const row of data.irData) {
    if (!text(row?.name) || names.get(row.name) !== 1) { skipReasons.ambiguous++; continue; }
    if (!Array.isArray(row.codeList) || row.codeList.length !== 1) { skipReasons.sequence++; continue; }
    const code = row.codeList[0]?.code;
    if (!validateCode(model, code)) { skipReasons.invalid++; continue; }
    const fn = text(row.function) ? row.function : null;
    const identity = fn && functions.get(fn) === 1 ? ["function", fn] : ["name", row.name];
    commands.push({ id: hash([remote.endpointId, ...identity]), name: row.name, remoteId: remote.endpointId,
      code: code.toLowerCase(), ...(fn ? { function: fn } : {}) });
  }
  if (new Set(commands.map(c => c.id)).size !== commands.length || Buffer.byteLength(JSON.stringify(commands)) > 2 * 1024 * 1024) throw new Error("Invalid or oversized command collection");
  return { commands, skipped: Object.values(skipReasons).reduce((a, b) => a + b, 0), skipReasons, remote, supported: true };
}

async function collectRemoteCommands(client, endpoints, hub, remoteId, assertActive = () => {}) {
  assertActive();
  const identified = identifyHub(hub);
  if (!identified) throw new Error("Unknown cloud remote hub model");
  const remote = remoteFor(endpoints, hub, remoteId);
  if (remote.isReachable === false) throw Object.assign(new Error("Remote reported offline"), { code: "ENDPOINT_OFFLINE" });
  const data = await client.getRemote(remote.endpointId);
  assertActive();
  return normalizeCommands(remote, data, identified.model);
}

function suggestMappings(commands) {
  const matches = {};
  for (const command of commands) {
    // Names are user-defined; only machine function metadata may suggest a role.
    const key = typeof command.function === "string" ? command.function.toLowerCase().replace(/[\s_-]/g, "") : "";
    const role = Object.prototype.hasOwnProperty.call(FUNCTIONS, key) ? FUNCTIONS[key] : null;
    if (role) (matches[role] || (matches[role] = [])).push(command.id);
  }
  const mappings = {};
  for (const [role, ids] of Object.entries(matches)) if (ids.length === 1) mappings[role] = ids[0];
  return mappings;
}

function preferences(commands, input, previous = null) {
  if (!record(input) || !record(input.mappings) || !Array.isArray(input.buttons) || input.buttons.length > MAX_BUTTONS) throw new Error("Choose valid control mappings and up to 12 named buttons.");
  const ids = new Set(commands.map(c => c.id));
  const roles = new Set(ROLES.map(r => r.id));
  const mappings = {};
  for (const [role, id] of Object.entries(input.mappings)) {
    if (!roles.has(role)) throw new Error("Unknown standard control mapping");
    if (id === "" || id === null) continue;
    if (!commandId(id) || (!ids.has(id) && previous?.mappings?.[role] !== id)) throw new Error("A selected command is no longer available. Review its control mapping.");
    mappings[role] = id;
  }
  if (mappings.power_on && mappings.power_on === mappings.power_off) throw new Error("Power on and off must use different commands. Use a named button for power toggle.");
  if (new Set(input.buttons).size !== input.buttons.length || input.buttons.some(id => !commandId(id) || (!ids.has(id) && !previous?.buttons?.includes(id)))) throw new Error("A selected named button is no longer available. Review the button selection.");
  return { mappings, buttons: [...input.buttons] };
}

function capabilityIds(prefs) {
  const ids = ["rmmax_status", "button.refresh", "button.check_connection"];
  if (prefs.mappings.power_on && prefs.mappings.power_off) ids.push("onoff");
  for (const [role, capability] of Object.entries(CAPABILITIES)) if (prefs.mappings[role]) ids.push(capability);
  for (const id of prefs.buttons) ids.push(buttonCapability(id));
  return ids;
}

function buttonCapability(id) { return `rmcloud_button.${id.slice(0, 24)}`; }

function preview(result, prefs) {
  return { commands: result.commands.map(({ id, name }) => ({ id, name })), skipped: result.skipped || 0, skipReasons: result.skipReasons || {},
    mappings: { ...prefs.mappings }, buttons: [...prefs.buttons], roles: ROLES, maxButtons: MAX_BUTTONS,
    canAdd: result.commands.length > 0, reason: result.commands.length ? "" : "No supported single-code commands were returned. Learn commands in the BroadLink app, then refresh." };
}

module.exports = { MODELS, ROLES, CAPABILITIES, MAX_BUTTONS, deviceId, remoteFor, normalizeCommands, collectRemoteCommands,
  suggestMappings, preferences, capabilityIds, buttonCapability, preview, record, text, commandId };
