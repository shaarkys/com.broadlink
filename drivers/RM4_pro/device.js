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

const BroadlinkDevice = require("../../lib/BroadlinkDevice");
const DataStore = require("./../../lib/DataStore.js");

class RM4ProDevice extends BroadlinkDevice {
  /**
   * Store the given name at the first available place in settings.
   * i.e. look for an entry 'RcCmd.' (where . is integer >= 0)
   */
  async storeCmdSetting(cmdname) {
    let settings = this.getSettings();

    var idx = 0;
    let settingName = "RcCmd" + idx;
    while (settingName in settings) {
      //this._utils.debugLog(this,  settingName );
      if (settings[settingName].length == 0) {
        //this._utils.debugLog(this, this.getName()+' - storeCmdSettings - setting = '+settingName+', name = ' + cmdname );
        let s = {
          [settingName]: cmdname,
        };
        await this.setSettings(s);
        break;
      }
      idx++;
      settingName = "RcCmd" + idx;
    }
  }

  /**
   * During device initialisation, make sure the commands
   * in the datastore are identical to the device settings.
   */
  async fillRcCmdPage(offset, settingsSnapshot) {
    try {
      const settings = settingsSnapshot || this.getSettings();
      const backup = JSON.stringify(
        this.dataStore.dataArray.map((item) => ({
          name: item.name,
          cmd: Array.from(item.cmd),
        }))
      );
      let pageLabel = "Active: 1-30";
      if (offset >= 60) pageLabel = "Active: 61-90";
      else if (offset >= 30) pageLabel = "Active: 31-60";

      const updates = { RcCmdPage: String(offset), RcCmdOffset: offset, RcCmdBackup: backup, RcCmdRestore: "", RcCmdPageInfo: pageLabel };
      const names = this.dataStore.getCommandNameList();
      let idx = 0;
      let settingName = "RcCmd" + idx;
      while (settingName in settings) {
        updates[settingName] = names[offset + idx] || "";
        idx++;
        settingName = "RcCmd" + idx;
      }
      await this.setSettings(updates);
      this._utils.debugLog(null, `**> RcCmd page applied (offset=${offset})`);
    } catch (err) {
      this._utils.debugLog(null, "**> Error updating RcCmd page:", err);
    }
  }

  async updateSettings() {
    const settings = this.getSettings();
    const offset = parseInt(settings.RcCmdPage || settings.RcCmdOffset || 0, 10) || 0;
    await this.fillRcCmdPage(offset, settings);
  }

  getCurrentOffset() {
    const settings = this.getSettings();
    return parseInt(settings.RcCmdPage || settings.RcCmdOffset || 0, 10) || 0;
  }

  /**
   * Sends the given command to the device and triggers the flows
   *
   * @param  args['variable'] = command with name
   */
  async executeCommand(args) {
    const generation = this._localGeneration;
    const communication = this._communicate;
    try {
      this._assertLocalOperation(generation, communication);
      let cmd = args["variable"];

      this._utils.debugLog(this, "executeCommand " + cmd.name);

      // send the command
      let cmdData = this.dataStore.getCommandData(cmd.name);
      await this._communicate.send_IR_RF_data_rm4pro(cmdData);
      this._assertLocalOperation(generation, communication);
      cmdData = null;

      let drv = this.driver;
      // RC_specific_sent: user entered command name
      await Promise.resolve().then(() => { this._assertLocalOperation(generation, communication); return drv.rm4_pro_specific_cmd_trigger.trigger(this, {}, { variable: cmd.name }); }).catch(error => this.error("Command sent Flow failed", error));

      // RC_sent_any: set token
      await Promise.resolve().then(() => { this._assertLocalOperation(generation, communication); return drv.rm4_pro_any_cmd_trigger.trigger(this, { CommandSent: cmd.name }, {}); }).catch(error => this.error("Command sent Flow failed", error));
    } catch (e) {
      this._utils.debugLog(this, `Error during command execution: ${e}`);
      throw e;
    }

    return Promise.resolve(true);
  }

