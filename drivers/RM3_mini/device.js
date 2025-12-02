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
const DataStore = require("./../../lib/DataStore.js");

class RM3miniDevice extends BroadlinkDevice {
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
    try {
      let cmd = args["variable"];

      this._utils.debugLog(this, "executeCommand " + cmd.name);

      // send the command
      let cmdData = this.dataStore.getCommandData(cmd.name);

      const deviceType = `0x${parseInt(this.getData().devtype, 10).toString(16)}`;
      if (deviceType == 0x5f36) {
        // 0x5F36 for Red Bean
        //await this._communicate.send_IR_RF_data_red(cmdData);
        await this._communicate.send_IR_RF_data_minired(cmdData);
      } else {
        await this._communicate.send_IR_RF_data(cmdData);
      }

      cmdData = null;

      let drv = this.driver;
      // RC_specific_sent: user entered command name
      drv.rm3mini_specific_cmd_trigger.trigger(this, {}, { variable: cmd.name });

      // RC_sent_any: set token
      drv.rm3mini_any_cmd_trigger.trigger(this, { CommandSent: cmd.name }, {});
    } catch (e) {
      this._utils.debugLog(this, `Error executing command: ${e}`);
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

  /**
   *
   */
  async onInit() {
    await super.onInit();
    this._utils.debugLog(this, "RM3 Mini Device onInit called");
    if (this.homey?.app && typeof this.homey.app.registerRfDevice === "function") {
      this.homey.app.registerRfDevice(this);
    }
    // Ensure the learnIRcmd capability exists and set its initial value
    if (!this.hasCapability("learnIRcmd")) {
      await this.addCapability("learnIRcmd");
    }
    this.setCapabilityValue("learnIRcmd", false).catch(this.error);

    // Ensure the learningState capability exists and set its initial value
    if (!this.hasCapability("learningState")) {
      await this.addCapability("learningState");
    }
    this.setCapabilityValue("learningState", false).catch(this.error);

    this.registerCapabilityListener("learnIRcmd", this.onCapabilityLearnIR.bind(this));

    try {
      this.dataStore = new DataStore(this.getData().mac, this.homey);
      await this.dataStore.readCommands(async () => {
        this.updateSettings();
      });
    } catch (err) {
      if (err instanceof SyntaxError && err.message.includes("Unexpected token")) {
        this._utils.debugLog(this, `Device.onInit Error: ${err.message}`);
        await this.dataStore.deleteAllCommands();
        this._utils.debugLog(this, "Corrupted JSON detected and deleted.");
        this.updateSettings(); // Call updateSettings again after deleting corrupted JSON
      } else {
        this._utils.debugLog(this, `Device.onInit Error: ${err.message}`);
        throw err; // Re-throw if it's not the specific error we're handling
      }
    }
  }

  /**
   * This method will be called when the learn state needs to be changed.
   * @param onoff
   */
  async onCapabilityLearnIR(onoff) {
    this._utils.debugLog(this, `onCapabilityLearnIR called with onoff: ${onoff}`);

    if (this.learnTimeout) {
      clearTimeout(this.learnTimeout); // Clear any existing timeout
    }

    this.learnTimeout = setTimeout(async () => {
      if (!onoff) {
        this._utils.debugLog(this, "Turning off learning mode");
        this.learn = false;
        await this.setCapabilityValue("learnIRcmd", false).catch(this.error);
        await this.setCapabilityValue("learningState", false).catch(this.error);
        return true;
      }

      if (this.learn) {
        this._utils.debugLog(this, "Learning mode already active, not restarting");
        return false;
      }

      this.learn = true;
      await this.setCapabilityValue("learningState", true).catch(this.error);
      this._utils.debugLog(this, "Starting IR learning mode");

      try {
        const deviceType = `0x${parseInt(this.getData().devtype, 10).toString(16)}`;
        this._utils.debugLog(this, `Device type: ${deviceType}`);

        if (deviceType == 0x5f36) {
          // 0x5F36 for Red Bean

          this._utils.debugLog(this, "Using enter_learning_red for RM Mini 3 Red Bean");
          await this._communicate.enter_learning_red();
        } else {
          this._utils.debugLog(this, "Using enter_learning for other RM devices");
          await this._communicate.enter_learning();
        }

        let data;
        // useless check - seems that check_IR_data does have already modification for 0x5F36
        if (deviceType == 0x5f36) {
          // 0x5F36 for Red Bean
          data = await this._communicate.check_IR_data_red();
        } else {
          data = await this._communicate.check_IR_data();
        }

        this._utils.debugLog(this, `Checked IR data, data: ${data}`);

        if (data) {
          const cmdname = this.getNextCmdName();
          this.dataStore.addCommand(cmdname, data);

          await this.storeCmdSetting(cmdname);
          this._utils.debugLog(this, `Stored command: ${cmdname}`);
          const offset = this.getCurrentOffset();
          await this.fillRcCmdPage(offset);

          await this.setCapabilityValue("learnIRcmd", false).catch(this.error); // Turn off the capability after success
          await this.setCapabilityValue("learningState", false).catch(this.error);
          setTimeout(() => this.setWarning(null), 5000, await this.setWarning(`Stored command: ${cmdname}`));
          this.learn = false;
          return true;
        } else {
          this._utils.debugLog(this, "No IR data received");
          await this.setCapabilityValue("learnIRcmd", false).catch(this.error); // Turn off the capability after failure
          await this.setCapabilityValue("learningState", false).catch(this.error);
          setTimeout(() => this.setWarning(null), 5000, await this.setWarning("IR learning timed out, no data received."));
          this.learn = false;
          return false;
        }
      } catch (e) {
        this._utils.debugLog(this, `Error during IR learning: ${e}`);
        await this.setCapabilityValue("learnIRcmd", false).catch(this.error); // Turn off the capability after error
        await this.setCapabilityValue("learningState", false).catch(this.error);
        /*setTimeout(() => this.setWarning(null), 5000, await this.setWarning(`IR learning failed: ${e}`));*/
        await this.setWarning(`IR learning failed: ${e}`);
        setTimeout(async () => { if (this.getData()) { await this.setWarning(null).catch(this.error); } }, 5000);
        this.learn = false;
        return false;
      }
    }, 300); // Debounce duration in milliseconds (adjust as necessary)
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
          // Defer UI refresh so it happens after onSettings completes
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
    // If only the page changed, refresh after returning to avoid pending setSettings
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
          ipAddress: this.getSettings().ipAddress,
          mac: this._utils.hexToArr(deviceData.mac),
          count: Math.floor(Math.random() * 0xffff),
          id: null,
          key: null,
          homey: this.homey,
          deviceType: parseInt(deviceData.devtype, 16),
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

    // If page also changed alongside name edits, refresh after the edits are processed
    if (offsetChanged) {
      setTimeout(() => this.fillRcCmdPage(newOffset), 0);
    }

    this._utils.debugLog(this, "Settings successfully updated.");
  }
  /**
   * This method will be called when a device has been removed.
   */
  onDeleted() {
    this._utils.debugLog(this, 'Device deleted, will be deleting all commands :'+ this.getData().id);
    this.dataStore.deleteAllCommands();
    if (this.homey?.app && typeof this.homey.app.unregisterRfDevice === "function") {
      this.homey.app.unregisterRfDevice(this);
    }
  }
}

module.exports = RM3miniDevice;
