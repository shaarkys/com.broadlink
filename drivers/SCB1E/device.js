"use strict";

const BroadlinkDevice = require("../../lib/BroadlinkDevice");
const { getVariant } = require("../../lib/BroadlinkSP4");

const MEASUREMENTS = {
  power: "measure_power",
  totalconsum: "meter_power",
  volt: "measure_voltage",
  current: "measure_current",
};

class SCB1EDevice extends BroadlinkDevice {
  async onInit() {
    if (this._communicate) await this.onDeleted();
    this._deleted = false;
    this._operationQueue = Promise.resolve();
    this._pollPromise = null;
    this._variant = getVariant(this.getData().devtype);
    await super.onInit();
    const settings = this.getSettings();
    this._authenticated = Boolean(settings.key && settings.key.length === 32 && settings.id && settings.id.length === 8);
    this.log(`SCB1E initialized: raw type 0x${Number(this.getData().devtype).toString(16).toUpperCase()}, variant ${this._variant}`);
    this.registerCapabilityListener("onoff", this.onCapabilityOnoff.bind(this));
    this.start_check_interval(settings.CheckInterval || 1);
  }

  // The base onAdded parses the decimal discovery type as hexadecimal. SCB1E
  // authenticates through its serialized first poll using the original raw type.
  onAdded() {
    return this.onCheckInterval();
  }

  _enqueue(operation) {
    const pending = this._operationQueue.then(() => {
      if (this._deleted) throw new Error("SCB1E device has been deleted");
      return operation();
    });
    // A failed request must not block subsequent commands or polls.
    this._operationQueue = pending.catch(() => {});
    return pending;
  }

  async authenticateDevice() {
    this._authenticated = false;
    this._communicate.configure({
      ipAddress: this._communicate.ipAddress,
      mac: this._utils.hexToArr(this.getData().mac),
      deviceType: Number(this.getData().devtype),
      count: Math.floor(Math.random() * 0xffff),
      key: null,
      id: null,
      homey: this.homey,
    });
    this.log(`SCB1E ${this._variant}: authenticating`);
    const authentication = await this._communicate.auth();
    if (this._deleted) return;
    await this.setSettings({ key: this._utils.arrToHex(authentication.key), id: this._utils.arrToHex(authentication.id) });
    this._authenticated = true;
    this.log(`SCB1E ${this._variant}: authenticated`);
  }

  async _ensureAuthenticated() {
    if (!this._authenticated) await this.authenticateDevice();
    if (this._deleted) throw new Error("SCB1E device has been deleted");
  }

  async _readState() {
    await this._ensureAuthenticated();
    this.log(`SCB1E ${this._variant}: polling state`);
    const state = await this._communicate.scb1e_get_state();
    if (this._deleted) return;
    // Log only known state fields, never arbitrary firmware response content.
    const decoded = {};
    for (const field of ["pwr", ...Object.keys(MEASUREMENTS), "overload"]) {
      if (Object.prototype.hasOwnProperty.call(state, field)) decoded[field] = state[field];
    }
    this.log(`SCB1E ${this._variant}: decoded state`, decoded);
    if (state.pwr !== undefined) await this.setCapabilityValue("onoff", Boolean(state.pwr));
    for (const [field, capability] of Object.entries(MEASUREMENTS)) {
      if (this._deleted) return;
      if (Number.isFinite(state[field])) await this.setCapabilityValue(capability, state[field]);
    }
  }

  onCheckInterval() {
    if (this._deleted) return Promise.resolve();
    if (this._pollPromise) {
      this.log(`SCB1E ${this._variant}: polling skipped; state request already pending`);
      return this._pollPromise;
    }
    this._pollPromise = this._enqueue(() => this._readState())
      .catch((err) => {
        if (!this._deleted) this.error(`SCB1E ${this._variant}: state polling failed; keeping last valid values`, err);
      })
      .finally(() => { this._pollPromise = null; });
    return this._pollPromise;
  }

  onCapabilityOnoff(value) {
    return this._enqueue(async () => {
      try {
        await this._ensureAuthenticated();
        this.log(`SCB1E ${this._variant}: setting relay ${value ? "on" : "off"}`);
        const state = await this._communicate.scb1e_set_power(value);
        if (this._deleted) return;
        if (state.pwr !== undefined && Boolean(state.pwr) !== value) {
          throw new Error("SCB1E relay response does not match the requested state");
        }
        await this.setCapabilityValue("onoff", value);
        this.log(`SCB1E ${this._variant}: relay command acknowledged`);
      } catch (err) {
        this.error(`SCB1E ${this._variant}: relay change failed`, err);
        throw err;
      }
      // A successful write remains successful even if the follow-up read fails.
      try {
        await this._readState();
      } catch (err) {
        if (!this._deleted) this.error(`SCB1E ${this._variant}: state refresh after relay change failed; keeping last valid values`, err);
      }
    });
  }

  start_check_interval(interval) {
    if (!Number.isFinite(interval) || interval < 1 || interval > 3600) {
      throw new Error("SCB1E polling interval must be between 1 and 3600 minutes");
    }
    this.stop_check_interval();
    const generation = this._pollGeneration;
    const schedule = (delay) => {
      this.checkTimer = this.homey.setTimeout(async () => {
        this.checkTimer = null;
        await this.onCheckInterval();
        if (!this._deleted && generation === this._pollGeneration) schedule(interval * 60000);
      }, delay);
    };
    schedule(0);
  }

  stop_check_interval() {
    this._pollGeneration = (this._pollGeneration || 0) + 1;
    if (this.checkTimer != null) this.homey.clearTimeout(this.checkTimer);
    this.checkTimer = null;
  }

  async onSettings({ newSettings, changedKeys }) {
    await this._enqueue(async () => {
      if (changedKeys.includes("ipAddress")) this._communicate.setIPaddress(newSettings.ipAddress);
      if (changedKeys.includes("Authenticate") && newSettings.Authenticate) {
        await this.authenticateDevice();
        if (this._deleted) return;
        // Reset after Homey commits the user-submitted settings.
        if (this.settingsTimeout != null) this.homey.clearTimeout(this.settingsTimeout);
        this.settingsTimeout = this.homey.setTimeout(() => {
          this.settingsTimeout = null;
          if (!this._deleted) this.setSettings({ Authenticate: false }).catch((err) => this.error("SCB1E: resetting authentication setting failed", err));
        }, 100);
      }
    });
    if (!this._deleted && changedKeys.includes("CheckInterval")) this.start_check_interval(newSettings.CheckInterval);
  }

  async onDeleted() {
    this._deleted = true;
    this.stop_check_interval();
    if (this.settingsTimeout != null) this.homey.clearTimeout(this.settingsTimeout);
    this.settingsTimeout = null;
    // Let the bounded in-flight UDP request settle before closing its socket.
    await this._operationQueue;
    if (this._communicate) this._communicate.destroy();
    this._communicate = null;
  }
}

module.exports = SCB1EDevice;
