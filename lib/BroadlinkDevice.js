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

const Homey = require("homey");
const Communicate = require("./../lib/Communicate.js");
const BroadlinkUtils = require("./../lib/BroadlinkUtils.js");
//const fs = require("fs");

class BroadlinkDevice extends Homey.Device {
  constructor(...props) {
    super(...props);
    this._utils = new BroadlinkUtils(this.homey);
  }

  /**
   * This method is called when the device is loaded, and properties such as name,
   * capabilities and state are available.
   * However, the device may or may not have been added yet.
   */
  async onInit(dev) {
    this.stopLockChecks();
    const lockGeneration = this._lockCheckGeneration;
    let deviceSettings = this.getSettings();
    let deviceData = this.getData();

    let options = {
      ipAddress: deviceSettings.ipAddress,
      mac: this._utils.hexToArr(deviceData.mac),
      count: Math.floor(Math.random() * 0xffff),
      id: this._utils.hexToArr(deviceSettings.id),
      key: this._utils.hexToArr(deviceSettings.key),
      homey: this.homey,
      deviceType: `0x${parseInt(deviceData.devtype, 10).toString(16)}`, // Convert to hexadecimal format
    };

    this._communicate = new Communicate();
    this._communicate.configure(options);

    // Extract and log only the required information
    let logData = {
      ipAddress: options.ipAddress,
      mac: this._utils.arrToHex(options.mac),
      deviceType: `0x${parseInt(deviceData.devtype, 10).toString(16)}`, // Convert to hexadecimal format
      deviceName: this.getName(),
      typeName: deviceData.typeName,
    };

    this._utils.debugLog(this, "onInit - logData:", logData);
    //this._utils.debugLog(this, `_communicate object keys: ${Object.keys(this._communicate)}`);
    await this.initializeDeviceLockCapability(lockGeneration);
    if (lockGeneration === this._lockCheckGeneration) this.startLockChecks();
  }

  async initializeDeviceLockCapability(generation) {
    try {
      // Finish an earlier value write before resetting the state on reinitialization.
      await this._lockStateUpdate;
      if (generation !== this._lockCheckGeneration) return;
      if (!this.hasCapability("device_lock_state")) {
        this.log("Adding device_lock_state capability to existing device");
        await this.addCapability("device_lock_state");
        this.log("Device lock capability migration completed");
      }
      if (generation !== this._lockCheckGeneration) return;
      await this.setCapabilityValue("device_lock_state", "unknown");
      this.log("Broadlink device lock state: unknown (awaiting discovery)");
    } catch (err) {
      this.error("Device lock capability initialization failed", err);
    }
  }

  reportDeviceLockState(state, reason, generation) {
    if (generation !== this._lockCheckGeneration || this._lockChecksStopped) return Promise.resolve();
    const previous = typeof this._broadlinkLocked === "boolean"
      ? (this._broadlinkLocked ? "locked" : "unlocked") : "unknown";
    this.log(`Broadlink device lock state: ${state}${reason ? ` (${reason}); last confirmed state: ${previous}` : ""}`);
    this._lockStateUpdate = (this._lockStateUpdate || Promise.resolve()).then(async () => {
      if (generation !== this._lockCheckGeneration || this._lockChecksStopped) return;
      try {
        if (!this.hasCapability("device_lock_state")) return;
        await this.setCapabilityValue("device_lock_state", state);
      } catch (err) {
        this.error("Device lock capability update failed", err);
      }
    });
    return this._lockStateUpdate;
  }

  startLockChecks() {
    this.stopLockChecks();
    this._lockChecksStopped = false;
    const generation = this._lockCheckGeneration;
    const check = async () => {
      if (generation !== this._lockCheckGeneration || this._lockChecksStopped) return;
      this._lockCheckTimer = null;
      try {
        await this.checkDeviceLock(generation);
      } catch (err) {
        if (generation === this._lockCheckGeneration) {
          await this.reportDeviceLockState("unknown", `check inconclusive: ${err.message || err}`, generation);
        }
      } finally {
        if (generation === this._lockCheckGeneration && !this._lockChecksStopped) {
          this._lockCheckTimer = this.homey.setTimeout(check, 60000);
        }
      }
    };
    this._lockCheckTimer = this.homey.setTimeout(check, 0);
  }

  stopLockChecks() {
    this._lockChecksStopped = true;
    this._lockCheckGeneration = (this._lockCheckGeneration || 0) + 1;
    if (this._lockCheckTimer != null) this.homey.clearTimeout(this._lockCheckTimer);
    this._lockCheckTimer = null;
    if (this._lockProbe) {
      // Settle the isolated discovery promise before destroying its socket/timer.
      if (this._lockProbe.callback?.reject) this._lockProbe.callback.reject(new Error("Device lock check cancelled"));
      this._lockProbe.destroy();
      this._lockProbe = null;
    }
  }