  /**
   * Get a list of all command-names
   *
   * @return  the command-name list
   */
  onAutoComplete() {
    let lst = [];
    let names = this.dataStore.getCommandNameList();
    for (var i = names.length - 1; i >= 0; i--) {
      let item = {
        name: names[i],
      };
      lst.push(item);
    }
    return lst;
  }

  /**
   *
   */
  check_condition_specific_cmd_sent(args, state) {
    return Promise.resolve(args.variable.name === state.variable);
  }

  async onInit() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.pollInterval = null;
    if (await super.onInit() === false || this._localStopped) return false;
    const generation = this._localGeneration;
    const communication = this._communicate;
    const isActive = () => !this._localStopped && generation === this._localGeneration && communication === this._communicate;
    this._utils.debugLog(this, "RM4 Pro Device onInit called");
    if (this.homey?.app && typeof this.homey.app.registerRfDevice === "function") {
      this.homey.app.registerRfDevice(this);
    }
    // Ensure the learnIRcmd capability exists and set its initial value
    if (!this.hasCapability("learnRFcmd")) {
      await this.addCapability("learnRFcmd");
      if (!isActive()) return false;
    }

    // Ensure the learnIRcmd capability exists and set its initial value
    if (!this.hasCapability("learnIRcmd")) {
      await this.addCapability("learnIRcmd");
      if (!isActive()) return false;
    }
    this.setCapabilityValue("learnIRcmd", false).catch(this.error);

    // Ensure the learningState capability exists and set its initial value
    if (!this.hasCapability("learningState")) {
      await this.addCapability("learningState");
      if (!isActive()) return false;
    }

    // Ensure the learningStateRF capability exists and set its initial value
    if (!this.hasCapability("learningStateRF")) {
      await this.addCapability("learningStateRF");
      if (!isActive()) return false;
    }

    // Ensure the humidity_rm4 capability exists and set its initial value
    if (!this.hasCapability("measure_humidity_rm4")) {
      await this.addCapability("measure_humidity_rm4");
      if (!isActive()) return false;
    }

    // Ensure the temperature_rm4 capability exists and set its initial value
    if (!this.hasCapability("measure_temperature_rm4")) {
      await this.addCapability("measure_temperature_rm4");
      if (!isActive()) return false;
    }

    await this.migrateClimateCapabilities();
    if (!isActive()) return false;

    // reset the state just in case of new init while app starting

    await this.setCapabilityValue("learnIRcmd", false).catch(this.error);
    if (!isActive()) return false;
    await this.setCapabilityValue("learningState", false).catch(this.error);
    if (!isActive()) return false;
    await this.setCapabilityValue("learnRFcmd", false).catch(this.error);
    if (!isActive()) return false;
    await this.setCapabilityValue("learningStateRF", false).catch(this.error);
    if (!isActive()) return false;

    this.registerCapabilityListener("learnIRcmd", this.onCapabilityLearnIR.bind(this));
    this.registerCapabilityListener("learnRFcmd", this.onCapabilityLearnRF.bind(this));

    try {
      this.dataStore = new DataStore(this.getData().mac, this.homey);
      await this.dataStore.readCommands();
      if (!isActive()) return false;

      await this.updateSettings();
      if (!isActive()) return false;

    } catch (err) {
      if (!isActive()) return false;
      if (err instanceof SyntaxError && err.message.includes("Unexpected token")) {
        this._utils.debugLog(this, `Device.onInit Error: ${err.message}`);
        await this.dataStore.deleteAllCommands();
        if (!isActive()) return false;
        this._utils.debugLog(this, "Corrupted JSON detected and deleted.");

        await this.updateSettings(); // Refresh after removing invalid stored commands
        if (!isActive()) return false;
      } else {
        this._utils.debugLog(this, `Device.onInit Error: ${err.message}`);
        throw err; // Re-throw if it's not the specific error we're handling
      }
    }

