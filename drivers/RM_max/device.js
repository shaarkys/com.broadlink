"use strict";

const Homey = require("homey");
const { extractCredentials, isRMMaxEndpoint } = require("../../lib/BroadlinkCloud");
const { clientFor, credentialFingerprint, deviceId, collectCommands, safeError, clone } = require("../../lib/RMMaxCommands");
const local = require("../../lib/RMMaxLocal");
const { magicProfile, capabilityIds, parameterCommand, sensorValue } = require("../../lib/RMMaxMagic");

const BUTTONS = { "button.volume_up": "Volume up", "button.volume_down": "Volume down", "button.channel_up": "Channel up", "button.channel_down": "Channel down", "button.play": "Play", "button.pause": "Pause", "button.stop": "Stop" };

class RMMaxDevice extends Homey.Device {
  async onInit() {
    this._stopPolling();
    this._generation = (this._generation || 0) + 1;
    this._stopped = true;
    if (this._operation) await this._operation.catch(() => {});
    this._stopped = false;
    this._busy = false;
    this._backgroundCheck = false;
    this._waitingCommand = false;
    this._client = null;
    this._authRequired = false;
    this._failures = 0;
    this._capListeners = new Set(["button.refresh"]);
    this.registerCapabilityListener("button.refresh", () => this.refreshCommands());
    try {
      const token = this.getStoreValue("bootstrapToken");
      if (token) {
        const bundle = this.driver.takePairingBundle(token, this.getData().id);
        await this.setStoreValue("rmmax_cloud", bundle);
        await this.unsetStoreValue("bootstrapToken");
      }
      this._config = this.getStoreValue("rmmax_cloud");
      this._validateConfig(this._config);
      await this._syncCapabilities();
      await this._status("Commands ready; cloud connection check pending");
      await this.setAvailable();
      this.log(`RM Max initialized: ${this._config.commands.length} saved commands; transport=${this.getSetting("transport") || "cloud"}`);
      this._scheduleCloud(1000);
    } catch (_) {
      if (this._stopped) return;
      await this.setUnavailable("Authorization is missing or invalid. Use Repair to sign in again.");
      this.log("RM Max initialization requires authorization through Repair");
    }
  }

  _validateConfig(config) {
    if (!config || !config.session || !["broadlink_eu", "magic_home"].includes(config.session.provider) || !isRMMaxEndpoint(config.hub) ||
        deviceId(config.session, config.hub) !== this.getData().id || !Array.isArray(config.commands) || config.commands.length > 500) {
      throw new Error("Invalid RM Max configuration");
    }
    clientFor(config.session);
    if (new Set(config.commands.map(command => command?.id)).size !== config.commands.length) throw new Error("Duplicate saved command identifiers");
    if (config.session.provider === "magic_home") {
      const profile = magicProfile(config.hub);
      const expected = new Map(profile.commands.map(command => [command.id, command]));
      if ((!profile.commands.length && !profile.sensors.length) || config.commands.length !== profile.commands.length || config.commands.some(command =>
        !command || JSON.stringify(command) !== JSON.stringify(expected.get(command.id)))) throw new Error("Invalid cloud actions");
      return;
    }
    if (new Set(config.commands.map(command => command.id)).size !== config.commands.length || config.commands.some(command =>
      !command || typeof command.id !== "string" || !/^[a-f\d]{64}$/.test(command.id) || typeof command.name !== "string" ||
      typeof command.code !== "string" || command.code.length > 131072 || !/^(?:[a-f\d]{2})+$/i.test(command.code))) throw new Error("Invalid saved commands");
  }

  async _status(message) { await this.setCapabilityValue("rmmax_status", message); }
  _isMagic() { return this._config?.session.provider === "magic_home"; }
  _listen(capability, listener) {
    if (!this._capListeners.has(capability)) {
      this.registerCapabilityListener(capability, listener);
      this._capListeners.add(capability);
    }
  }

