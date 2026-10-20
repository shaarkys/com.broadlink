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
const DataStore = require("../../lib/DataStore.js");

class RM4miniDevice extends BroadlinkDevice {
  /**
   * Store the given name at the first available place in settings.
   * i.e. look for an entry 'RcCmd.' (where . is integer >= 0)
   */
  async storeCmdSetting(cmdname) {
    let settings = this.getSettings();

    var idx = 0;
    let settingName = "RcCmd" + idx;
    while (settingName in settings) {
      this._utils.debugLog(this, settingName);
      if (settings[settingName].length == 0) {
        this._utils.debugLog(this, this.getName() + " - storeCmdSettings - setting = " + settingName + ", name = " + cmdname);
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

      const updates = { RcCmdPage: String(offset), RcCmdOffset: offset, RcCmdBackup: backup, RcCmdRestore: "" };
      const names = this.dataStore.getCommandNameList();
      let idx = 0;
      let settingName = "RcCmd" + idx;
      while (settingName in settings) {
        updates[settingName] = names[offset + idx] || "";
        idx++;
        settingName = "RcCmd" + idx;
      }
      updates["RcCmdPageInfo"] = pageLabel;
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
      const communication = this._communicate;
      const generation = this._operationGeneration;
      await this._withAuthentication(() => this._communicate.send_IR_RF_data_rm4mini(cmdData));
      this._assertConnection(communication, generation);
      cmdData = null;

      let drv = this.driver;
      // RC_specific_sent: user entered command name
      drv.rm4_mini_specific_cmd_trigger.trigger(this, {}, { variable: cmd.name }).catch(this.error);

      // RC_sent_any: set token
      drv.rm4_mini_any_cmd_trigger.trigger(this, { CommandSent: cmd.name }, {}).catch(this.error);
    } catch (e) {
      this.error("RM4 mini command failed", e);
      throw e;
    }

    return Promise.resolve(true);
  }

  _enqueue(operation) {
    const communication = this._communicate;
    const generation = this._operationGeneration;
    const pending = (this._operationQueue || Promise.resolve()).then(async () => {
      this._assertConnection(communication, generation);
      const result = await operation();
      this._assertConnection(communication, generation);
      return result;
    });
    this._operationQueue = pending.catch(() => {});
    return pending;
  }

  _assertConnection(communication, generation) {
    if (this._operationsStopped || !communication || communication !== this._communicate || generation !== this._operationGeneration) {
      throw new Error("RM4 mini device has been stopped or reinitialized");
    }
  }

  _stopOperations() {
    this._operationsStopped = true;
    this._operationGeneration = (this._operationGeneration || 0) + 1;
    if (this.learnTimeout) clearTimeout(this.learnTimeout);
    this.learnTimeout = null;
    if (this._learningWarningTimeout) this.homey.clearTimeout(this._learningWarningTimeout);
    this._learningWarningTimeout = null;
    this.learn = false;
  }

  async _drainOperations() {
    await this._operationQueue;
    await Promise.allSettled(this._learningTasks || []);
    await this._learningWarningUpdate;
  }

  async _showLearningWarning(message, communication, generation) {
    this._assertConnection(communication, generation);
    await this.setWarning(message);
    this._assertConnection(communication, generation);
    if (this._learningWarningTimeout) this.homey.clearTimeout(this._learningWarningTimeout);
    this._learningWarningTimeout = this.homey.setTimeout(() => {
      this._learningWarningTimeout = null;
      if (this._operationsStopped || communication !== this._communicate || generation !== this._operationGeneration) return;
      this._learningWarningUpdate = this.setWarning(null).catch(this.error);
    }, 5000);
  }

  _withAuthentication(operation) {
    const communication = this._communicate;
    const generation = this._operationGeneration;
    return this._enqueue(async () => {
      try {
        return await operation();
      } catch (err) {
        this._assertConnection(communication, generation);
        if (err.code !== -7) throw err;
        this.log("RM4 mini control key expired; authenticating and retrying once");
        await this.authenticateDevice();
        this._assertConnection(communication, generation);
        return operation();
      }
    });
  }

  async authenticateDevice() {
    const communication = this._communicate;
    const generation = this._operationGeneration;
    this._assertConnection(communication, generation);
    communication.configure({
      ipAddress: communication.ipAddress,
      mac: this._utils.hexToArr(this.getData().mac),
      deviceType: Number(this.getData().devtype),
      count: Math.floor(Math.random() * 0xffff),
      key: null,
      id: null,
      homey: this.homey,
    });
    const authentication = await communication.auth();
    this._assertConnection(communication, generation);
    if (!authentication || authentication.key?.length !== 16 || authentication.id?.length !== 4) {
      throw new Error("Invalid RM4 mini authentication session");
    }
    await this.setSettings({
      key: this._utils.arrToHex(authentication.key),
      id: this._utils.arrToHex(authentication.id),
    });
    this._assertConnection(communication, generation);
    this.log("RM4 mini authentication completed and session saved");
  }

  onAdded() {
    return this._enqueue(() => this.authenticateDevice());
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
    this._stopOperations();
    const generation = this._operationGeneration;
    await this._drainOperations();
    if (generation !== this._operationGeneration) return;
    if (this._communicate) this._communicate.destroy();
    await super.onInit();
    if (generation !== this._operationGeneration) return;
    this._operationsStopped = false;
    this._utils.debugLog(this, "RM4 Mini Device onInit called");
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
    const communication = this._communicate;
    const generation = this._operationGeneration;

    if (this.learnTimeout) {
      clearTimeout(this.learnTimeout); // Clear any existing timeout
    }

    this.learnTimeout = setTimeout(() => {
      const task = (async () => {
        if (this._operationsStopped || communication !== this._communicate || generation !== this._operationGeneration) return false;
        if (!onoff) {
          this._utils.debugLog(this, "Turning off learning mode");
          this.learn = false;
          await this.setCapabilityValue("learnIRcmd", false).catch(this.error);
          this._assertConnection(communication, generation);
          await this.setCapabilityValue("learningState", false).catch(this.error);
          return true;
        }

        if (this.learn) {
          this._utils.debugLog(this, "Learning mode already active, not restarting");
          return false;
        }

        this.learn = true;
        await this.setCapabilityValue("learningState", true).catch(this.error);
        this._assertConnection(communication, generation);
        this._utils.debugLog(this, "Starting IR learning mode");

        try {
          await this._withAuthentication(() => this._communicate.enter_learning_rm4mini());
          this._assertConnection(communication, generation);
          this._utils.debugLog(this, "Entered learning mode");

          let data = await this._communicate.check_IR_data_rm4mini(
            () => {
              this._assertConnection(communication, generation);
              return this._withAuthentication(() => communication.read_IR_data_rm4mini());
            }
          );
          this._assertConnection(communication, generation);
          this._utils.debugLog(this, `Checked IR data, data: ${data}`);

          if (data) {
            const cmdname = this.getNextCmdName();
            const added = await this.dataStore.addCommand(cmdname, data);
            this._assertConnection(communication, generation);
            if (!added) throw new Error(`Could not save learned command: ${cmdname}`);

            await this.storeCmdSetting(cmdname);
            this._assertConnection(communication, generation);
            this._utils.debugLog(this, `Stored command: ${cmdname}`);
            const offset = this.getCurrentOffset();
            await this.fillRcCmdPage(offset);
            this._assertConnection(communication, generation);

            await this.setCapabilityValue("learnIRcmd", false).catch(this.error); // Turn off the capability after success
            this._assertConnection(communication, generation);
            await this.setCapabilityValue("learningState", false).catch(this.error);
            await this._showLearningWarning(`Stored command: ${cmdname}`, communication, generation);
            this.learn = false;
            return true;
          } else {
            this._utils.debugLog(this, "No IR data received");
            await this.setCapabilityValue("learnIRcmd", false).catch(this.error); // Turn off the capability after failure
            this._assertConnection(communication, generation);
            await this.setCapabilityValue("learningState", false).catch(this.error);
            await this._showLearningWarning("IR learning timed out, no data received.", communication, generation);
            this.learn = false;
            return false;
          }
        } catch (e) {
          if (this._operationsStopped || communication !== this._communicate || generation !== this._operationGeneration) return false;
          this._utils.debugLog(this, `Error during IR learning: ${e}`);
          await this.setCapabilityValue("learnIRcmd", false).catch(this.error); // Turn off the capability after error
          this._assertConnection(communication, generation);
          await this.setCapabilityValue("learningState", false).catch(this.error);
          await this._showLearningWarning(`IR learning failed: ${e}`, communication, generation);
          this.learn = false;
          return false;
        }
      })();
      if (!this._learningTasks) this._learningTasks = new Set();
      this._learningTasks.add(task);
      task.finally(() => this._learningTasks.delete(task)).catch(this.error);
      return task;
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
          // Defer UI refresh to avoid setSettings during onSettings
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
        await this._enqueue(() => this._communicate.setIPaddress(newSettings.ipAddress));
        this._utils.debugLog(this, `IP Address changed from ${oldSettings.ipAddress} to ${newSettings.ipAddress}`);
      }

      if (key === "Authenticate" && newName === true) {
        this._utils.debugLog(this, "Re-authenticating device due to settings change");
        await this._enqueue(() => this.authenticateDevice());

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

  async onUninit() {
    this._stopOperations();
    super.onUninit();
    await this._drainOperations();
  }

  /**
   * This method will be called when a device has been removed.
   */
  async onDeleted() {
    await this.onUninit();
    this._utils.debugLog(this, 'Device deleted, will be deleting all commands :'+ this.getData().id);
    this.dataStore.deleteAllCommands();
    this.stop_check_interval();
    if (this._communicate) this._communicate.destroy();
    this._communicate = null;
    if (this.homey?.app && typeof this.homey.app.unregisterRfDevice === "function") {
      this.homey.app.unregisterRfDevice(this);
    }
  }
}

module.exports = RM4miniDevice;
