"use strict";

const Homey = require("homey");
const crypto = require("crypto");
const { BroadlinkCloud, extractCredentials } = require("./BroadlinkCloud");
const { clientFor, clone, safeError } = require("./RMMaxCommands");
const { identifyHub } = require("./RMCloudModels");
const { EmailCodeLogin } = require("./EmailCodeLogin");
const { getLoginPreferences, rememberLoginPreferences } = require("./CloudLoginPreferences");
const { MODELS, deviceId, collectRemoteCommands, suggestMappings, preferences, capabilityIds, preview, text } = require("./RMCloudCommands");

class RMCloudDriver extends Homey.Driver {
  async onInit() {
    if (!Object.prototype.hasOwnProperty.call(MODELS, this.cloudModel)) throw new Error("Unknown cloud driver model");
    this._pending = new Map(); this._driverStopped = false;
    const suffix = MODELS[this.cloudModel].driverId.toLowerCase();
    this.homey.flow.getActionCard(`send_command_${suffix}`).registerRunListener(args => args.device.executeCommand(args))
      .getArgument("variable").registerAutocompleteListener((query, args) => args.device.onAutoComplete(query));
    this.homey.flow.getActionCard(`refresh_commands_${suffix}`).registerRunListener(args => args.device.refreshCommands());
    this.homey.flow.getActionCard(`check_connection_${suffix}`).registerRunListener(args => args.device.refreshCommands());
    this.commandSent = this.homey.flow.getDeviceTriggerCard(`RC_sent_any_${suffix}`);
  }

  onPair(session) { this._setupSession(session); }
  onRepair(session, device) { this._setupSession(session, device); }

  takePairingBundle(token, id) {
    const entry = this._pending.get(token);
    if (!entry || entry.id !== id || Date.now() >= entry.expires || this._driverStopped) throw new Error("Pairing expired. Use Repair to authorize again.");
    this.homey.clearTimeout(entry.timer); this._pending.delete(token);
    return clone(entry.bundle);
  }

