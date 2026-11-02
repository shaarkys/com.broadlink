"use strict";

const crypto = require("crypto");
const { BroadlinkCloud, MagicHomeCloud, extractCredentials, isRMMaxEndpoint } = require("./BroadlinkCloud");

const text = value => typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
const clone = value => JSON.parse(JSON.stringify(value));

function clientFor(session) {
  if (session && session.provider === "broadlink_eu") return new BroadlinkCloud(session);
  if (session && session.provider === "magic_home") return new MagicHomeCloud(session);
  throw new Error("Unsupported cloud account");
}

function credentialFingerprint(hub) {
  const credentials = extractCredentials(hub);
  return credentials ? crypto.createHash("sha256").update(JSON.stringify(credentials)).digest("hex") : null;
}

function deviceId(session, hub) {
  return `${session.provider}:${hub.endpointId}`;
}

function inventorySummary(endpoints) {
  return {
    devices: endpoints.length,
    hubs: endpoints.filter(isRMMaxEndpoint).length,
    credentialSets: endpoints.filter(endpoint => extractCredentials(endpoint)).length,
  };
}

// A name is a selector only inside its own remote. Reject ambiguous names and sequences.
function commandsForRemote(endpoint, remote) {
  const counts = new Map();
  for (const command of remote.irData) {
    if (text(command.name)) counts.set(command.name, (counts.get(command.name) || 0) + 1);
  }
  const commands = [];
  let skipped = 0;
  for (const command of remote.irData) {
    const code = command.codeList && command.codeList.length === 1 && command.codeList[0].code;
    if (!text(command.name) || counts.get(command.name) !== 1 || typeof code !== "string" ||
        code.length > 131072 || !/^(?:[\da-f]{2})+$/i.test(code)) {
      skipped++;
      continue;
    }
    const id = crypto.createHash("sha256").update(JSON.stringify([endpoint.endpointId, command.name])).digest("hex");
    commands.push({ id, name: `${text(endpoint.friendlyName) ? endpoint.friendlyName : "Remote"} / ${command.name}`,
      remoteId: endpoint.endpointId, code: code.toLowerCase() });
  }
  return { commands, skipped };
}

async function collectCommands(client, endpoints, hub) {
  if (!isRMMaxEndpoint(hub)) throw new Error("The selected device is not an identified RM Max");
  // Magic Home's official API has no verified equivalent of the EU saved-code query.
  if (client.getSession().provider !== "broadlink_eu") return { commands: [], skipped: 0, supported: false };
  const remotes = endpoints.filter(endpoint => endpoint.endpointId !== hub.endpointId && endpoint.gatewayId === hub.endpointId);
  if (remotes.length > 50) throw new Error("This hub has too many remotes for one import (maximum 50)");
  const results = new Array(remotes.length);
  let next = 0;
  let failure;
  let commandCount = 0;
  let commandBytes = 2;
  await Promise.all(Array.from({ length: Math.min(3, remotes.length) }, async () => {
    while (next < remotes.length) {
      if (failure) return;
      const index = next++;
      try {
        const result = commandsForRemote(remotes[index], await client.getRemote(remotes[index].endpointId));
        commandCount += result.commands.length;
        commandBytes += Buffer.byteLength(JSON.stringify(result.commands));
        if (commandCount > 500 || commandBytes > 2 * 1024 * 1024) throw new Error("The saved command collection is too large (maximum 500 commands / 2 MiB)");
        results[index] = result;
      }
      catch (error) { failure = error; return; }
    }
  }));
  // Drain in-flight reads before releasing the device's operation lock.
  if (failure) throw failure;
  const commands = results.flatMap(result => result.commands);
  const labels = new Map();
  const usedLabels = new Set(commands.map(command => command.name));
  for (const command of commands) labels.set(command.name, (labels.get(command.name) || 0) + 1);
  for (const command of commands) {
    if (labels.get(command.name) < 2) continue;
    const base = command.name;
    const remoteTag = command.remoteId.length <= 64 ? command.remoteId : crypto.createHash("sha256").update(command.remoteId).digest("hex");
    let label = `${base} [${remoteTag}]`;
    // Reserve original labels too, so a user-supplied name cannot collide with a qualifier.
    let suffix = 0;
    while (usedLabels.has(label)) label = `${base} [${remoteTag}:${command.id}:${++suffix}]`;
    usedLabels.add(label);
    command.name = label;
  }
  if (commands.length > 500 || Buffer.byteLength(JSON.stringify(commands)) > 2 * 1024 * 1024) {
    throw new Error("The saved command collection is too large (maximum 500 commands / 2 MiB)");
  }
  return { commands, skipped: results.reduce((sum, result) => sum + result.skipped, 0), supported: true };
}

function safeError(error) {
  // Never pass arbitrary network errors, URLs or response bodies to Homey's logs/UI.
  if (error && error.code === "AUTH_REQUIRED") return "Cloud authorization expired or was rejected. Use Repair to sign in again.";
  if (error && error.code === "TIMEOUT") return "Request timed out. No command was retried.";
  if (error && Number.isInteger(error.deviceError)) return `Local request rejected (device error ${error.deviceError}).`;
  if (error && Number.isInteger(error.httpStatus)) return `Cloud request failed (HTTP ${error.httpStatus}).`;
  if (error && Number.isInteger(error.remoteStatus)) return `Cloud request rejected (status ${error.remoteStatus}).`;
  return "The request failed. Check the selected app/account, Internet connection and device availability.";
}

module.exports = { clientFor, credentialFingerprint, deviceId, inventorySummary, collectCommands, commandsForRemote, safeError, clone };
