"use strict";

const CloudDevice = require("./BroadlinkCloudDevice");
const { extractCredentials } = require("./BroadlinkCloud");
const { clientFor, clone } = require("./RMMaxCommands");
const { identifyHub, validateCode } = require("./RMCloudModels");
const { MODELS, CAPABILITIES, deviceId, collectRemoteCommands, preferences, capabilityIds, buttonCapability, preview, record, text, commandId } = require("./RMCloudCommands");

class RMCloudDevice extends CloudDevice {
  get cloudLabel() { return `${MODELS[this.driver.cloudModel].name} cloud`; }
  get cloudStoreKey() { return "rm_cloud"; }
  _matchesCloudHub(endpoint) { return identifyHub(endpoint)?.model === this.driver.cloudModel; }
  _validateCloudContent() { /* An authoritative empty collection must invalidate cached codes. */ }

  _validateConfig(config) {
    if (!record(config) || config.model !== this.driver.cloudModel || !this._matchesCloudHub(config.hub) ||
        !extractCredentials(config.hub) || config.session?.provider !== "broadlink_eu" || !text(config.session.familyId) ||
        !record(config.remote) || !text(config.remote.endpointId) || config.remote.gatewayId !== config.hub.endpointId ||
        config.remote.endpointId === config.hub.endpointId || deviceId(config.session, config.hub, config.remote) !== this.getData().id ||
        !Array.isArray(config.commands) || config.commands.length > 500) throw new Error("Invalid cloud remote configuration. Use Repair.");
    clientFor(config.session);
    if (new Set(config.commands.map(c => c?.id)).size !== config.commands.length || new Set(config.commands.map(c => c?.name)).size !== config.commands.length ||
        config.commands.some(c => !record(c) || !commandId(c.id) || !text(c.name) || c.remoteId !== config.remote.endpointId ||
          (c.function !== undefined && !text(c.function)) || !validateCode(config.model, c.code)) ||
        Buffer.byteLength(JSON.stringify(config.commands)) > 2 * 1024 * 1024) throw new Error("Invalid saved cloud commands");
    preferences(config.commands, config, config);
    if (config.buttonLabels && (!record(config.buttonLabels) || Object.entries(config.buttonLabels).some(([id, label]) =>
      !config.buttons.includes(id) || !text(label)))) throw new Error("Invalid named button metadata");
  }

  async _syncCapabilities() {
    const generation = this._generation;
    this._assertActive(generation);
    const desired = capabilityIds(this._config);
    for (const id of desired) if (!this.hasCapability(id)) {
      this.log(`${this.cloudLabel} adding capability: ${id.split(".")[0]}`);
      await this.addCapability(id); this._assertActive(generation);
    }
    const managed = new Set(["onoff", ...Object.values(CAPABILITIES)]);
    for (const id of this.getCapabilities()) if ((managed.has(id) || id.startsWith("rmcloud_button.")) && !desired.includes(id)) {
      await this.removeCapability(id); this._assertActive(generation); this._capListeners.delete(id);
      this.log(`${this.cloudLabel} removed an explicitly unmapped control`);
    }
    this._listen("button.check_connection", () => this.refreshCommands());
    if (this.hasCapability("onoff")) this._listen("onoff", value => {
      if (typeof value !== "boolean") throw new Error("Choose power on or off.");
      return this.executeMapped(value ? "power_on" : "power_off");
    });
    for (const [role, id] of Object.entries(CAPABILITIES)) if (this.hasCapability(id)) this._listen(id, () => this.executeMapped(role));
    for (const command of this._config.buttons) {
      const id = buttonCapability(command);
      const current = this._config.commands.find(c => c.id === command);
      const label = current?.name || this._config.buttonLabels?.[command] || "Command";
      const title = current ? { en: label.slice(0, 64), nl: label.slice(0, 64) } :
        { en: `${label.slice(0, 49)} (unavailable)`, nl: `${label.slice(0, 45)} (niet beschikbaar)` };
      const options = this.getCapabilityOptions(id) || {};
      if (JSON.stringify(options.title) !== JSON.stringify(title)) {
        await this.setCapabilityOptions(id, { ...options, title }); this._assertActive(generation);
      }
      this._listen(id, () => this.executeCommand({ variable: { id: command } }));
    }
  }

  _collectCloudCommands(client, endpoints, hub, assertActive) {
    return collectRemoteCommands(client, endpoints, hub, this._config.remote.endpointId, assertActive);
  }

  _refreshedCloudConfiguration(session, hub, result) {
    if (identifyHub(hub).devtype !== identifyHub(this._config.hub).devtype) throw new Error("Cloud hub type changed. Use Repair.");
    const config = { ...this._config, session, hub, remote: result.remote, commands: result.commands, skipped: result.skipped,
      skipReasons: result.skipReasons, buttonLabels: {} };
    for (const id of config.buttons) config.buttonLabels[id] = result.commands.find(c => c.id === id)?.name || this._config.buttonLabels?.[id] || "Unavailable command";
    return config;
  }

  _sendCloudCommand(client, command) { return client.sendRMCode(this._config.hub, command.code); }

  _sendCommand(command, generation) {
    const power = this._config.mappings.power_on === command.id ? "ON" : this._config.mappings.power_off === command.id ? "OFF" : null;
    return super._sendCommand(power ? { ...command, namespace: "DNA.PowerControl", payload: { powerState: power } } : command, generation);
  }

  async executeMapped(role) {
    return this._exclusive(async generation => {
      this._validateConfig(this._config);
      const id = this._config.mappings[role];
      const command = this._config.commands.find(c => c.id === id);
      if (!command) throw new Error("Mapped command is unavailable. Use Repair to review controls.");
      return this._sendCommand(command, generation);
    }, "mapped command");
  }

  controlsPreview() {
    this._validateConfig(this._config);
    return { ...preview(this._config, this._config), canAdd: true, hubId: this._config.hub.endpointId,
      remoteId: this._config.remote.endpointId, remoteName: this._config.remote.friendlyName || "Remote" };
  }

  async updateControls(input, assertSession = () => {}) {
    return this._exclusive(async generation => {
      this._validateConfig(this._config);
      const prefs = preferences(this._config.commands, input, this._config);
      const config = { ...this._config, ...prefs, buttonLabels: {} };
      for (const id of config.buttons) config.buttonLabels[id] = config.commands.find(c => c.id === id)?.name || this._config.buttonLabels?.[id] || "Unavailable command";
      assertSession();
      await this.setStoreValue(this.cloudStoreKey, clone(config));
      this._assertActive(generation); this._config = config;
      await this._syncCapabilities(); this._assertActive(generation);
      await this._status("Control mappings updated");
      this.log(`${this.cloudLabel} control mappings updated`);
      return true;
    }, "control mapping");
  }

  onSettings({ changedKeys }) {
    if (changedKeys.length) throw new Error("Use Repair to change cloud authorization or controls.");
  }
}

module.exports = RMCloudDevice;
