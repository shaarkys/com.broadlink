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
const BroadlinkUtils = require("./../../lib/BroadlinkUtils.js");
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

  async onCheckInterval() {
    try {
      // this._utils.debugLog(this, "onCheckInterval called");
      let energy = await this.get_energy();

      if (isNaN(energy)) {
        throw new Error("Energy is not a valid number");
      }
      
      this._utils.debugLog(this, `Energy reading from interval: ${energy} W.`);
      this.setCapabilityValue("measure_power", energy);

      let response = await this._communicate.read_status();

      let state = response[0] == 2 || response[0] == 3;
      this.generate_trigger_nightlight(state);
      this.setCapabilityValue("onoff.nightlight", state);

      state = response[0] == 1 || response[0] == 3;
      this.generate_trigger_power(state);
      this.setCapabilityValue("onoff.power", state);
    } catch (e) {
      this.error("Error in onCheckInterval", e);
    }
  }

  async get_energy() {
    let _lastValidEnergy; // Local variable for this method

    try {
      let response = await this._communicate.sp2_get_energy();

      // Extract the 2nd, 3rd, 4th, and 5th bytes and convert to hexadecimal strings
      let secondHex = response[1].toString(16).padStart(2, "0");
      let thirdHex = response[2].toString(16).padStart(2, "0");
      let fourthHex = response[3].toString(16).padStart(2, "0");
      let fifthHex = response[4].toString(16).padStart(2, "0");

      // Combine the hex values correctly as strings
      let energyStr = `${fifthHex}${fourthHex}${thirdHex}.${secondHex}`;

      this._utils.debugLog(this, `Combined energy string: ${energyStr}`);

      // Convert the combined string to float
      let energy = parseFloat(energyStr);

      // Ensure the returned energy is a valid number
      if (isNaN(energy)) {
        this.error("Calculated energy is not a valid number:", energy);
        return _lastValidEnergy; // Return the last known valid energy value
      }

      _lastValidEnergy = energy; // Update the last known valid energy value
      return energy;
    } catch (e) {
      this.error("Error in get_energy", e);
      return _lastValidEnergy; // Return the last known valid energy value in case of error
    }
  }

  /**
   * Returns the night light state of the smart plug.
   */
  async check_nightlight() {
    try {
      let response = await this._communicate.read_status();
      return response[0] == 2 || response[0] == 3;
    } catch (e) {
      this.error("Error in check_nightlight", e);
      return false;
    }
  }

  /**
   *
   */
  async adjust_nightlight(state) {
    let onoff = await this.check_power();
    let level = 0;
    if (onoff) {
      level = state ? 3 : 1;
    } else {
      level = state ? 2 : 0;
    }
    await this._communicate.setPowerState(level);
    return true;
  }

  /**
   * Returns the power state of the smart plug.
   */
  async check_power() {
    try {
      let response = await this._communicate.read_status();
      this._utils.debugLog(this, `Power status response: ${response}`);
      return response[0] == 1 || response[0] == 3;
    } catch (e) {
      this.error("Error in check_power", e);
      return false;
    }
  }

  /**
   * Sets the power state of the smart plug.
   */
  async adjust_power(state) {
    this._utils.debugLog(this, `adjust_power called with state: ${state}`);
    let onoff = await this.check_nightlight();
    let level = 0;
    if (onoff) {
      level = state ? 3 : 2;
    } else {
      level = state ? 1 : 0;
    }
    await this._communicate.setPowerState(level);
    return true;
  }

  /**
   *
   */
  async set_power(mode) {
    this.generate_trigger_power(mode);
    try {
      await this.adjust_power(mode);
    } catch (e) {
      this.error("Error in set_power", e);
    }
  }

  /**
   *
   */
  async set_nightlight(mode) {
    this.generate_trigger_nightlight(mode);
    try {
      this.adjust_nightlight(mode);
    } catch (e) {
      this.error("Error in set_nightlight", e);
    }
  }

  check_condition_power_on() {
    return Promise.resolve(this.check_power());
  }

  check_condition_nightlight_on() {
    return Promise.resolve(this.check_nightlight());
  }

  do_action_power_on() {
    this.set_power(true);
    this.setCapabilityValue("onoff.power", true);
    this.get_energy()
      .then(energy => {
        this._utils.debugLog(this, `Energy reading: ${energy}`);
        if (typeof energy === 'number') {
          this.setCapabilityValue("measure_power", energy);
        } else {
          this._utils.debugLog(this, "Invalid energy reading, not updating measure_power");
        }
      })
      .catch(err => {
        this._utils.debugLog(this, "Error fetching energy reading:", err);
      });
    return Promise.resolve(true);
  } 

  do_action_power_off() {
    this.set_power(false);
    this.setCapabilityValue("onoff.power", false);
    this.get_energy()
      .then(energy => {
        this._utils.debugLog(this, `Energy reading: ${energy}`);
        if (typeof energy === 'number') {
          this.setCapabilityValue("measure_power", energy);
        } else {
          this._utils.debugLog(this, "Invalid energy reading, not updating measure_power");
        }
      })
      .catch(err => {
        this._utils.debugLog(this, "Error fetching energy reading:", err);
      });
    return Promise.resolve(true);
  }

  do_action_nightlight_on() {
    this.set_nightlight(true);
    this.setCapabilityValue("onoff.nightlight", true);
    return Promise.resolve(true);
  }

  do_action_nightlight_off() {
    this.set_nightlight(false);
    this.setCapabilityValue("onoff.nightlight", false);
    return Promise.resolve(true);
  }

  onCapabilityPowerOnOff(mode) {
    this.set_power(mode);
    return Promise.resolve();
  }

  onCapabilityNightLightOnOff(mode) {
    this.set_nightlight(mode);
    return Promise.resolve();
  }

  async onInit() {
    await super.onInit();

    this._utils.debugLog(this, "SP2/SP3 Device onInit called");

    this.registerCapabilityListener("onoff.power", this.onCapabilityPowerOnOff.bind(this));
    this.registerCapabilityListener("onoff.nightlight", this.onCapabilityNightLightOnOff.bind(this));

    this._utils.debugLog(this, "Capability listeners registered");

    try {
      // Read the interval value from settings
      const settings = this.getSettings();
      let checkIntervalMinutes;

      if (typeof settings["CheckInterval"] === "number") {
        this._utils.debugLog(this, `Polling interval is set: ${settings["CheckInterval"]} minutes`);
        checkIntervalMinutes = parseInt(settings["CheckInterval"], 10); // Safely parse it to an integer
      } else {
        // Default value set if CheckInterval is not defined or is incorrectly set
        await this.setSettings({ CheckInterval: 5 }); // Use await to ensure settings are applied (5 minutes)
        this._utils.debugLog(this, "Polling interval was undefined, set to default: 5 minutes");
        checkIntervalMinutes = 5; // Set interval to default after ensuring settings are applied
      }

      const checkIntervalMillis = checkIntervalMinutes * 60 * 1000; // Convert minutes to milliseconds

      this._utils.debugLog(this, `Check interval set to ${checkIntervalMinutes} minutes (${checkIntervalMillis} milliseconds)`);

      // Set up interval to check power readings based on the interval from settings
      this.checkInterval = setInterval(this.onCheckInterval.bind(this), checkIntervalMillis);

      // Initial call to get power readings
      this._utils.debugLog(this, "Initial call to onCheckInterval");
      this.onCheckInterval();
    } catch (e) {
      this.error("Error during onInit", e);
    }
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.length > 0) {
      try {
        this._utils.debugLog(this, "Settings changed:", changedKeys);

        changedKeys.forEach((key) => {
          this._utils.debugLog(
            this,
            `Changed setting key: ${key}, Old value: ${oldSettings[key]}, New value: ${newSettings[key]}`
          );

          if (key === "ipAddress" && newSettings.ipAddress) {
            this._utils.debugLog(this, `Updating IP address to ${newSettings.ipAddress}`);
            this._communicate.setIPaddress(newSettings.ipAddress);
          }
          if (key === "CheckInterval" && newSettings.CheckInterval) {
            this._utils.debugLog(this, `Updating CheckInterval to ${newSettings.CheckInterval}`);
            this.stop_check_interval();
            this.start_check_interval(newSettings.CheckInterval);
          }
          if (key === "Authenticate") {
            this._utils.debugLog(this, "Re-authenticating device due to settings change");
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
        });
      } catch (err) {
        this._utils.debugLog(this, "Error handling settings change: ", err);
        throw new Error("Settings could not be updated: " + err.message);
      }
      this.log("Broadlink settings changed:\n", changedKeys);
    } else {
      this.log("No settings were changed");
    }
  }

  onDeleted() {
    this.stopLockChecks();
    this.log("Device deleted: " + this.getData().id);

    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }
  }
}

module.exports = SP2Device;
