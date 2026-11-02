"use strict";

const Homey = require("homey");
const { extractCredentials, isRMMaxEndpoint } = require("../../lib/BroadlinkCloud");
const { clientFor, credentialFingerprint, deviceId, collectCommands, safeError, clone } = require("../../lib/RMMaxCommands");
const local = require("../../lib/RMMaxLocal");

class RMMaxDevice extends Homey.Device {
  async onInit() {
    this._generation = (this._generation || 0) + 1;
    this._stopped = false;
    this._busy = false;
    this.registerCapabilityListener("button.refresh", () => this.refreshCommands());
    this.registerCapabilityListener("button.local_test", () => this.probeLocal());
    try {
      const token = this.getStoreValue("bootstrapToken");
      if (token) {
        const bundle = this.driver.takePairingBundle(token, this.getData().id);
        await this.setStoreValue("rmmax_cloud", bundle);
        await this.unsetStoreValue("bootstrapToken");
      }
      this._config = this.getStoreValue("rmmax_cloud");
      this._validateConfig(this._config);
      await this._status("Saved commands ready");
      await this.setAvailable();
      this.log(`RM Max initialized: ${this._config.commands.length} saved commands; transport=${this.getSetting("transport") || "cloud"}`);
    } catch (_) {
      await this.setUnavailable("Authorization is missing or invalid. Use Repair to sign in again.");
      this.log("RM Max initialization requires authorization through Repair");
    }
  }

  _validateConfig(config) {
    if (!config || !config.session || config.session.provider !== "broadlink_eu" || !isRMMaxEndpoint(config.hub) ||
        deviceId(config.session, config.hub) !== this.getData().id || !Array.isArray(config.commands) || config.commands.length > 500) {
      throw new Error("Invalid RM Max configuration");
    }
    clientFor(config.session);
    if (new Set(config.commands.map(command => command.id)).size !== config.commands.length || config.commands.some(command =>
      !command || typeof command.id !== "string" || !/^[a-f\d]{64}$/.test(command.id) || typeof command.name !== "string" ||
      typeof command.code !== "string" || command.code.length > 131072 || !/^(?:[a-f\d]{2})+$/i.test(command.code))) throw new Error("Invalid saved commands");
  }

  async _status(message) { await this.setCapabilityValue("rmmax_status", message); }
  _assertActive(generation) { if (this._stopped || this._generation !== generation) throw new Error("Device operation was cancelled."); }

  async _exclusive(action) {
    if (this._stopped) throw new Error("Device is unavailable.");
    if (this._busy) throw new Error("Another RM Max operation is still running.");
    this._busy = true;
    const generation = this._generation;
    try { return await action(generation); }
    finally { if (generation === this._generation) this._busy = false; }
  }

  onAutoComplete(query = "") {
    const search = String(query).toLowerCase();
    return (this._config && this._config.commands || []).filter(command => command.name.toLowerCase().includes(search))
      .map(({ id, name }) => ({ id, name }));
  }

  async replaceCloudConfiguration(bundle) {
    return this._exclusive(async generation => {
      this._validateConfig(bundle);
      await this.setStoreValue("rmmax_cloud", clone(bundle));
      this._assertActive(generation);
      this._config = clone(bundle);
      if (this.getStoreValue("bootstrapToken")) await this.unsetStoreValue("bootstrapToken");
      await this.setAvailable();
      await this._status("Authorization renewed; saved commands ready");
      this.log(`RM Max authorization renewed: ${bundle.commands.length} saved commands`);
    });
  }

  async refreshCommands() {
    return this._exclusive(async generation => {
      this._validateConfig(this._config);
      try {
        const client = clientFor(this._config.session);
        const endpoints = await client.listDevices();
        if (new Set(endpoints.map(endpoint => endpoint.endpointId)).size !== endpoints.length) throw new Error("Ambiguous device identifiers");
        const matches = endpoints.filter(endpoint => endpoint.endpointId === this._config.hub.endpointId && isRMMaxEndpoint(endpoint));
        if (matches.length !== 1) throw new Error("RM Max missing from this account");
        const hub = matches[0];
        if (String(hub.mac).replace(/[:-]/g, "").toLowerCase() !== String(this._config.hub.mac).replace(/[:-]/g, "").toLowerCase()) throw new Error("RM Max identity changed");
        const result = await collectCommands(client, endpoints, hub);
        this._assertActive(generation);
        const verification = this._config.localVerification;
        const config = { session: client.getSession(), hub, commands: result.commands,
          localVerification: verification && verification.fingerprint === credentialFingerprint(hub) ? verification : null };
        this._validateConfig(config);
        await this.setStoreValue("rmmax_cloud", config);
        this._assertActive(generation);
        this._config = config;
        await this._status(`${result.commands.length} saved commands; ${result.skipped} unsupported entries skipped`).catch(() => this.log("RM Max status update failed after command refresh"));
        await this.setAvailable().catch(() => this.log("RM Max availability update failed after command refresh"));
        this.log(`RM Max command refresh completed: imported=${result.commands.length}, skipped=${result.skipped}`);
        return true;
      } catch (error) {
        this._assertActive(generation);
        const message = safeError(error);
        this.log(`RM Max command refresh failed; existing commands retained. ${message}`);
        await this._status(message);
        throw new Error(message);
      }
    });
  }

