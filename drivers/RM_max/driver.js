"use strict";

const Homey = require("homey");
const crypto = require("crypto");
const { BroadlinkCloud, MagicHomeCloud, extractCredentials, isRMMaxEndpoint } = require("../../lib/BroadlinkCloud");
const { clientFor, credentialFingerprint, deviceId, inventorySummary, magicEndpointDiagnostics, collectCommands, safeError, clone } = require("../../lib/RMMaxCommands");
const local = require("../../lib/RMMaxLocal");
const { magicProfile, capabilityIds } = require("../../lib/RMMaxMagic");

class RMMaxDriver extends Homey.Driver {
  async onInit() {
    this._pending = new Map();
    this.homey.flow.getActionCard("send_command_rm_max")
      .registerRunListener(args => args.device.executeCommand(args))
      .getArgument("variable").registerAutocompleteListener((query, args) => args.device.onAutoComplete(query));
    this.homey.flow.getActionCard("refresh_commands_rm_max").registerRunListener(args => args.device.refreshCommands());
    this.homey.flow.getActionCard("check_connection_rm_max").registerRunListener(args => args.device.refreshCommands());
    this.homey.flow.getActionCard("set_channel_rm_max").registerRunListener(args => args.device.executeParameter("channel", args.channel));
    this.homey.flow.getActionCard("set_volume_rm_max").registerRunListener(args => args.device.executeParameter("volume", args.volume));
    this.commandSent = this.homey.flow.getDeviceTriggerCard("RC_sent_any_rm_max");
  }

  onPair(session) { this._setupSession(session); }
  onRepair(session, device) { this._setupSession(session, device); }

  takePairingBundle(token, id) {
    const entry = this._pending.get(token);
    if (!entry || entry.id !== id || Date.now() >= entry.expires) throw new Error("Pairing expired. Use Repair to authorize this device again.");
    this.homey.clearTimeout(entry.timer);
    this._pending.delete(token);
    return clone(entry.bundle);
  }