  async _syncCapabilities() {
    const generation = this._generation;
    this._assertActive(generation);
    const desired = this._isMagic() ? capabilityIds(magicProfile(this._config.hub)) : ["rmmax_status", "button.refresh", "button.local_test", "button.check_connection"];
    for (const capability of desired) {
      if (!this.hasCapability(capability)) {
        this.log(`RM Max capability migration adding ${capability}`);
        try {
          await this.addCapability(capability);
          this._assertActive(generation);
          this.log(`RM Max capability migration completed: ${capability}`);
        } catch (error) { this.log(`RM Max capability migration failed: ${capability}`); throw error; }
      }
    }
    if (this.hasCapability("button.local_test")) this._listen("button.local_test", () => this.probeLocal());
    this._listen("button.check_connection", () => this.refreshCommands());
    if (this.hasCapability("onoff")) this._listen("onoff", value => {
      const command = this._config.commands.find(c => c.namespace === "DNA.PowerControl" && c.payload.powerState === (value ? "ON" : "OFF"));
      if (!command) throw new Error("This remote no longer advertises power control. Refresh commands.");
      return this.executeCommand({ variable: { id: command.id } });
    });
    for (const [id, title] of Object.entries(BUTTONS)) if (this.hasCapability(id)) {
      const icon = `/drivers/RM_max/assets/${id.includes("volume") ? "volume" : id.includes("channel") ? "channel" : "playback"}.svg`;
      const options = this.getCapabilityOptions(id);
      if (options.title !== title || options.icon !== icon) await this.setCapabilityOptions(id, { title, icon });
      this._assertActive(generation);
      this._listen(id, () => {
        const command = this._config.commands.find(c => c.capability === id);
        if (!command) throw new Error("This action is no longer available. Refresh commands.");
        return this.executeCommand({ variable: { id: command.id } });
      });
    }
  }

  _stopPolling() {
    if (this._pollTimer !== undefined) this.homey.clearTimeout(this._pollTimer);
    this._pollTimer = undefined;
  }
  _scheduleCloud(delay = 300000) {
    this._stopPolling();
    if (this._stopped || this._authRequired) return;
    const generation = this._generation;
    this._pollTimer = this.homey.setTimeout(async () => {
      this._pollTimer = undefined;
      if (this._stopped || generation !== this._generation) return;
      if (this._busy) { this._scheduleCloud(30000); return; }
      this._backgroundCheck = true;
      try { await this.refreshCommands(); } catch (_) { /* Failure and recovery are recorded by refreshCommands. */ }
      finally { if (generation === this._generation) this._backgroundCheck = false; }
    }, delay);
  }

  async _withClient(generation, action) {
    if (!this._client) this._client = clientFor(this._config.session);
    try { return await action(this._client); }
    finally {
      this._assertActive(generation);
      const session = this._client.getSession();
      if (JSON.stringify(session) !== JSON.stringify(this._config.session)) {
        const updated = { ...this._config, session };
        try {
          await this.setStoreValue("rmmax_cloud", updated);
          this._assertActive(generation); this._config = updated;
        } catch (_) {
          this._assertActive(generation);
          this._authRequired = true; this._stopPolling();
          this.log("RM Max refreshed authorization could not be saved; use Repair before restarting");
          await this.setUnavailable("Could not save renewed authorization. Use Repair.").catch(() => {});
        }
      }
    }
  }

  async _connectionFailure(error, generation) {
    this._assertActive(generation);
    this._authRequired = this._authRequired || error?.code === "AUTH_REQUIRED";
    this._failures++;
    const message = this._authRequired ? "Cloud authorization was rejected. Use Repair to authorize again." :
      error?.code === "ENDPOINT_OFFLINE" ? "The cloud reports this device offline. Checking again automatically." :
      error?.code === "ENDPOINT_MISSING" ? "Device or supported actions missing from the cloud. Checking again; use Repair if it persists." :
      `${safeError(error)} Checking again automatically; use Repair if it persists.`;
    this.log(`RM Max connection check failed: ${message}`);
    await this._status(message).catch(() => this.log("RM Max status update failed"));
    this._assertActive(generation);
    if (this.getSetting("transport") !== "local" || !this._localVerified(this.getSetting("ipAddress"))) {
      await this.setUnavailable(message).catch(() => this.log("RM Max unavailable state update failed"));
    }
    this._scheduleCloud(Math.min(900000, 60000 * 2 ** Math.min(this._failures - 1, 4)));
  }
  _assertActive(generation) { if (this._stopped || this._generation !== generation) throw new Error("Device operation was cancelled."); }