  _localInput(ipAddress) {
    const credentials = extractCredentials(this._config.hub);
    if (!credentials) throw new Error("The account did not expose usable local credentials.");
    if (!local.isPrivateIPv4(ipAddress)) throw new Error("Set the RM Max's private IPv4 address in device settings.");
    return { ipAddress, credentials, homey: this.homey };
  }

  _localVerified(ipAddress) {
    const verification = this._config && this._config.localVerification;
    return !!verification && verification.ipAddress === ipAddress && verification.fingerprint === credentialFingerprint(this._config.hub);
  }

  async probeLocal() {
    return this._exclusive(async generation => {
      this._validateConfig(this._config);
      const ipAddress = this.getSetting("ipAddress");
      const input = this._localInput(ipAddress);
      // Clear an earlier success before this attempt, including when this attempt fails.
      const config = { ...this._config, localVerification: null };
      await this.setStoreValue("rmmax_cloud", config);
      this._assertActive(generation); this._config = config;
      this.log("RM Max local credential query started (one attempt; no unlock)");
      try {
        const result = await local.probe(input);
        this._assertActive(generation);
        const verified = { ...config, localVerification: { ipAddress, fingerprint: credentialFingerprint(config.hub) } };
        await this.setStoreValue("rmmax_cloud", verified);
        this._assertActive(generation); this._config = verified;
        await this._status(`Local credentials accepted; firmware ${result.firmware}`);
        this.log(`RM Max local credential query confirmed; firmware=${result.firmware}. Lock state was not changed.`);
        return true;
      } catch (error) {
        this._assertActive(generation);
        const message = safeError(error);
        this.log(`RM Max local credential query failed. ${message}`);
        await this._status(message);
        throw new Error(message);
      }
    });
  }

  async executeCommand(args) {
    return this._exclusive(async generation => {
      this._validateConfig(this._config);
      const command = this._config.commands.find(item => args.variable && item.id === args.variable.id);
      if (!command) throw new Error("Saved command no longer exists. Refresh commands and select it again in the Flow.");
      const transport = this.getSetting("transport") || "cloud";
      try {
        if (transport === "local") {
          const ipAddress = this.getSetting("ipAddress");
          if (!this._localVerified(ipAddress)) throw new Error("Local credentials must be tested successfully before use.");
          await local.sendCode(this._localInput(ipAddress), command.code);
        } else if (transport === "cloud") {
          await clientFor(this._config.session).sendCode(this._config.hub, command.code);
        } else throw new Error("Invalid command transport");
      } catch (error) {
        this._assertActive(generation);
        const message = transport === "local" && !this._localVerified(this.getSetting("ipAddress"))
          ? "Run Test local credentials successfully before using local transport." : safeError(error);
        this.log(`RM Max ${transport} command failed; no retry or transport fallback. ${message}`);
        await this._status(message);
        throw new Error(message);
      }
      this._assertActive(generation);
      this.log(`RM Max command acknowledged via ${transport}; appliance state is not measured`);
      // A post-send UI/Flow error must not make an acknowledged physical command look unsent.
      await this._status(`Command acknowledged via ${transport}`).catch(() => this.log("RM Max status update failed after acknowledgment"));
      await this.driver.commandSent.trigger(this, { CommandSent: command.name }, {}).catch(() => this.log("RM Max sent-command Flow trigger failed"));
      return true;
    });
  }

  async onSettings({ newSettings, changedKeys }) {
    return this._exclusive(async generation => {
      if (newSettings.ipAddress && !local.isPrivateIPv4(newSettings.ipAddress)) throw new Error("Enter a private IPv4 address.");
      if (!["cloud", "local"].includes(newSettings.transport)) throw new Error("Choose cloud or local transport.");
      if (newSettings.transport === "local" && !this._localVerified(newSettings.ipAddress)) throw new Error("Save the IP address with cloud transport, run Test local credentials, then select local transport.");
      if (changedKeys.includes("ipAddress") && this._config) {
        const config = { ...this._config, localVerification: null };
        await this.setStoreValue("rmmax_cloud", config);
        this._assertActive(generation); this._config = config;
      }
    });
  }

  onUninit() { this._stopped = true; this._generation = (this._generation || 0) + 1; }
  onDeleted() { this.onUninit(); }
}

module.exports = RMMaxDevice;