  _setupSession(session, repairDevice) {
    let active = true;
    let busy = false;
    let client;
    let homes = [];
    let endpoints = [];
    let preview;
    let lastLogin = 0;
    const expires = Date.now() + 10 * 60 * 1000;
    const assertActive = () => {
      if (!active || Date.now() >= expires) throw new Error("Pairing session expired. Start again.");
    };
    const handle = (event, action) => session.setHandler(event, async (input = {}) => {
      assertActive();
      if (busy) throw new Error("Another request is still running.");
      busy = true;
      try { const result = await action(input); assertActive(); return result; }
      finally { busy = false; }
    });
    const network = async action => {
      try { return await action(); }
      catch (error) { const message = safeError(error); this.log(`RM Max cloud request: ${message}`); throw new Error(message); }
    };
    const hubFor = id => {
      const hub = endpoints.find(endpoint => endpoint.endpointId === id && isRMMaxEndpoint(endpoint));
      if (!hub) throw new Error("Discover and select an identified RM Max first.");
      return hub;
    };
    session.setHandler("disconnect", () => { active = false; client = undefined; endpoints = []; preview = undefined; homes = []; });
    handle("cloud_context", async () => ({ repair: !!repairDevice }));
    handle("cloud_login", async input => {
      if (Date.now() - lastLogin < 5000) throw new Error("Wait a few seconds before signing in again.");
      lastLogin = Date.now();
      client = undefined; endpoints = []; preview = undefined; homes = [];
      let nextClient;
      if (input.provider === "broadlink_eu") {
        const account = await network(() => BroadlinkCloud.login(input.email, input.password));
        nextClient = new BroadlinkCloud(account);
        homes = await network(() => nextClient.listHomes());
      } else if (input.provider === "magic_home") {
        const account = await network(() => MagicHomeCloud.authorize(input.authCode, input.region));
        nextClient = new MagicHomeCloud(account);
      } else throw new Error("Choose BroadLink EU or Magic Home.");
      assertActive(); client = nextClient;
      return { provider: client.getSession().provider, homes };
    });
    handle("cloud_discover", async input => {
      if (!client) throw new Error("Authorize your account first.");
      endpoints = []; preview = undefined;
      const account = client.getSession();
      if (account.provider === "broadlink_eu") {
        if (!homes.some(home => home.id === input.homeId)) throw new Error("Select one of your listed homes.");
        client = clientFor({ ...account, familyId: input.homeId });
      }
      const found = await network(() => client.listDevices());
      assertActive();
      if (new Set(found.map(endpoint => endpoint.endpointId)).size !== found.length) throw new Error("Cloud discovery returned ambiguous device identifiers.");
      endpoints = found;
      const summary = inventorySummary(found);
      this.log(`RM Max ${account.provider} inventory: devices=${summary.devices}, hubs=${summary.hubs}, raw credential sets=${summary.credentialSets}`);
      if (account.provider === "magic_home") {
        for (const detail of magicEndpointDiagnostics(found)) this.log(`RM Max Magic Home endpoint: ${JSON.stringify(detail)}`);
        if (found.length > 20) this.log(`RM Max Magic Home endpoint diagnostics limited to 20 of ${found.length} entries.`);
      }
      return { provider: account.provider, hubs: found.filter(isRMMaxEndpoint).map(hub => ({ id: hub.endpointId,
        name: `${account.provider === "magic_home" ? `#${found.indexOf(hub) + 1} ` : ""}${typeof hub.friendlyName === "string" ? hub.friendlyName.slice(0, 256) : "RM Max"}`, credentialsAvailable: !!extractCredentials(hub) })),
      summary, commandImportSupported: true };
    });
    handle("cloud_preview", async input => {
      const hub = hubFor(input.hubId);
      const result = await network(() => collectCommands(client, endpoints, hub, assertActive));
      assertActive();
      preview = { hubId: hub.endpointId, ...result, localVerification: null };
      const canAdd = result.supported && (result.commands.length > 0 || result.sensors?.length > 0);
      return { commands: result.commands.map(({ id, name }) => ({ id, name })), skipped: result.skipped,
        rawCredentialsAvailable: client.getSession().provider === "broadlink_eu" && !!extractCredentials(hub), canAdd,
        sensors: (result.sensors || []).map(sensor => sensor.capability),
        reason: canAdd ? "" : "No supported commands or sensors were advertised for this entry. Learn or expose commands in the vendor app, then discover again." };
    });
    handle("cloud_probe", async input => {
      if (client?.getSession().provider === "magic_home") throw new Error("Magic Home cloud actions do not provide raw IR/RF codes for local transport.");
      const hub = hubFor(input.hubId);
      if (preview) preview.localVerification = null;
      const credentials = extractCredentials(hub);
      if (!credentials) throw new Error("This account did not expose a usable raw device key and identifier.");
      if (!local.isPrivateIPv4(input.ipAddress)) throw new Error("Enter the RM Max's private IPv4 address.");
      const result = await network(() => local.probe({ ipAddress: input.ipAddress, credentials, homey: this.homey }));
      assertActive();
      if (preview && preview.hubId === hub.endpointId) preview.localVerification = { ipAddress: input.ipAddress, fingerprint: credentialFingerprint(hub) };
      this.log(`RM Max local credential query confirmed; firmware=${result.firmware}. Lock state was not changed.`);
      return result;
    });
    handle("cloud_complete", async input => {
      const hub = hubFor(input.hubId);
      if (!preview || preview.hubId !== hub.endpointId || !preview.supported || (!preview.commands.length && !preview.sensors?.length)) throw new Error("Preview supported commands or sensors before adding the device.");
      const account = client.getSession();
      const id = deviceId(account, hub);
      const bundle = clone({ session: account, hub, commands: preview.commands, localVerification: preview.localVerification });
      if (repairDevice) {
        const old = repairDevice.getStoreValue("rmmax_cloud");
        if (id !== repairDevice.getData().id || (old && (old.session.userId !== account.userId || old.session.familyId !== account.familyId || old.session.region !== account.region ||
            ["did", "moduleid"].some(key => old.hub.cookie?.[key] && old.hub.cookie[key] !== hub.cookie?.[key])))) {
          throw new Error("Repair must use the original account, home and RM Max.");
        }
        await repairDevice.replaceCloudConfiguration(bundle);
        return { repair: true };
      }
      if (this.getDevices().some(device => device.getData().id === id)) throw new Error("This RM Max is already paired. Use Repair on the existing device.");
      if (this._pending.size >= 20) throw new Error("Too many unfinished pairing attempts. Finish an existing attempt or wait ten minutes.");
      const token = crypto.randomBytes(24).toString("hex");
      const timer = this.homey.setTimeout(() => this._pending.delete(token), 10 * 60 * 1000);
      this._pending.set(token, { id, bundle, timer, expires: Date.now() + 10 * 60 * 1000 });
      return { repair: false, device: { name: typeof hub.friendlyName === "string" ? hub.friendlyName.slice(0, 256) : "RM Max",
        data: { id }, ...(account.provider === "magic_home" ? { capabilities: capabilityIds(magicProfile(hub)) } : {}),
        store: { bootstrapToken: token }, settings: { transport: "cloud", ipAddress: preview.localVerification ? preview.localVerification.ipAddress : "" } } };
    });
  }

  onUninit() {
    for (const entry of this._pending.values()) this.homey.clearTimeout(entry.timer);
    this._pending.clear();
  }
}

module.exports = RMMaxDriver;
