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