  async _exclusive(action) {
    if (this._stopped) throw new Error("Device is unavailable.");
    if (this._busy) {
      if (!this._backgroundCheck || this._waitingCommand) throw new Error("Another RM Max operation is still running.");
      const waitingGeneration = this._generation;
      this._waitingCommand = true;
      try { await this._operation.catch(() => {}); this._assertActive(waitingGeneration); }
      finally { if (waitingGeneration === this._generation) this._waitingCommand = false; }
      if (this._busy) throw new Error("Another RM Max operation is still running.");
    }
    this._busy = true;
    const generation = this._generation;
    const operation = (async () => { this._assertActive(generation); return action(generation); })();
    this._operation = operation;
    try { return await operation; }
    finally {
      if (this._operation === operation) this._operation = null;
      if (generation === this._generation) this._busy = false;
    }
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
      this._client = null; this._authRequired = false; this._failures = 0;
      await this._syncCapabilities();
      if (this.getStoreValue("bootstrapToken")) await this.unsetStoreValue("bootstrapToken");
      await this.setAvailable();
      await this._status("Authorization renewed; saved commands ready");
      this.log(`RM Max authorization renewed: ${bundle.commands.length} saved commands`);
      this._scheduleCloud(1000);
    });
  }

  async refreshCommands() {
    return this._exclusive(async generation => {
      this._validateConfig(this._config);
      try {
        await this._withClient(generation, async client => {
          const endpoints = await client.listDevices();
          this._assertActive(generation);
          if (new Set(endpoints.map(endpoint => endpoint.endpointId)).size !== endpoints.length) throw new Error("Ambiguous device identifiers");
          const matches = endpoints.filter(endpoint => endpoint.endpointId === this._config.hub.endpointId && isRMMaxEndpoint(endpoint));
          if (matches.length !== 1) throw Object.assign(new Error("RM Max missing from this account"), { code: "ENDPOINT_MISSING" });
          const hub = matches[0];
          if (this._isMagic()) {
            if (["did", "moduleid"].some(key => this._config.hub.cookie?.[key] && this._config.hub.cookie[key] !== hub.cookie?.[key])) throw new Error("RM Max identity changed");
          } else if (String(hub.mac).replace(/[:-]/g, "").toLowerCase() !== String(this._config.hub.mac).replace(/[:-]/g, "").toLowerCase()) throw new Error("RM Max identity changed");
          if (hub.isReachable === false) throw Object.assign(new Error("Device offline"), { code: "ENDPOINT_OFFLINE" });
          const result = await collectCommands(client, endpoints, hub, () => this._assertActive(generation));
          if (!result.commands.length && !result.sensors?.length) throw Object.assign(new Error("No supported commands or sensors"), { code: "ENDPOINT_MISSING" });
          this._assertActive(generation);
          const verification = this._config.localVerification;
          const config = { session: client.getSession(), hub, commands: result.commands,
            localVerification: verification && verification.fingerprint === credentialFingerprint(hub) ? verification : null };
          this._validateConfig(config);
          await this.setStoreValue("rmmax_cloud", config);
          this._assertActive(generation);
          this._config = config;
          await this._syncCapabilities();
          this._assertActive(generation);
          for (const sensor of result.sensors || []) {
            const response = await client.control(hub, sensor.namespace, "ReportState", {}, sensor.version);
            this._assertActive(generation);
            const value = sensorValue(sensor, response);
            if (value === null) throw new Error("Invalid sensor state response");
            await this.setCapabilityValue(sensor.capability, value);
            this._assertActive(generation);
          }
          await this._status(`Cloud reachable; ${result.commands.length} commands; ${hub.isReachable === true ? "device reported online" : "device reachability not reported"}`).catch(() => this.log("RM Max status update failed after command refresh"));
          this.log(`RM Max command refresh completed: imported=${result.commands.length}, skipped=${result.skipped}`);
        });
        this._assertActive(generation);
        this._failures = 0;
        if (!this._authRequired) await this.setAvailable();
        this._scheduleCloud();
        return true;
      } catch (error) {
        this._assertActive(generation);
        const message = safeError(error);
        this.log(`RM Max cloud refresh/check failed. ${message}`);
        await this._connectionFailure(error, generation);
        throw new Error(message);
      }
    });
  }

  _localInput(ipAddress) {
    if (this._isMagic()) throw new Error("Magic Home actions are cloud intents, not raw IR/RF codes. Local transport is unavailable for this endpoint.");
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
      return this._sendCommand(command, generation);
    });
  }

  async executeParameter(type, value) {
    return this._exclusive(async generation => {
      this._validateConfig(this._config);
      if (!this._isMagic()) throw new Error("This action requires a Magic Home remote.");
      return this._sendCommand(parameterCommand(this._config.hub, type, value), generation);
    });
  }

  async _sendCommand(command, generation) {
    const transport = this.getSetting("transport") || "cloud";
    try {
      if (transport === "local") {
        if (this._isMagic()) throw new Error("Magic Home cloud actions cannot be sent as local IR/RF codes.");
        const ipAddress = this.getSetting("ipAddress");
        if (!this._localVerified(ipAddress)) throw new Error("Local credentials must be tested successfully before use.");
        await local.sendCode(this._localInput(ipAddress), command.code);
      } else if (transport === "cloud") {
        if (this._authRequired) throw Object.assign(new Error("Use Repair to authorize again."), { code: "AUTH_REQUIRED" });
        await this._withClient(generation, client => this._isMagic()
          ? client.control(this._config.hub, command.namespace, command.action, command.payload, command.version)
          : client.sendCode(this._config.hub, command.code));
      } else throw new Error("Invalid command transport");
    } catch (error) {
      this._assertActive(generation);
      const message = transport === "local" && !this._localVerified(this.getSetting("ipAddress"))
        ? "Run Test local credentials successfully before using local transport." : safeError(error);
      this.log(`RM Max ${transport} command failed; no retry or transport fallback. ${message}`);
      if (transport === "cloud") await this._connectionFailure(error, generation);
      else await this._status(message);
      throw new Error(message);
    }
    this._assertActive(generation);
    this.log(`RM Max command acknowledged via ${transport}; appliance state is not measured`);
    // A post-send UI/Flow error must not make an acknowledged physical command look unsent.
    await this._status(`Command acknowledged via ${transport}`).catch(() => this.log("RM Max status update failed after acknowledgment"));
    this._assertActive(generation);
    if (this.hasCapability("onoff") && command.namespace === "DNA.PowerControl") {
      await this.setCapabilityValue("onoff", command.payload.powerState === "ON").catch(() => this.log("RM Max power value update failed after acknowledgment"));
    }
    this._assertActive(generation);
    await this.driver.commandSent.trigger(this, { CommandSent: command.name }, {}).catch(() => this.log("RM Max sent-command Flow trigger failed"));
    return true;
  }

  async onSettings({ newSettings, changedKeys }) {
    return this._exclusive(async generation => {
      if (newSettings.ipAddress && !local.isPrivateIPv4(newSettings.ipAddress)) throw new Error("Enter a private IPv4 address.");
      if (!["cloud", "local"].includes(newSettings.transport)) throw new Error("Choose cloud or local transport.");
      if (newSettings.transport === "local" && this._isMagic()) throw new Error("Magic Home actions require cloud transport. No usable local codes or key were supplied.");
      if (newSettings.transport === "local" && !this._localVerified(newSettings.ipAddress)) throw new Error("Save the IP address with cloud transport, run Test local credentials, then select local transport.");
      if (changedKeys.includes("ipAddress") && this._config) {
        const config = { ...this._config, localVerification: null };
        await this.setStoreValue("rmmax_cloud", config);
        this._assertActive(generation); this._config = config;
      }
    });
  }

  async onUninit() {
    this._stopPolling(); this._stopped = true; this._generation = (this._generation || 0) + 1;
    if (this._operation) await this._operation.catch(() => {});
  }
  onDeleted() { return this.onUninit(); }
}

module.exports = RMMaxDevice;