  _setupSession(session, repairDevice) {
    let active = true, busy = false, client, homes = [], endpoints = [], selected, lastLogin = 0;
    let emailLogin = new EmailCodeLogin();
    let expires = Date.now() + 10 * 60 * 1000;
    const label = MODELS[this.cloudModel].name;
    const pairingId = crypto.randomBytes(4).toString("hex");
    const pairingLog = (event, outcome, started = Date.now(), detail = "") =>
      this.log(`${label} pairing ${pairingId}: ${event} ${outcome}; durationMs=${Math.max(0, Date.now() - started)}${detail ? "; " + detail : ""}`);
    const pairingError = (code, message) => Object.assign(new Error(message), { code });
    const assertActive = () => {
      if (!active || this._driverStopped) throw pairingError("PAIRING_CLOSED", "Pairing session expired or closed. Reopen pairing or Repair.");
      if (Date.now() >= expires) throw pairingError("PAIRING_EXPIRED", "Pairing session expired. Request a new verification code or sign in again.");
    };
    pairingLog(repairDevice ? "repair" : "pair", "opened");
    const handle = (name, action) => session.setHandler(name, async (input = {}) => {
      const started = Date.now(); let ownsRequest = false;
      pairingLog(name, "started");
      try {
        if (!active || this._driverStopped) assertActive();
        if (busy) throw pairingError("PAIRING_BUSY", "Another pairing request is still running. Wait a moment and try again.");
        // A deliberate new authorization request may restart an expired session.
        // Never renew discovery, previews, completion, or an old email-code login.
        const freshAuthorization = name === "cloud_request_code" || (name === "cloud_login" && (input.method === undefined || input.method === "password"));
        if (Date.now() >= expires && freshAuthorization) {
          emailLogin.close(); emailLogin = new EmailCodeLogin();
          client = undefined; homes = []; endpoints = []; selected = undefined;
          expires = Date.now() + 10 * 60 * 1000;
          pairingLog("session", "renewed after expiry");
        }
        assertActive(); busy = true; ownsRequest = true;
        const value = await action(input); assertActive();
        pairingLog(name, "succeeded", started); return value;
      } catch (error) {
        pairingLog(name, "failed", started, safeError(error)); throw error;
      } finally { if (ownsRequest) busy = false; }
    });
    const network = async action => {
      try { return await action(); }
      catch (error) { const message = safeError(error); pairingLog("cloud request", "failed", Date.now(), message); throw new Error(message); }
    };
    const hubFor = id => {
      const hub = endpoints.find(e => e.endpointId === id && identifyHub(e)?.model === this.cloudModel && extractCredentials(e));
      if (!hub) throw new Error("Discover and select a supported hub with usable cloud credentials first.");
      if (hub.isReachable === false) throw new Error("The cloud reports this hub offline. Check it in the BroadLink app.");
      return hub;
    };
    const oldConfig = () => repairDevice?.getStoreValue("rm_cloud");
    const rememberLogin = (email, method, accountId) => {
      try { rememberLoginPreferences(this.homey, email, method, accountId); }
      catch (_) { pairingLog("login preferences", "could not be saved"); }
    };
    const matchingOld = (hub, remote) => {
      const old = oldConfig();
      return old?.hub?.endpointId === hub.endpointId && old?.remote?.endpointId === remote.endpointId ? old : null;
    };
    session.setHandler("disconnect", () => { pairingLog("session", "disconnected"); active = false; emailLogin.close(); client = undefined; homes = []; endpoints = []; selected = undefined; });
    handle("cloud_context", () => {
      let configured = false;
      if (repairDevice) { try { repairDevice.controlsPreview(); configured = true; } catch (_) { /* Full Repair remains available. */ } }
      let login = null;
      try { login = getLoginPreferences(this.homey, oldConfig()?.session); }
      catch (_) { pairingLog("login preferences", "could not be loaded"); }
      return { model: this.cloudModel, modelName: label, repair: !!repairDevice, configured, login };
    });
    handle("cloud_current", () => {
      if (!repairDevice) throw new Error("Select an existing device to change its controls.");
      return repairDevice.controlsPreview();
    });
    handle("cloud_save_controls", async input => {
      if (!repairDevice) throw new Error("Select an existing device to change its controls.");
      await repairDevice.updateControls(input, assertActive); return { repair: true };
    });
    handle("cloud_request_code", async input => {
      client = undefined; homes = []; endpoints = []; selected = undefined;
      if (input.provider !== undefined && input.provider !== "broadlink_eu") throw new Error("Email codes require BroadLink EU.");
      const result = await network(() => emailLogin.request(input.email, email => BroadlinkCloud.requestEmailCode(email)));
      assertActive(); this.log(`${label} email verification code requested`);
      rememberLogin(input.email, "email_code");
      return result;
    });
    handle("cloud_login", async input => {
      if (Date.now() - lastLogin < 5000) throw new Error("Wait a few seconds before signing in again.");
      lastLogin = Date.now(); client = undefined; homes = []; endpoints = []; selected = undefined;
      if (input.method !== undefined && !["password", "email_code"].includes(input.method)) throw new Error("Choose password or email verification code.");
      const account = await network(() => input.method === "email_code"
        ? emailLogin.login(input.email, input.code, (email, code) => BroadlinkCloud.loginWithEmailCode(email, code))
        : BroadlinkCloud.login(input.email, input.password));
      assertActive();
      const next = new BroadlinkCloud(account);
      const found = await network(() => next.listHomes());
      assertActive(); client = next; homes = found;
      rememberLogin(input.email, input.method || "password", account.userId);
      return { homes: found };
    });
    handle("cloud_discover", async input => {
      if (!client || !homes.some(h => h.id === input.homeId)) throw new Error("Sign in and select one of your homes first.");
      endpoints = []; selected = undefined;
      client = clientFor({ ...client.getSession(), familyId: input.homeId });
      const found = await network(() => client.listDevices()); assertActive();
      if (new Set(found.map(e => e.endpointId)).size !== found.length) throw new Error("Cloud discovery returned ambiguous device identifiers.");
      endpoints = found;
      const matches = found.filter(e => identifyHub(e)?.model === this.cloudModel);
      const hubs = matches.filter(e => extractCredentials(e));
      this.log(`${label} cloud inventory: devices=${found.length}, modelMatches=${matches.length}, usableHubs=${hubs.length}`);
      return { hubs: hubs.map(h => ({ id: h.endpointId, name: text(h.friendlyName) ? h.friendlyName : label })),
        summary: { devices: found.length, hubs: hubs.length } };
    });
    handle("cloud_remotes", input => {
      selected = undefined; const hub = hubFor(input.hubId);
      return { remotes: endpoints.filter(e => e.endpointId !== hub.endpointId && e.gatewayId === hub.endpointId)
        .map(e => ({ id: e.endpointId, name: text(e.friendlyName) ? e.friendlyName : "Remote" })) };
    });
    handle("cloud_preview", async input => {
      selected = undefined; const hub = hubFor(input.hubId);
      const result = await network(() => collectRemoteCommands(client, endpoints, hub, input.remoteId, assertActive));
      assertActive();
      let old = matchingOld(hub, result.remote);
      if (old) {
        try { preferences(result.commands, old, old); }
        catch (_) { old = null; /* Full Repair can recover invalid stored preferences. */ }
      }
      const mappings = old ? old.mappings : suggestMappings(result.commands);
      const buttons = old ? old.buttons : [];
      const prefs = preferences(result.commands, { mappings, buttons }, old);
      selected = { hub, ...result, ...prefs, previous: old };
      return preview(result, prefs);
    });
    handle("cloud_complete", async input => {
      const hub = hubFor(input.hubId);
      if (!selected || selected.hub.endpointId !== hub.endpointId || selected.remote.endpointId !== input.remoteId || !selected.commands.length) throw new Error("Preview this remote's commands before adding or repairing it.");
      const account = client.getSession(), remote = selected.remote;
      const id = deviceId(account, hub, remote);
      const old = oldConfig();
      if (repairDevice && (id !== repairDevice.getData().id || (old?.model && old.model !== this.cloudModel) ||
          (identifyHub(old?.hub) && identifyHub(old.hub).devtype !== identifyHub(hub).devtype) ||
          (old?.hub?.mac && String(old.hub.mac).replace(/[:-]/g, "").toLowerCase() !== String(hub.mac).replace(/[:-]/g, "").toLowerCase()))) throw new Error("Repair must use the original account, home, hub and remote.");
      const prefs = preferences(selected.commands, input, selected.previous);
      const buttonLabels = {};
      for (const button of prefs.buttons) buttonLabels[button] = selected.commands.find(c => c.id === button)?.name || old?.buttonLabels?.[button] || "Unavailable command";
      const bundle = clone({ model: this.cloudModel, session: account, hub, remote, commands: selected.commands,
        ...prefs, buttonLabels, skipped: selected.skipped, skipReasons: selected.skipReasons });
      if (repairDevice) { await repairDevice.replaceCloudConfiguration(bundle, assertActive); return { repair: true }; }
      if (this.getDevices().some(d => d.getData().id === id)) throw new Error("This cloud remote is already paired. Use Repair.");
      if (this._pending.size >= 20) throw new Error("Too many unfinished pairing attempts. Finish one or wait ten minutes.");
      const token = crypto.randomBytes(24).toString("hex");
      const timer = this.homey.setTimeout(() => this._pending.delete(token), 10 * 60 * 1000);
      this._pending.set(token, { id, bundle, timer, expires: Date.now() + 10 * 60 * 1000 });
      return { repair: false, device: { name: text(remote.friendlyName) ? remote.friendlyName : label,
        data: { id }, capabilities: capabilityIds(prefs), store: { bootstrapToken: token } } };
    });
  }

  onUninit() {
    this._driverStopped = true;
    for (const entry of this._pending.values()) this.homey.clearTimeout(entry.timer);
    this._pending.clear();
  }
}

module.exports = RMCloudDriver;