  async checkDeviceLock(generation) {
    const ipAddress = this.getSetting("ipAddress");
    const deviceData = this.getData();
    if (!ipAddress) return this.reportDeviceLockState("unknown", "no IP address configured", generation);
    const probe = new Communicate();
    probe.configure({ homey: this.homey, ipAddress });
    this._lockProbe = probe;
    try {
      // Independent, unauthenticated unicast discovery; never share the command socket.
      const info = await probe.discover(5, "0.0.0.0", ipAddress, 0);
      if (generation !== this._lockCheckGeneration || this._lockChecksStopped) return;
      if (ipAddress !== this.getSetting("ipAddress")) {
        return this.reportDeviceLockState("unknown", "IP address changed during check", generation);
      }
      const actualMac = Buffer.from(info.mac).reverse().toString("hex");
      const expectedMac = String(deviceData.mac).replace(/[:-]/g, "").toLowerCase();
      if (info.ipAddress !== ipAddress || actualMac !== expectedMac || info.devtype !== Number(deviceData.devtype)) {
        throw new Error("Discovery identity does not match the paired device");
      }
      if (typeof info.isLocked !== "boolean") {
        return this.reportDeviceLockState("unknown", "discovery reply has no supported lock flag", generation);
      }
      this._broadlinkLocked = info.isLocked;
      await this.reportDeviceLockState(info.isLocked ? "locked" : "unlocked", null, generation);
      if (generation === this._lockCheckGeneration && !this._lockChecksStopped) await this.renderDeviceWarning();
    } finally {
      probe.destroy();
      if (this._lockProbe === probe) this._lockProbe = null;
    }
  }

  setWarning(message) {
    this._otherDeviceWarning = message;
    return this.renderDeviceWarning();
  }

  unsetWarning() {
    return this.setWarning(null);
  }

  renderDeviceWarning() {
    // Learning messages must not erase the lock warning, or be lost when unlocking.
    this._warningUpdate = (this._warningUpdate || Promise.resolve()).catch(() => {}).then(() => {
      if (this._lockChecksStopped) return;
      const messages = [];
      if (this._broadlinkLocked) messages.push(this.homey.__("errors.device_locked"));
      if (this._otherDeviceWarning) messages.push(this._otherDeviceWarning);
      return super.setWarning(messages.length ? messages.join("\n") : null);
    });
    return this._warningUpdate;
  }

  onUninit() {
    this.stopLockChecks();
  }

  /**
   *
   */
  async authenticateDevice() {
    try {
      const authenticationData = await this._communicate.auth();
      const newSettings = {
        key: this._utils.arrToHex(authenticationData.key),
        id: this._utils.arrToHex(authenticationData.id),
      };

      // Use setTimeout with a delay of 0 to defer the settings update
      this.settingsTimeout = setTimeout(async () => {
        try {
          await this.setSettings(newSettings);
          await this.setSettings({ Authenticate: false });
        } catch (err) {
          this._utils.debugLog(this, "**> setSettings error: " + err);
        }
      }, 100); // Delay of 0 milliseconds to ensure asynchronous execution
    } catch (err) {
      this._utils.debugLog(this, "**> authentication error: " + err);
    }
  }

  /**
   * This method is called when the user adds the device, called just after pairing.
   *
   * Which means, the device has been discovered (it has an ipAddress, MAC). Now we
   * can authenticate it to get is 'key' and 'id'
   */
  onAdded() {


        
    let deviceData = this.getData();
    let options = {
      ipAddress: this.getSettings().ipAddress,
      mac: this._utils.hexToArr(deviceData.mac),
      count: Math.floor(Math.random() * 0xffff),
      id: null,
      key: null,
      homey: this.homey,
      deviceType: parseInt(deviceData.devtype, 16),
    };

    this._communicate.configure(options);

    this.authenticateDevice();
  }

  /**
   * This method will be called when a device has been removed.
   */
  onDeleted() {
    this.stopLockChecks();
    this.stop_check_interval();
    this._utils.debugLog(this, 'Device deleted');
    this._communicate.destroy();
    this._communicate = null;
  }

  /** */
  /**
   * Called when the device settings are changed by the user
   * (so NOT called on programmatically changing settings)
   *
   *  @param changedKeysArr   contains an array of keys that have been changed
   */
  /** async onSettings({ oldSettings, newSettings, changedKeys }) {
		if (changedKeys.length > 0) {

			try {
				this._utils.debugLog(this, 'Settings changed:', changedKeys);
				this._utils.debugLog(this, 'Old settings:', oldSettings);
				this._utils.debugLog(this, 'New settings:', newSettings);

				changedKeys.forEach(key => {
					this._utils.debugLog(this, `Changed setting key: ${key}, Old value: ${oldSettings[key]}, New value: ${newSettings[key]}`);

					if (key === 'ipAddress' && newSettings.ipAddress) {
						this._utils.debugLog(this, `Updating IP address to ${newSettings.ipAddress}`);
						this._communicate.setIPaddress(newSettings.ipAddress);
					}
					if (key === 'CheckInterval' && newSettings.CheckInterval) {
						this._utils.debugLog(this, `Updating CheckInterval to ${newSettings.CheckInterval}`);
						this.stop_check_interval();
						this.start_check_interval(newSettings.CheckInterval);
					}
					if (key === 'Authenticate') {
						this._utils.debugLog(this, 'Re-authenticating device');
						this.authenticateDevice();
					}
				});
			} catch (err) {
				this._utils.debugLog(this, 'Error handling settings change: ', err);
				throw new Error('Settings could not be updated: ' + err.message);
			}
			this.log('Broadlink settings changed:\n', changedKeys);
		}
		else {
			this.log('No settings were changed');

		}
	}
 */

  /**
   * Start a timer to periodically access the device. the parent class must implement onCheckInterval()
   */
  start_check_interval(interval) {
    this.checkTimer = setInterval(
      function () {
        this.onCheckInterval();
      }.bind(this),
      interval * 60000
    ); // [minutes] to [msec]
  }

  /**
   * Stop the periodic timer
   */
  stop_check_interval() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }
}

module.exports = BroadlinkDevice;
