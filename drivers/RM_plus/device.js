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

const RM3MiniDevice = require("./../RM3_mini/device");

class RmPlusDevice extends RM3MiniDevice {
  async onInit() {
    await super.onInit();
    this.learn = false;
    this._utils.debugLog(this, "RM Plus Device onInit called");
    this.registerCapabilityListener("learnRFcmd", this.onCapabilityLearnRF.bind(this));
  }

  onCapabilityLearnMode() {
    return false;
  }

  /**
   *
   */
  async stopRfLearning() {
    try {
      await this._communicate.cancelRFSweep();
    } catch (e) {
      this._utils.debugLog(this, "**> stopRfLearning: " + e);
    }
    this.learn = false;
  }

  /**
   * This method will be called when the learn state needs to be changed.
   * @param onoff
   * @return \c TRUE if successful, \c FALSE otherwise
   */
  async onCapabilityLearnRF(onoff) {
    if (this.learn) {
      return true;
    }
    this.learn = true;

    let type = this.getData().devtype;
    try {
      var data;
      await this._communicate.enterRFSweep();

      if (this.isSpeechOutputAvailable()) {
        await this.homey.speechOutput.say(this.homey.__("rf_learn.long_press"));
      } else {
        setTimeout(async () => { await this.setWarning(this.homey.__("rf_learn.long_press")); setTimeout(async () => { await this.unsetWarning(); }, 6000); }, 0);
      }

      await this._communicate.checkRFData();

      if (this.isSpeechOutputAvailable()) {
        await this.homey.speechOutput.say(this.homey.__("rf_learn.multi_presses"));
      } else {
        setTimeout(async () => { await this.setWarning(this.homey.__("rf_learn.multi_presses")); setTimeout(async () => { await this.unsetWarning(); }, 6000); }, 0);
      }

      if (type == 0x279d || type == 0x27a9) {
        await this._communicate.enter_learning();
        data = await this._communicate.check_IR_data();
      } else {
        data = await this._communicate.checkRFData2();
      }
      if (data) {
        let idx = this.dataStore.dataArray.length + 1;
        let cmdname = "rf-cmd" + idx;
        this.dataStore.addCommand(cmdname, data);
        await this.storeCmdSetting(cmdname);
      }
      await this.stopRfLearning();

      if (this.isSpeechOutputAvailable()) {
        await this.homey.speechOutput.say(this.homey.__("rf_learn.done"));
      } else {
        setTimeout(async () => { await this.setWarning(this.homey.__("rf_learn.done")); setTimeout(async () => { await this.unsetWarning(); }, 6000); }, 0);
      }

      return true;
    } catch (e) {
      this._utils.debugLog(this, "**> Learning RF failed");

      if (this.isSpeechOutputAvailable()) {
        await this.homey.speechOutput.say(this.homey.__("rf_learn.done"));
      } else {
        setTimeout(async () => { await this.setWarning(this.homey.__("rf_learn.error")); setTimeout(async () => { await this.unsetWarning(); }, 6000); }, 0);
      }

      await this.stopRfLearning();
      return false;
    }
  }

  /**
   * Called when the device settings are changed by the user.
   * Defer to the RM3 Mini handler so paging/backup logic stays in sync.
   */
  async onSettings(args) {
    return super.onSettings(args);
  }

  async executeCommand(args) {
    try {
      let cmd = args["variable"];

      this._utils.debugLog(this, "executeCommand " + cmd.name);

      // send the command
      let cmdData = this.dataStore.getCommandData(cmd.name);

      const deviceType = `0x${parseInt(this.getData().devtype, 10).toString(16)}`;
      if (deviceType == 0x5f36) {
        // 0x5F36 for Red Bean
        await this._communicate.send_IR_RF_data_red(cmdData);
      } else {
        await this._communicate.send_IR_RF_data(cmdData);
      }

      cmdData = null;

      let drv = this.driver;
      // RC_specific_sent: user entered command name
      drv.rmplus_specific_cmd_trigger.trigger(this, {}, { variable: cmd.name });

      // RC_sent_any: set token
      drv.rmplus_any_cmd_trigger.trigger(this, { CommandSent: cmd.name }, {});
    } catch (e) {
      this._utils.debugLog(this, `Error executing command: ${e}`);
    }

    return Promise.resolve(true);
  }
  
  /**
   * Checks if speech output is available on the current platform
   * @returns {boolean}
   */
  isSpeechOutputAvailable() {
    const platform = this.homey.platform;
    const platformVersion = this.homey.platformVersion;

    // Log the platform and platform version
    this._utils.debugLog(this, `isSpeechOutputAvailable: platform=${platform}, platformVersion=${platformVersion}`);

    // Speech output is available only if the platform is "local" or undefined and the platform version is exactly 1
    if ((platform === "local" || platform === undefined) && platformVersion === 1) {
      return true;
    }

    // Otherwise, speech output is not available
    return false;
  }
}

module.exports = RmPlusDevice;
