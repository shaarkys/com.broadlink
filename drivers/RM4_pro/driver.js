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

const BroadlinkDriver = require("../../lib/BroadlinkDriver");

const DeviceInfo = require("./../../lib/DeviceInfo.js");
const BroadlinkType = DeviceInfo.BroadlinkType;

class BroadlinkRM4ProDriver extends BroadlinkDriver {
  async onInit() {
    super.onInit({
      //CompatibilityID: 0x520b // RM4 PRO
      CompatibilityID: BroadlinkType.RM4Pro,
      ExcludedDeviceTypes: [0xaf8b]
    });

    //this.rm4_action_send_cmd = new Homey.FlowCardAction('send_command');
    this.rm4_pro_action_send_cmd = this.homey.flow.getActionCard("send_command_rm4_pro");
    this.rm4_pro_action_send_cmd
      .registerRunListener(this.do_exec_cmd.bind(this))
      .getArgument("variable")
      .registerAutocompleteListener((query, args) => {
        return args.device.onAutoComplete();
      });

    // Register a function to fill the trigger-flowcard 'RC_specific_sent' (see app.json)
    //this.rm4_specific_cmd_trigger = new Homey.FlowCardTriggerDevice('RC_specific_sent');
    this.rm4_pro_specific_cmd_trigger = this.homey.flow.getDeviceTriggerCard("RC_specific_sent_rm4_pro");
    this.rm4_pro_specific_cmd_trigger
      .registerRunListener(this.check_condition_specific_cmd.bind(this))
      .getArgument("variable")
      .registerAutocompleteListener((query, args) => {
        return args.device.onAutoComplete();
      });

    //this.rm3mini_any_cmd_trigger = new Homey.FlowCardTriggerDevice('RC_sent_any').register()
    this.rm4_pro_any_cmd_trigger = this.homey.flow.getDeviceTriggerCard("RC_sent_any_rm4_pro");
  }

  check_condition_specific_cmd(args, state) {
    return args.device.check_condition_specific_cmd_sent(args, state);
  }

  do_exec_cmd(args, state) {
    return args.device.executeCommand(args);
  }
}

module.exports = BroadlinkRM4ProDriver;
