"use strict";

const crypto = require("crypto");
const text = v => typeof v === "string" && v.trim().length > 0 && v.length <= 128 && !/[\x00-\x1f\x7f]/.test(v);
const capabilities = endpoint => Array.isArray(endpoint.capabilities) ? endpoint.capabilities.slice(0, 32) : [];
const supported = value => Array.isArray(value?.supported) ? value.supported.slice(0, 500) : [];
const versionFor = cap => cap.version === undefined ? "2" : String(cap.version);
const idFor = (endpoint, namespace, action, payload) => crypto.createHash("sha256").update(JSON.stringify([endpoint.endpointId, namespace, action, payload])).digest("hex");

// Only documented requests are generated, and only when discovery advertises them.
const FIXED = [
  ["DNA.PowerControl", "ChangePowerState", "powerState", [["Power on", "ON", "onoff"], ["Power off", "OFF"]]],
  ["DNA.ChannelControl", "AdjustChannel", "channelSteps", [["Channel up", 1, "button.channel_up"], ["Channel down", -1, "button.channel_down"]]],
  ["DNA.VolumeControl", "AdjustVolume", "volumeSteps", [["Volume up", 1, "button.volume_up"], ["Volume down", -1, "button.volume_down"]]],
  ["DNA.VolumeControl", "SetMute", "mute", [["Mute", true], ["Unmute", false]]],
  ...["DNA.PlaybackController", "DNA.PlaybackControl"].flatMap(ns => ["Play", "Pause", "Stop", "Next", "Previous", "Resume"].map(action =>
    [ns, action, null, [[action, null, ["Play", "Pause", "Stop"].includes(action) ? `button.${action.toLowerCase()}` : undefined]]]))
];
const SENSORS = [
  ["DNA.TemperatureSensor", "temperature", "measure_temperature"],
  ["DNA.HumiditySensor", "humidity", "measure_humidity"]
];

function magicProfile(endpoint) {
  if (!endpoint.cookie || typeof endpoint.cookie !== "object" || Array.isArray(endpoint.cookie)) return { commands: [], sensors: [], skipped: 0, supported: false };
  const commands = [], sensors = [], used = new Set();
  let skipped = 0;
  for (const cap of capabilities(endpoint)) {
    if (!cap || !["2", "3"].includes(versionFor(cap))) continue;
    const actions = supported(cap.actions);
    const properties = supported(cap.properties);
    const add = (name, action, payload, capability) => {
      const id = idFor(endpoint, cap.interface, action, payload);
      if (used.has(id)) return;
      if (commands.length >= 500) throw new Error("Too many cloud commands (maximum 500)");
      used.add(id);
      commands.push({ id, name, namespace: cap.interface, action, payload, version: versionFor(cap), ...(capability ? { capability } : {}) });
    };
    if (cap.interface === "DNA.CustomizedRemoteControl") {
      const names = actions.map(a => a?.name);
      for (const action of actions) {
        if (!text(action?.name) || names.filter(name => name === action.name).length !== 1) { skipped++; continue; }
        add(action.name, action.name, {});
      }
    } else {
      for (const [namespace, action, property, variants] of FIXED) {
        if (cap.interface !== namespace || !actions.some(a => a?.name === action) || (property && !properties.some(p => p?.name === property))) continue;
        for (const [name, value, capability] of variants) add(name, action, property ? { [property]: value } : {}, capability);
      }
    }
    for (const [namespace, property, capability] of SENSORS) {
      if (cap.interface === namespace && cap.properties?.retrievable !== false && properties.some(p => p?.name === property) && !sensors.some(s => s.capability === capability)) {
        sensors.push({ namespace, property, capability, version: versionFor(cap) });
      }
    }
  }
  if (commands.length > 500) throw new Error("Too many cloud commands (maximum 500)");
  const counts = new Map();
  for (const command of commands) counts.set(command.name, (counts.get(command.name) || 0) + 1);
  const labels = new Set(commands.map(command => command.name));
  for (const command of commands) if (counts.get(command.name) > 1) {
    const base = `${command.name} (${command.namespace})`;
    let name = base, suffix = 0;
    while (labels.has(name)) name = `${base} [${command.id.slice(0, 12)}:${++suffix}]`;
    labels.add(name); command.name = name;
  }
  return { commands, sensors, skipped, supported: true };
}

function capabilityIds(profile) {
  return [...new Set(["rmmax_status", "button.refresh", "button.check_connection", ...profile.commands.map(c => c.capability).filter(Boolean), ...profile.sensors.map(s => s.capability)])];
}

function parameterCommand(endpoint, type, value) {
  if (!["channel", "volume"].includes(type)) throw new Error("Unsupported parameterized command.");
  const channel = type === "channel";
  const namespace = channel ? "DNA.ChannelControl" : "DNA.VolumeControl";
  const action = channel ? "ChangeChannel" : "SetVolume";
  const property = channel ? "channelNumber" : "volume";
  if (!Number.isInteger(value) || value < (channel ? 1 : 0) || value > (channel ? 9999 : 100)) throw new Error("Value is outside the supported range.");
  const cap = capabilities(endpoint).find(c => c?.interface === namespace && ["2", "3"].includes(versionFor(c)) && supported(c.actions).some(a => a?.name === action) && supported(c.properties).some(p => p?.name === property));
  if (!cap) throw new Error("This remote does not advertise that action.");
  const payload = { [property]: channel ? String(value) : value };
  return { id: idFor(endpoint, namespace, action, payload), name: channel ? "Set channel" : "Set volume", namespace, action, payload, version: versionFor(cap) };
}

function sensorValue(sensor, response) {
  const props = Array.isArray(response?.context?.properties) ? response.context.properties : [];
  const matches = props.filter(p => p?.namespace === sensor.namespace && p.name === sensor.property);
  if (matches.length !== 1) return null;
  const data = matches[0].value;
  let value = typeof data === "number" ? data : data?.value;
  if (!Number.isFinite(value)) return null;
  if (sensor.capability === "measure_temperature") {
    if (data?.scale === "FAHRENHEIT") value = (value - 32) * 5 / 9;
    else if (data?.scale && data.scale !== "CELSIUS") return null;
    return value >= -100 && value <= 200 ? value : null;
  }
  return value >= 0 && value <= 100 ? value : null;
}

module.exports = { magicProfile, capabilityIds, parameterCommand, sensorValue };
