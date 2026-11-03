"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { magicProfile, capabilityIds, parameterCommand, sensorValue } = require("../lib/RMMaxMagic");
const cap = (interfaceName, actions, properties = []) => ({ interface: interfaceName, version: "2", actions: { supported: actions.map(name => ({ name })) }, properties: { supported: properties.map(name => ({ name })) } });
const endpoint = { endpointId: "tv", cookie: { did: "hub" }, capabilities: [cap("DNA.PowerControl", ["ChangePowerState"], ["powerState"]), cap("DNA.ChannelControl", ["AdjustChannel", "ChangeChannel"], ["channelSteps", "channelNumber"]), cap("DNA.VolumeControl", ["AdjustVolume", "SetMute"], ["volumeSteps", "mute"]), cap("DNA.PlaybackController", ["Play", "Pause", "Next", "Previous"])] };

test("reported TV capabilities become bounded explicit commands and native controls", () => {
  const profile = magicProfile(endpoint);
  assert.equal(profile.commands.length, 12);
  assert(capabilityIds(profile).includes("onoff"));
  assert(capabilityIds(profile).includes("volume_up"));
  assert(!capabilityIds(profile).includes("speaker_stop"));
  assert.deepEqual(profile.commands.find(c => c.name === "Volume down").payload, { volumeSteps: -1 });
  assert.deepEqual(profile.commands.find(c => c.name === "Power off").payload, { powerState: "OFF" });
  assert.equal(magicProfile({ ...endpoint, cookie: "opaque" }).supported, false);
  assert.deepEqual(magicProfile({ ...endpoint, capabilities: [cap("DNA.PowerControl", ["ChangePowerState"])] }).commands, []);
});

test("every TV control resolves to a documented system capability or a registered stateless app button", () => {
  const system = new Set(require('./fixtures/homey-rmmax-capabilities.json').systemCapabilities);
  const profile = magicProfile({ ...endpoint, capabilities: [...endpoint.capabilities, cap('DNA.PlaybackController', ['Stop'])] });
  for (const id of capabilityIds(profile)) {
    if (system.has(id.split('.')[0])) continue;
    const definition = JSON.parse(fs.readFileSync(path.join(__dirname, '../.homeycompose/capabilities', id + '.json'), 'utf8'));
    assert(fs.existsSync(path.join(__dirname, '..', definition.icon)));
    if (id !== 'rmmax_status') {
      assert.equal(definition.type, 'boolean'); assert.equal(definition.uiComponent, 'button');
      assert.equal(definition.setable, true); assert.equal(definition.getable, false);
    }
  }
  assert.equal(capabilityIds(profile).some(id => /^button\.(volume_|channel_|play|pause|stop)/.test(id)), false);
});

test("RF power-only exposure is not expanded into ten invented buttons", () => {
  const profile = magicProfile({ ...endpoint, capabilities: [endpoint.capabilities[0]] });
  assert.deepEqual(profile.commands.map(c => c.name), ["Power on", "Power off"]);
});

test("ten advertised custom buttons keep stable IDs on reorder and refresh", () => {
  const names = Array.from({ length: 10 }, (_, i) => `RF ${i}`);
  const first = magicProfile({ ...endpoint, capabilities: [cap("DNA.CustomizedRemoteControl", names)] });
  assert.equal(first.commands.length, 10);
  assert.deepEqual(first.commands[0].payload, {});
  const next = magicProfile({ ...endpoint, capabilities: [cap("DNA.CustomizedRemoteControl", [...names].reverse())] });
  assert.deepEqual(next.commands.map(c => c.id), first.commands.map(c => c.id).reverse());
  assert.equal(magicProfile({ ...endpoint, capabilities: [cap("DNA.CustomizedRemoteControl", ["same", "same", "\ninvalid"])] }).commands.length, 0);
});

test("parameterized requests validate bounds and require advertised interface and property", () => {
  assert.deepEqual(parameterCommand(endpoint, "channel", 12).payload, { channelNumber: "12" });
  assert.throws(() => parameterCommand(endpoint, "channel", 12.5));
  assert.throws(() => parameterCommand(endpoint, "volume", 30), /does not advertise/);
  assert.throws(() => parameterCommand(endpoint, "channel", 10000));
});

test("sensor capabilities require exact namespaces and values are validated without inventing readings", () => {
  const profile = magicProfile({ ...endpoint, capabilities: [cap("DNA.TemperatureSensor", [], ["temperature"]), cap("DNA.HumiditySensor", [], ["humidity"])] });
  assert.deepEqual(profile.sensors.map(s => s.capability), ["measure_temperature", "measure_humidity"]);
  const response = (namespace, name, value) => ({ context: { properties: [{ namespace, name, value }] } });
  assert.equal(sensorValue(profile.sensors[0], response("DNA.TemperatureSensor", "temperature", { value: 68, scale: "FAHRENHEIT" })), 20);
  assert.equal(sensorValue(profile.sensors[0], response("DNA.TemperatureSensor", "temperature", { value: 300, scale: "KELVIN" })), null);
  assert.equal(sensorValue(profile.sensors[1], response("DNA.HumiditySensor", "humidity", { value: 105 })), null);
  assert.equal(sensorValue(profile.sensors[0], {}), null);
});