    this.homey.drivers.getDriver("RM4_pro").ready(() => {
      if (!isActive()) return;
      this._utils.debugLog(this, "RM4ProDevice: onInit: driver ready");
      // if the driver has a CheckInterval, set it. otherwise ignore it.
      let ci = this.getSetting("CheckInterval");
      if (ci) {
        this._utils.debugLog(this, "RM4ProDevice: onInit: start_check_interval");
        this.start_check_interval(ci);
      }
    });

    // Register polling for temperature and humidity

    if (Number(this.getData().devtype) !== 0xaf8b) {
      this.pollInterval = setInterval(this.pollTempHumidity.bind(this), 60000); // Poll every 60 seconds
    }

    if (!this.getSetting("key")) {
      this._utils.debugLog(this, `>> Key not known, launching autentification during OnInit <<`);
      await this.authenticateDevice();
      if (!isActive()) return false;
    }
    await this.pollTempHumidity(); // Initial poll
    if (!isActive()) return false;
  }

  async migrateClimateCapabilities() {
    const climateCapabilities = ["measure_humidity", "measure_temperature"];
    const missingCapabilities = climateCapabilities.filter((capability) => !this.hasCapability(capability));
    const classNeedsMigration = this.getClass() !== "sensor";

    if (missingCapabilities.length === 0 && !classNeedsMigration) {
      return;
    }

    this._utils.debugLog(this, "RM4ProDevice: migrating device to Homey Climate");

    try {
      for (const capability of missingCapabilities) {
        await this.addCapability(capability);
      }

      if (classNeedsMigration) {
        await this.setClass("sensor");
      }

      this._utils.debugLog(this, "RM4ProDevice: Homey Climate migration completed");
    } catch (err) {
      this._utils.debugLog(this, `RM4ProDevice: Homey Climate migration failed: ${err.message}`);
      this.error("RM4ProDevice: Homey Climate migration failed", err);
    }
  }

  /**
   * This method will be called when the learn state needs to be changed.
   * @param onoff
   */
  async onCapabilityLearnIR(onoff) {
    if (this.learnTimeout) clearTimeout(this.learnTimeout);
    if (!onoff) {
      this._stopLocalLearning();
      const session = this._learningSession();
      await this.setCapabilityValue("learnIRcmd", false);
      session.assert();
      await this.setCapabilityValue("learningState", false);
      return true;
    }
    if (this.learn || this._localStopped) return false;
    this._stopLocalLearning();
    const session = this._learningSession();
    this.learnTimeout = setTimeout(() => {
      this.learnTimeout = null;
      this._trackLocalLearning((async () => {
        try {
          session.assert();
          this.learn = true;
          await this.setCapabilityValue("learningState", true);
          session.assert();
          await session.communication.enter_learning_red();
          session.assert();
          const data = await session.communication.check_IR_data_red();
          session.assert();
          if (!data) throw new Error("IR learning timed out, no data received");
          const cmdname = this.getNextCmdName();
          const added = await this.dataStore.addCommand(cmdname, data);
          session.assert();
          if (!added) throw new Error("Learned command could not be saved");
          await this.storeCmdSetting(cmdname);
          session.assert();
          await this.fillRcCmdPage(this.getCurrentOffset());
          session.assert();
          await this._localLearningWarning(`Stored command: ${cmdname}`, session);
        } catch (error) {
          try { session.assert(); } catch (_) { return; }
          this._utils.debugLog(this, `IR learning failed: ${error}`);
          await this._localLearningWarning(`IR learning failed: ${error.message || error}`, session);
        } finally {
          try {
            session.assert();
            this.learn = false;
            await this.setCapabilityValue("learnIRcmd", false).catch(error => this.error("IR learning UI reset failed", error));
            session.assert();
            await this.setCapabilityValue("learningState", false).catch(error => this.error("IR learning UI reset failed", error));
          } catch (_) { /* A cancelled session cannot mutate the replacement session. */ }
        }
      })());
    }, 300);
  }

  getNextCmdName() {
    const names = this.dataStore.getCommandNameList();
    let idx = 1;
    while (names.includes(`cmd${idx}`)) {
      idx++;
    }
    return `cmd${idx}`;
  }

  /**
   * Called when the device settings are changed by the user
   * (so NOT called on programmatically changing settings)
   *
   *  @param oldSettingsObj   contains the previous settings object
   *  @param newSettingsObj   contains the new settings object
   *  @param changedKeysArr   contains an array of keys that have been changed
   *  @return {Promise<void>}
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this._utils.debugLog(this, "Settings changed:", changedKeys);

    // Restore from raw JSON
    if (changedKeys.includes("RcCmdRestore")) {
      const raw = (newSettings.RcCmdRestore || "").trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) throw new Error("Restore JSON must be an array.");
          const restored = parsed.map((item, idx) => {
            if (!item.name || !item.cmd) {
              throw new Error(`Item ${idx} missing name or cmd`);
            }
            const cmdArray = Array.isArray(item.cmd) ? item.cmd : Array.isArray(Object.values(item.cmd)) ? Object.values(item.cmd) : null;
            if (!cmdArray) {
              throw new Error(`Item ${idx} cmd is not an array`);
            }
            return { name: String(item.name), cmd: new Uint8Array(cmdArray) };
          });
          this.dataStore.dataArray = restored;
          await this.dataStore.storeCommands();
          const newOffset = parseInt(newSettings.RcCmdPage || newSettings.RcCmdOffset || 0, 10) || 0;
          setTimeout(() => {
            this.fillRcCmdPage(newOffset).catch(this.error);
            this.setSettings({ RcCmdRestore: "" }).catch(this.error);
          }, 50);
          this._utils.debugLog(this, "Restore completed from RcCmdRestore JSON.");
          return;
        } catch (err) {
          this._utils.debugLog(this, `Restore failed: ${err.message}`);
          throw new Error(`Restore failed: ${err.message}`);
        }
      }
    }

    const offsetChanged = changedKeys.some((k) => k === "RcCmdOffset" || k === "RcCmdPage");
    const newOffset = parseInt(newSettings.RcCmdPage || newSettings.RcCmdOffset || 0, 10) || 0;
    if (offsetChanged && changedKeys.every((k) => k === "RcCmdOffset" || k === "RcCmdPage")) {
      setTimeout(() => this.fillRcCmdPage(newOffset), 0);
      this._utils.debugLog(this, "Offset/page changed, scheduled RcCmd view refresh.");
      return;
    }

    for (let i = 0; i < changedKeys.length; i++) {
      const key = changedKeys[i];
      if (key === "RcCmdOffset" || key === "RcCmdPage") {
        continue;
      }
      const oldName = oldSettings[key] || "";
      const newName = newSettings[key] || "";

      this._utils.debugLog(this, `Changed setting key: ${key}, Old value: ${oldName}, New value: ${newName}`);

      if (newName && newName.length > 0) {
        if (oldName && oldName.length > 0) {
          if (this.dataStore.findCommand(newName) >= 0) {
            this._utils.debugLog(this, `Error: Command ${newName} already exists`);
            throw new Error(this.homey.__("errors.save_settings_exist", { cmd: newName }));
          }
          // Rename the command if the old name exists and new name is provided
          const renamed = await this.dataStore.renameCommand(oldName, newName);
          if (renamed) {
            this._utils.debugLog(this, `Command renamed from ${oldName} to ${newName}`);
            const offset = this.getCurrentOffset();
            setTimeout(() => this.fillRcCmdPage(offset), 0);
          } else {
            this._utils.debugLog(this, `Failed to rename command ${oldName} to ${newName}`);
          }
        } else {
          this._utils.debugLog(this, `Error: No old command found for new command ${newName}`);
          throw new Error(this.homey.__("errors.save_settings_nocmd", { cmd: newName }));
        }
      } else {
      if (oldName && oldName.length > 0) {
        await this.dataStore.deleteCommand(oldName);
        this._utils.debugLog(this, `Command ${oldName} deleted.`);
        const offset = this.getCurrentOffset();
        setTimeout(() => this.fillRcCmdPage(offset), 0);
      }
    }

      if (key === "ipAddress" && this._communicate) {
        this._communicate.setIPaddress(newSettings.ipAddress);
        this._utils.debugLog(this, `IP Address changed from ${oldSettings.ipAddress} to ${newSettings.ipAddress}`);
      }

      if (key === "Authenticate" && newName === true) {
        this._utils.debugLog(this, "Re-authenticating device due to settings change");
        let deviceData = this.getData();
        let options = {
          ipAddress: newSettings.ipAddress,
          mac: this._utils.hexToArr(deviceData.mac),
          count: Math.floor(Math.random() * 0xffff),
          id: null,
          key: null,
          homey: this.homey,
          deviceType: Number(deviceData.devtype),
        };
        this._communicate.configure(options);
        await this.authenticateDevice();

        // Defer resetting the Authenticate setting
        process.nextTick(async () => {
          await this.setSettings({ Authenticate: false }).catch((e) => {
            this._utils.debugLog(this, "Error resetting Authenticate setting:", e.toString());
          });
        });
      }
    }

    if (offsetChanged) {
      setTimeout(() => this.fillRcCmdPage(newOffset), 0);
    }

    this._utils.debugLog(this, "Settings successfully updated.");
  }

  async stopRfLearning(session) {
    session?.assert();
    try {
      await this._communicate.cancelRFSweep_rm4pro();
    } catch (e) {
      this._utils.debugLog(this, "**> stopRfLearning error : " + e);
    }

    session?.assert();
    await this.setCapabilityValue("learnRFcmd", false).catch(this.error);
    session?.assert();
    await this.setCapabilityValue("learningStateRF", false).catch(this.error);

    session?.assert();
    this.learn = false;
  }

  async onCapabilityLearnRF(onoff) {
    this._utils.debugLog(this, `onCapabilityLearnRF called with onoff: ${onoff}`);
    if (onoff === false) {
      this._stopLocalLearning();
      await this.stopRfLearning(this._learningSession());
      return true;
    }
    return this.startRfLearning();
  }

  async startRfLearning(frequencyMHz = 0) {
    if (this.learn || this._localStopped) return true;
    let frequencyBytes = this._communicate.encodeRFFrequency_rm4pro(frequencyMHz);
    this._stopLocalLearning();
    this.learn = true;
    const session = this._learningSession();
    this.setCapabilityValue("learningStateRF", true).catch(this.error);
    setImmediate(() => this._trackLocalLearning((async () => {
      const prompt = async key => {
        session.assert();
        if (this.isSpeechOutputAvailable()) await this.homey.speechOutput.say(this.homey.__(key));
        else await this._localLearningWarning(this.homey.__(key), session);
        session.assert();
      };
      try {
        session.assert();
        if (frequencyBytes) {
          this._utils.debugLog(this, `Manual RF learning at ${frequencyMHz} MHz; skipping frequency sweep`);
        } else {
          await session.communication.enterRFSweep_rm4pro();
          session.assert();
          await prompt("rf_learn.long_press");
          frequencyBytes = await session.communication.checkRFData_rm4pro();
          session.assert();
        }
        const frequency = Buffer.from(frequencyBytes).readUInt32LE() / 1000;
        await this._localLearningWarning(`Frequency: ${frequency} MHz`, session);
        session.assert();
        await session.communication._delay(2000, () => {
          try { session.assert(); return false; } catch (_) { return true; }
        }, true);
        session.assert();
        await prompt("rf_learn.multi_presses");
        let data;
        const type = Number(this.getData().devtype);
        if (type === 0x279d || type === 0x27a9) {
          await session.communication.enter_learning();
          session.assert();
          data = await session.communication.check_IR_data_red();
        } else data = await session.communication.checkRFData2_rm4pro(frequencyBytes);
        session.assert();
        if (!data) throw new Error("No RF data received");
        let idx = 1;
        while (this.dataStore.dataArray.some(command => command.name === `rf-cmd${idx}`)) idx++;
        const cmdname = `rf-cmd${idx}`;
        const added = await this.dataStore.addCommand(cmdname, data);
        session.assert();
        if (!added) throw new Error("Learned RF command could not be saved");
        await this.storeCmdSetting(cmdname);
        session.assert();
        await this.stopRfLearning(session);
        await prompt("rf_learn.done");
      } catch (error) {
        try { session.assert(); } catch (_) { return false; }
        this._utils.debugLog(this, `Learning RF failed: ${error}`);
        await this.stopRfLearning(session);
        await prompt("rf_learn.error");
      }
    })()));
    return true;
  }

  /**
   * Checks if speech output is available on the current platform
   * @returns {boolean}
   */
  isSpeechOutputAvailable() {
    const platform = this.homey.platform;
    const platformVersion = this.homey.platformVersion;

    // Log the platform and platform version
    this._utils.debugLog(this, `SpeechOutput: platform=${platform}, platformVersion=${platformVersion}`);

    // Speech output is available only if the platform is "local" or undefined and the platform version is exactly 1
    if ((platform === "local" || platform === undefined) && platformVersion === 1) {
      return true;
    }

    // Otherwise, speech output is not available
    return false;
  }

  async pollTempHumidity() {
    // RM Max is paired through this driver but does not use RM4's HTS2 sensor protocol.
    if (this.getData && Number(this.getData().devtype) === 0xaf8b) return;
    if (this._localStopped || this._climatePolling) return;
    this._climatePolling = true;
    const generation = this._localGeneration;
    const communication = this._communicate;
    try {
      const { temperature, humidity } = await communication.checkTempHumidity_rm4pro();
      this._assertLocalOperation?.(generation, communication);
      const tempValue = temperature[0] + temperature[1] / 100;
      const humidityValue = humidity[0] + humidity[1] / 100;

      await this.setCapabilityValue("measure_temperature", tempValue).catch(this.error);
      this._assertLocalOperation?.(generation, communication);
      await this.setCapabilityValue("measure_humidity", humidityValue).catch(this.error);
      this._assertLocalOperation?.(generation, communication);
      await this.setCapabilityValue("measure_temperature_rm4", tempValue).catch(this.error);
      this._assertLocalOperation?.(generation, communication);
      await this.setCapabilityValue("measure_humidity_rm4", humidityValue).catch(this.error);

      this._utils.debugLog(this, `Polled Temperature: ${tempValue} °C, Humidity: ${humidityValue} %`);
    } catch (err) {
      this._utils.debugLog(this, `Error polling temperature and humidity: ${err.message}`);
    } finally {
      this._climatePolling = false;
    }
  }

  /**
   * This method will be called when a device has been removed.
   */
  async onDeleted() {
    super.onDeleted();
    await Promise.allSettled(this._localLearningTasks || []);
    try {
      this._utils.debugLog(this, "Device deleted; deleting stored commands");
      await this.dataStore.deleteAllCommands();
    } finally {
      this.stop_check_interval();
      if (this._communicate) this._communicate.destroy();
      this._communicate = null;
      if (this.homey?.app && typeof this.homey.app.unregisterRfDevice === "function") {
        this.homey.app.unregisterRfDevice(this);
      }
    }
  }
}

module.exports = RM4ProDevice;
