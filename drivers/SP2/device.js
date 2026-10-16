/**
 * Driver for Broadlink devices
 *
 * Copyright 2018-2019, R Wensveen
 *
 * This file is part of com.broadlink
 * com.broadlink is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * com.broadlink is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * You should have received a copy of the GNU General Public License
 * along with com.broadlink.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

const BroadlinkDevice = require("./../../lib/BroadlinkDevice");

class SP2Device extends BroadlinkDevice {
  generate_trigger_nightlight(mode) {
    if (mode != this.getCapabilityValue("onoff.nightlight")) {
      let drv = this.driver;
      drv.trigger_nightlight_toggle.trigger(this, {}, {});
      if (mode) {
        drv.trigger_nightlight_on.trigger(this, {}, {});
      } else {
        drv.trigger_nightlight_off.trigger(this, {}, {});
      }
    }
  }

  generate_trigger_power(mode) {
    if (mode != this.getCapabilityValue("onoff.power")) {
      let drv = this.driver;
      drv.trigger_power_toggle.trigger(this, {}, {});
      if (mode) {
        drv.trigger_power_on.trigger(this, {}, {});
      } else {
        drv.trigger_power_off.trigger(this, {}, {});
      }
    }
  }

  _enqueue(operation) {
    const pending = (this._operationQueue || Promise.resolve()).then(() => {
      if (this._deleted) throw new Error("SP2/SP3S device has been stopped");
      return operation();
    });
    this._operationQueue = pending.catch(() => {});
    return pending;
  }

  _withAuthentication(operation) {
    return this._enqueue(async () => {
      if (!this._authenticated) await this.authenticateDevice();
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this._deleted) throw new Error("SP2/SP3S device has been stopped");
        try {
          return await operation();
        } catch (err) {
          if (err.code !== -7) throw err;
          this._authenticated = false;
          if (attempt === 1) throw err;
          this.log("SP2/SP3S control key expired; authenticating and retrying once");
          await this.authenticateDevice();
        }
      }
    });
  }

  async authenticateDevice() {
    this._authenticated = false;
    const communication = this._communicate;
    communication.configure({
      ipAddress: communication.ipAddress,
      mac: this._utils.hexToArr(this.getData().mac),
      // Discovery stores devtype as a decimal string, not hexadecimal.
      deviceType: Number(this.getData().devtype),
      count: Math.floor(Math.random() * 0xffff),
      key: null,
      id: null,
      homey: this.homey,
    });
    this.log(`SP2/SP3S authenticating type 0x${communication.deviceType.toString(16)}`);
    const authentication = await communication.auth();
    if (this._deleted) throw new Error("SP2/SP3S device has been stopped");
    if (!authentication || !authentication.key || authentication.key.length !== 16 || !authentication.id || authentication.id.length !== 4) {
      throw new Error("Invalid SP2/SP3S authentication session");
    }
    await this.setSettings({
      key: this._utils.arrToHex(authentication.key),
      id: this._utils.arrToHex(authentication.id),
    });
    this._authenticated = true;
    this.log("SP2/SP3S authentication completed and session saved");
  }

  onAdded() {
    return this._withAuthentication(async () => {});
  }

  onCheckInterval() {
    if (this._deleted) return Promise.resolve();
    if (this._pollPromise) {
      this.log("SP2/SP3S polling skipped; a poll is already pending");
      return this._pollPromise;
    }
    this._pollPromise = this._withAuthentication(async () => {
      const response = await this._communicate.read_status();
      if (this._deleted) return;
      const nightlight = response[0] == 2 || response[0] == 3;
      this.generate_trigger_nightlight(nightlight);
      await this.setCapabilityValue("onoff.nightlight", nightlight);
      if (this._deleted) return;
      const power = response[0] == 1 || response[0] == 3;
      this.generate_trigger_power(power);
      await this.setCapabilityValue("onoff.power", power);
      if (this._deleted) return;
      // An unavailable energy reading must not prevent switch-state polling.
      try {
        const energy = await this._readEnergy();
        if (!this._deleted) await this.setCapabilityValue("measure_power", energy);
      } catch (err) {
        if (err.code === -7) throw err;
        this.error("SP2/SP3S energy reading failed; keeping last valid value", err);
      }
    }).catch((err) => {
      if (!this._deleted) this.error("Error in onCheckInterval", err);
    }).finally(() => { this._pollPromise = null; });
    return this._pollPromise;
  }

  get_energy() {
    return this._withAuthentication(() => this._readEnergy());
  }

  async _readEnergy() {
    const response = await this._communicate.sp2_get_energy();
    if (!response || response.length < 5) throw new Error("Invalid energy response from device");
    // Preserve the existing energy conversion for SP2/SP3S.
    const secondHex = response[1].toString(16).padStart(2, "0");
    const thirdHex = response[2].toString(16).padStart(2, "0");
    const fourthHex = response[3].toString(16).padStart(2, "0");
    const fifthHex = response[4].toString(16).padStart(2, "0");
    const energy = parseFloat(`${fifthHex}${fourthHex}${thirdHex}.${secondHex}`);
    if (!Number.isFinite(energy)) throw new Error("Energy is not a valid number");
    return energy;
  }

  /** Returns the night light state of the smart plug. */
  check_nightlight() {
    return this._withAuthentication(async () => {
      const response = await this._communicate.read_status();
      return response[0] == 2 || response[0] == 3;
    });
  }

  async adjust_nightlight(state) {
    const response = await this._communicate.read_status();
    if (this._deleted) throw new Error("SP2/SP3S device has been stopped");
    const power = response[0] == 1 || response[0] == 3;
    await this._communicate.setPowerState((state ? 2 : 0) | (power ? 1 : 0));
    return true;
  }

  /** Returns the power state of the smart plug. */
  check_power() {
    return this._withAuthentication(async () => {
      const response = await this._communicate.read_status();
      return response[0] == 1 || response[0] == 3;
    });
  }

  /** Sets the power state of the smart plug, preserving its night light. */
  async adjust_power(state) {
    const response = await this._communicate.read_status();
    if (this._deleted) throw new Error("SP2/SP3S device has been stopped");
    const nightlight = response[0] == 2 || response[0] == 3;
    await this._communicate.setPowerState((nightlight ? 2 : 0) | (state ? 1 : 0));
    return true;
  }

  set_power(mode) {
    return this._withAuthentication(async () => {
      await this.adjust_power(mode);
      if (this._deleted) return;
      this.generate_trigger_power(mode);
      await this.setCapabilityValue("onoff.power", mode);
    });
  }

  set_nightlight(mode) {
    return this._withAuthentication(async () => {
      await this.adjust_nightlight(mode);
      if (this._deleted) return;
      this.generate_trigger_nightlight(mode);
      await this.setCapabilityValue("onoff.nightlight", mode);
    });
  }

  check_condition_power_on() {
    return this.check_power();
  }

  check_condition_nightlight_on() {
    return this.check_nightlight();
  }

  async do_action_power_on() {
    await this.set_power(true);
    this.onCheckInterval();
    return true;
  }

  async do_action_power_off() {
    await this.set_power(false);
    this.onCheckInterval();
    return true;
  }

  async do_action_nightlight_on() {
    await this.set_nightlight(true);
    return true;
  }

  async do_action_nightlight_off() {
    await this.set_nightlight(false);
    return true;
  }

  onCapabilityPowerOnOff(mode) {
    return this.set_power(mode);
  }

  onCapabilityNightLightOnOff(mode) {
    return this.set_nightlight(mode);
  }

  async onInit() {
    if (this._communicate) await this.onUninit();
    this._deleted = false;
    this._operationQueue = Promise.resolve();
    this._pollPromise = null;
    await super.onInit();
    if (this._deleted) return;
    const settings = this.getSettings();
    this._authenticated = /^[0-9a-f]{32}$/i.test(settings.key || "") && /^[0-9a-f]{8}$/i.test(settings.id || "");
    this.registerCapabilityListener("onoff.power", this.onCapabilityPowerOnOff.bind(this));
    this.registerCapabilityListener("onoff.nightlight", this.onCapabilityNightLightOnOff.bind(this));
    const interval = Number.isFinite(settings.CheckInterval) && settings.CheckInterval >= 1 && settings.CheckInterval <= 3600 ? settings.CheckInterval : 5;
    if (interval !== settings.CheckInterval) await this.setSettings({ CheckInterval: interval });
    if (this._deleted) return;
    this.start_check_interval(interval);
  }

  start_check_interval(interval) {
    if (!Number.isFinite(interval) || interval < 1 || interval > 3600) throw new Error("Polling interval must be between 1 and 3600 minutes");
    const replacing = this.checkTimer != null || Boolean(this._pollPromise);
    this.stop_check_interval();
    this.log(`SP2/SP3S polling ${replacing ? "replaced" : "started"}: ${interval} minutes`);
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
    if (this.checkTimer != null || this._pollPromise) this.log("SP2/SP3S polling cancelled");
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
        // Homey commits the submitted settings after this handler resolves.
        if (this.settingsTimeout != null) this.homey.clearTimeout(this.settingsTimeout);
        this.settingsTimeout = this.homey.setTimeout(() => {
          this.settingsTimeout = null;
          if (!this._deleted) this.setSettings({ Authenticate: false }).catch((err) => this.error("Resetting authentication setting failed", err));
        }, 100);
      }
    });
    if (!this._deleted && changedKeys.includes("CheckInterval")) this.start_check_interval(newSettings.CheckInterval);
  }

  async onUninit() {
    this._deleted = true;
    this.stopLockChecks();
    this.stop_check_interval();
    if (this.settingsTimeout != null) this.homey.clearTimeout(this.settingsTimeout);
    this.settingsTimeout = null;
    // Finish the bounded active request before destroying its transport.
    await this._operationQueue;
    if (this._communicate) this._communicate.destroy();
    this._communicate = null;
  }

  onDeleted() {
    return this.onUninit();
  }
}

module.exports = SP2Device;
