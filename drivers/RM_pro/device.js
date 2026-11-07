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

class RmProDevice extends RM3MiniDevice {
  async onInit() {
    if (await super.onInit() === false || this._localStopped) return false;
    this.learn = false;
    this._utils.debugLog(this, "RMPro device onInit called");
    this.registerCapabilityListener("learnRFcmd", this.onCapabilityLearnRF.bind(this));
  }

  async stopRfLearning(session = this._learningSession()) {
    session?.assert();
    try {
      await this._communicate.cancelRFSweep();
    } catch (e) {
      this._utils.debugLog(this, "**> stopRfLearning: " + e);
    }
    session?.assert();
    this.learn = false;
    await this.setCapabilityValue("learnRFcmd", false).catch(error => this.error("RF learning UI reset failed", error));
    session?.assert();
  }

  async onCapabilityLearnRF(onoff) {
    if (onoff === false) {
      this._stopLocalLearning();
      await this.stopRfLearning(this._learningSession());
      return true;
    }
    if (this.learn || this._localStopped) return true;
    this._stopLocalLearning();
    this.learn = true;
    const session = this._learningSession();
    return this._trackLocalLearning((async () => {
      const prompt = async key => {
        session.assert();
        if (this.isSpeechOutputAvailable()) await this.homey.speechOutput.say(this.homey.__(key));
        else await this._localLearningWarning(this.homey.__(key), session);
        session.assert();
      };
      try {
        session.assert();
        await session.communication.enterRFSweep();
        session.assert();
        await prompt("rf_learn.long_press");
        await session.communication.checkRFData();
        session.assert();
        await prompt("rf_learn.multi_presses");
        let data;
        const type = Number(this.getData().devtype);
        if (type === 0x279d || type === 0x27a9) {
          await session.communication.enter_learning();
          session.assert();
          data = await session.communication.check_IR_data();
        } else data = await session.communication.checkRFData2();
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
        return true;
      } catch (error) {
        try { session.assert(); } catch (_) { return false; }
        this._utils.debugLog(this, `Learning RF failed: ${error}`);
        await this.stopRfLearning(session);
        await prompt("rf_learn.error");
        return false;
      }
    })());
  }

  /**
   * Use the RM3 Mini settings handler so command paging/backup logic stays aligned.
   */
  async onSettings(args) {
    return super.onSettings(args);
  }

  async executeCommand(args) {
    const generation = this._localGeneration;
    const communication = this._communicate;
    try {
      this._assertLocalOperation(generation, communication);
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

      this._assertLocalOperation(generation, communication);
      cmdData = null;

      let drv = this.driver;
      // RC_specific_sent: user entered command name
      await Promise.resolve().then(() => { this._assertLocalOperation(generation, communication); return drv.rmpro_specific_cmd_trigger.trigger(this, {}, { variable: cmd.name }); }).catch(error => this.error("Command sent Flow failed", error));

      // RC_sent_any: set token
      await Promise.resolve().then(() => { this._assertLocalOperation(generation, communication); return drv.rmpro_any_cmd_trigger.trigger(this, { CommandSent: cmd.name }, {}); }).catch(error => this.error("Command sent Flow failed", error));
    } catch (e) {
      this._utils.debugLog(this, `Error executing command: ${e}`);
      throw e;
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

module.exports = RmProDevice;
