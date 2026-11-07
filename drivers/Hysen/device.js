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

/*
 * see: https://pycrc.org/models.html
 * 
crc-16-modbus
=============
Width              16
Poly               0x8005
Reflect In         True
XOR In             0xffff
Reflect Out        True
XOR Out            0x0000
Short command      pycrc.py --model crc-16-modbus
Extended command   pycrc.py --width 16 --poly 0x8005 --reflect-in True --xor-in 0xffff --reflect-out True --xor-out 0x0000
Check              0x4b37
 */

"use strict";

const BroadlinkDevice = require("./../../lib/BroadlinkDevice");
const CRC16 = require("crc").crc16modbus;

const SENSOR_MODE_MIN = 0;
const SENSOR_MODE_MAX = 2;
const ROOM_TEMP_ADJUST_MIN = -5.0;
const ROOM_TEMP_ADJUST_MAX = 5.0;

class HysenDevice extends BroadlinkDevice {
  _isHysenActive(generation = this._hysenGeneration) {
    return !this._hysenStopped && generation === this._hysenGeneration;
  }

  /**
   *
   */
  async onCheckInterval() {
    const generation = this._hysenGeneration;
    if (!this._isHysenActive(generation)) return;
    this._utils.debugLog(this, "onCheckInterval called");
    try {
      await this.get_temperature(generation);
      if (this._isHysenActive(generation)) await this.get_full_status(generation);
    } catch (err) {
      this._utils.debugLog(this, "**> onCheckInterval error: " + err);
    }
  }

  check_parentalmode_on() {
    return Promise.resolve(this.data["ParentalMode"]);
  }

  async do_action_parentalmode_on() {
    return this.onCapabilityParentalMode(true);
  }

  async do_action_parentalmode_off() {
    return this.onCapabilityParentalMode(false);
  }

  async _trigger_parentalmode(generation = this._hysenGeneration) {
    if (!this._isHysenActive(generation)) return;
    try {
      let drv = this.driver;
      if (this.data["ParentalMode"]) {
        await drv.trigger_parentalmode_on.trigger(this, {}, {});
      } else {
        await drv.trigger_parentalmode_off.trigger(this, {}, {});
      }
      if (this._isHysenActive(generation)) await drv.trigger_parentalmode_toggle.trigger(this, {}, {});
    } catch (err) {
      this.error("Thermostat parental Homey Flow trigger failed", err);
    }
  }

  async _updateCapabilities(generation = this._hysenGeneration) {
    if (!this._isHysenActive(generation)) return;
    await this.setCapabilityValue("measure_temperature", this.data["RoomTemperature"]);
    if (!this._isHysenActive(generation)) return;

    if (this.getCapabilities().indexOf("measure_temperature.room") > -1) {
      await this.setCapabilityValue("measure_temperature.room", this.data["RoomTemperature"]);
    }
    if (!this._isHysenActive(generation)) return;
    if (this.getCapabilities().indexOf("measure_temperature.outside") > -1) {
      await this.setCapabilityValue("measure_temperature.outside", this.data["ExternalTemperature"]);
    }
    if (!this._isHysenActive(generation)) return;
    if (this.data["TargetTemperature"]) {
      await this.setCapabilityValue("target_temperature", this.data["TargetTemperature"]);
    }
    if (!this._isHysenActive(generation)) return;
    if (this.data["ParentalMode"] !== this.getCapabilityValue("parental_mode")) {
      await this._trigger_parentalmode(generation);
      if (this._isHysenActive(generation)) await this.setCapabilityValue("parental_mode", !!this.data["ParentalMode"]);
    }
  }

  async _updateAllSettings(generation = this._hysenGeneration) {
    if (!this._isHysenActive(generation)) return;
    let newSettings = {};

    if (this.data["TempRangeExtSensor"]) {
      newSettings["TempRangeExtSensor"] = this.data["TempRangeExtSensor"];
    }
    if (this.data["SensorMode"]) {
      newSettings["SensorMode"] = this.data["SensorMode"];
    }
    if (this.data["RoomTempAdjust"]) {
      newSettings["RoomTempAdjust"] = this.data["RoomTempAdjust"];
    }
    if (this.data["AutoMode"]) {
      newSettings["AutoMode"] = this.data["AutoMode"];
    }
    if (this.data["LoopMode"]) {
      newSettings["LoopMode"] = this.data["LoopMode"];
    }
    if (this.data["FloorTempDeadZone"]) {
      newSettings["FloorTempDeadZone"] = this.data["FloorTempDeadZone"];
    }
    if (this.data["SensorUpperLimit"]) {
      newSettings["SensorUpperLimit"] = this.data["SensorUpperLimit"];
    }
    if (this.data["SensorLowerLimit"]) {
      newSettings["SensorLowerLimit"] = this.data["SensorLowerLimit"];
    }
    if (this.data["AntiFreezeMode"]) {
      newSettings["AntiFreezeMode"] = this.data["AntiFreezeMode"];
    }

    newSettings["weekday1"] = this.data["schedule"][0]["time"];
    newSettings["weekday2"] = this.data["schedule"][1]["time"];
    newSettings["weekday3"] = this.data["schedule"][2]["time"];
    newSettings["weekday4"] = this.data["schedule"][3]["time"];
    newSettings["weekday5"] = this.data["schedule"][4]["time"];
    newSettings["weekday6"] = this.data["schedule"][5]["time"];
    newSettings["weekend1"] = this.data["schedule"][6]["time"];
    newSettings["weekend2"] = this.data["schedule"][7]["time"];
    newSettings["weekdaytemp1"] = this.data["schedule"][0]["temp"];
    newSettings["weekdaytemp2"] = this.data["schedule"][1]["temp"];
    newSettings["weekdaytemp3"] = this.data["schedule"][2]["temp"];
    newSettings["weekdaytemp4"] = this.data["schedule"][3]["temp"];
    newSettings["weekdaytemp5"] = this.data["schedule"][4]["temp"];
    newSettings["weekdaytemp6"] = this.data["schedule"][5]["temp"];
    newSettings["weekendtemp1"] = this.data["schedule"][6]["temp"];
    newSettings["weekendtemp2"] = this.data["schedule"][7]["temp"];

    if (Object.keys(newSettings).length > 0) {
      await this.setSettings(newSettings);
    }
  }

  _updateSetting(name, changedKeysArr, newSettingsObj) {
    if (changedKeysArr.indexOf(name) >= 0) {
      this.data[name] = newSettingsObj[name];
      return true;
    }
    return false;
  }

  _updateSchedule(dayname, tempname, index, changedKeysArr, newSettingsObj) {
    let changed = false;
    if (changedKeysArr.indexOf(dayname) >= 0) {
      this.data["schedule"][index]["time"] = newSettingsObj[dayname];
      changed = true;
    }
    if (changedKeysArr.indexOf(tempname) >= 0) {
      this.data["schedule"][index]["temp"] = Number(newSettingsObj[tempname]);
      changed = true;
    }
    return changed;
  }

  _isValidTime(dayname, changedKeysArr, newSettingsObj) {
    try {
      if (changedKeysArr.indexOf(dayname) >= 0) {
        if (!/^\d{2}:\d{2}$/.test(newSettingsObj[dayname])) {
          return false;
        }
        if (newSettingsObj[dayname][2] != ":") {
          return false;
        }

        let h = Number(newSettingsObj[dayname].substring(0, 2));
        if (h < 0 || h > 23) {
          return false;
        }

        h = Number(newSettingsObj[dayname].substring(3, 5));
        if (h < 0 || h > 59) {
          return false;
        }
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Called when the device settings are changed by the user
   * (so NOT called on programmatically changing settings)
   *
   *  @param event   SDK v3 settings event
   */
  async onSettings({ oldSettings, newSettings, changedKeys }) {
    const generation = this._hysenGeneration;
    if (!this._isHysenActive(generation)) throw new Error("Thermostat device has been stopped");
    const upperlimit = newSettings.SensorUpperLimit ?? this.data.SensorUpperLimit;
    const lowerlimit = newSettings.SensorLowerLimit ?? this.data.SensorLowerLimit;
    if (changedKeys.some((key) => key === "SensorUpperLimit" || key === "SensorLowerLimit")
      && (!Number.isFinite(upperlimit) || !Number.isFinite(lowerlimit) || upperlimit <= lowerlimit)) {
      throw new Error(this.homey.__("errors.invalid_sensor_limits"));
    }
    const dayNames = ["weekday1", "weekday2", "weekday3", "weekday4", "weekday5", "weekday6", "weekend1", "weekend2"];
    const tempNames = ["weekdaytemp1", "weekdaytemp2", "weekdaytemp3", "weekdaytemp4", "weekdaytemp5", "weekdaytemp6", "weekendtemp1", "weekendtemp2"];
    if (dayNames.some((name) => !this._isValidTime(name, changedKeys, newSettings))) {
      throw new Error(this.homey.__("errors.invalid_schedule_time"));
    }
    const advancedKeys = ["TempRangeExtSensor", "SensorMode", "RoomTempAdjust", "AutoMode", "LoopMode", "FloorTempDeadZone", "SensorUpperLimit", "SensorLowerLimit", "AntiFreezeMode"];
    const advancedChanged = advancedKeys.some((key) => changedKeys.includes(key));
    const scheduleChanged = [...dayNames, ...tempNames].some((key) => changedKeys.includes(key));
    if ((advancedChanged || scheduleChanged) && !this.data.schedule) {
      throw new Error("Thermostat status is not available yet; retry after its first update");
    }
    const nextData = { ...this.data };
    for (const key of advancedKeys) {
      if (changedKeys.includes(key)) nextData[key] = newSettings[key];
    }
    if (scheduleChanged) {
      nextData.schedule = this.data.schedule.map((entry) => ({ ...entry }));
      for (let i = 0; i < dayNames.length; i++) {
        if (changedKeys.includes(dayNames[i])) nextData.schedule[i].time = newSettings[dayNames[i]];
        if (changedKeys.includes(tempNames[i])) nextData.schedule[i].temp = Number(newSettings[tempNames[i]]);
      }
    }
    if (changedKeys.includes("ipAddress")) this._communicate.setIPaddress(newSettings.ipAddress);
    if (changedKeys.includes("Authenticate") && newSettings.Authenticate) {
      const deviceData = this.getData();
      this._communicate.configure({
        ipAddress: newSettings.ipAddress,
        mac: this._utils.hexToArr(deviceData.mac),
        count: Math.floor(Math.random() * 0xffff),
        id: null,
        key: null,
        homey: this.homey,
        deviceType: Number(deviceData.devtype),
      });
      await this.authenticateDevice();
      if (!this._isHysenActive(generation)) return;
    }
    if (advancedChanged) {
      await this.set_advanced(Number(nextData.LoopMode), Number(nextData.AutoMode), Number(nextData.SensorMode), nextData.TempRangeExtSensor, nextData.FloorTempDeadZone, nextData.SensorUpperLimit, nextData.SensorLowerLimit, nextData.RoomTempAdjust, Number(nextData.AntiFreezeMode), nextData.poweron);
      if (!this._isHysenActive(generation)) return;
    }
    if (scheduleChanged) {
      await this.set_schedule(nextData.schedule);
      if (!this._isHysenActive(generation)) return;
    }
    if (advancedChanged || scheduleChanged) this.data = nextData;
    if (changedKeys.includes("CheckInterval")) {
      this.stop_check_interval();
      this.start_check_interval(newSettings.CheckInterval);
    }
    if (changedKeys.includes("AdjustClock") && newSettings.AdjustClock) {
      const date = new Date();
      await this.set_time(date.getHours(), date.getMinutes(), date.getSeconds(), date.getDay() || 7);
      if (!this._isHysenActive(generation)) return;
      if (this._clockResetTimeout != null) this.homey.clearTimeout(this._clockResetTimeout);
      this._clockResetTimeout = this.homey.setTimeout(() => {
        this._clockResetTimeout = null;
        if (this._isHysenActive(generation)) this.setSettings({ AdjustClock: false }).catch((err) => this.error("Resetting thermostat clock setting failed", err));
      }, 2000);
    }
  }

  /* Send a request
   * input_payload should be a bytearray, usually 6 bytes, e.g. bytearray([0x01,0x06,0x00,0x02,0x10,0x00])
   * Returns decrypted payload
   * New behaviour: raises a ValueError if the device response indicates an error or CRC check fails
   * The function prepends length (2 bytes) and appends CRC
   */
  async send_request(input_payload) {
    var crc = CRC16(input_payload);

    // first byte is length +2 (for CRC16)
    var request_payload = this._utils.concatTypedArrays(new Uint8Array([input_payload.length + 2, 0x00]), input_payload);

    // append CRC
    request_payload = this._utils.concatTypedArrays(request_payload, new Uint8Array([crc & 0xff, (crc >> 8) & 0xff]));

    // send to device
    var response = await this._communicate.send_packet(0x6a, true, request_payload);
    if (response.error == 0) {
      // response does not contain command (4 bytes), but length and tailing crc
      var resp = this._utils.concatTypedArrays(response.cmd.slice(2), response.payload.slice(0, -2));
      return resp;
    } else {
      //this._utils.debugLog(this,  "**> hysen.send_request: Errorcode "+response.error + " in response")
      throw "**> hysen.send_request: error = " + response.error;
    }
  }

  /**
   * Get current room temperature in degrees celsius
   */
  async get_temperature(generation = this._hysenGeneration) {
    try {
      var payload = new Uint8Array([0x01, 0x03, 0x00, 0x00, 0x00, 0x08]);
      var response = await this.send_request(payload);
      if (!this._isHysenActive(generation)) return;

      //this._utils.debugLog(this, "==> hysen.get_temperature: " + this._utils.asHex(response))

      this.data["RoomTemperature"] = response[5] / 2.0;
      this.data["TargetTemperature"] = response[6] / 2.0;
      this.data["ExternalTemperature"] = response[18] / 2.0;

      await this._updateCapabilities(generation);
    } catch (err) {
      this._utils.debugLog(this, "**> hysen.get_temperature - catch = " + err);
    }
  }

  /**
   * Get full status (including timer schedule)
   */
  async get_full_status(generation = this._hysenGeneration) {
    try {
      var payload = new Uint8Array([0x01, 0x03, 0x00, 0x00, 0x00, 0x16]);
      var response = await this.send_request(payload);
      if (!this._isHysenActive(generation)) return;

      this._utils.debugLog(this, "==> hysen.get_full_status - " + this._utils.asHex(response));

      this.data["ParentalMode"] = response[3] & 1 ? true : false;
      this.data["power"] = response[4] & 1;
      this.data["active"] = (response[4] >> 4) & 1;
      this.data["temp_manual"] = (response[4] >> 6) & 1;
      this.data["RoomTemperature"] = response[5] / 2.0;
      this.data["TargetTemperature"] = response[6] / 2.0;
      // --------------------------------------------------------------------
      // ORIGINAL CODE:
      //
      // this.data["AutoMode"] = (response[7] & 15).toString();
      // this.data["LoopMode"] = ((response[7] >> 4) & 0x0F).toString();
      //
      let rawAutoMode = response[7] & 0x0f;
      // If device truly only supports manual=0 or auto=1, clamp to avoid invalid values.
      if (rawAutoMode > 1) {
        rawAutoMode = 1; // fallback to 'auto'
      }
      this.data["AutoMode"] = rawAutoMode.toString();

      let rawLoopMode = (response[7] >> 4) & 0x0f;
      // Settings allow "1", "2", or "3". Clamp out-of-range data:
      if (rawLoopMode < 1) rawLoopMode = 1;
      if (rawLoopMode > 3) rawLoopMode = 3;
      this.data["LoopMode"] = rawLoopMode.toString();
      // --------------------------------------------------------------------
      let sensorMode = response[8];
      if (sensorMode < SENSOR_MODE_MIN || sensorMode > SENSOR_MODE_MAX) {
        this._utils.debugLog(this, `hysen.get_full_status: clamping SensorMode ${sensorMode} to valid range`);
        sensorMode = Math.min(Math.max(sensorMode, SENSOR_MODE_MIN), SENSOR_MODE_MAX);
      }
      this.data["SensorMode"] = sensorMode.toString();
      this.data["TempRangeExtSensor"] = response[9];
      this.data["FloorTempDeadZone"] = response[10];
      this.data["SensorUpperLimit"] = response[11];
      this.data["SensorLowerLimit"] = response[12];
      let roomTempAdjust = (response[13] << 8) + response[14];
      if (roomTempAdjust > 32767) {
        roomTempAdjust = roomTempAdjust - 65536;
      }
      roomTempAdjust = roomTempAdjust / 2.0;
      if (roomTempAdjust < ROOM_TEMP_ADJUST_MIN || roomTempAdjust > ROOM_TEMP_ADJUST_MAX) {
        this._utils.debugLog(this, `hysen.get_full_status: clamping RoomTempAdjust ${roomTempAdjust} to valid range`);
        roomTempAdjust = Math.min(Math.max(roomTempAdjust, ROOM_TEMP_ADJUST_MIN), ROOM_TEMP_ADJUST_MAX);
      }
      this.data["RoomTempAdjust"] = roomTempAdjust;
      this.data["AntiFreezeMode"] = response[15].toString();
      this.data["poweron"] = response[16];
      //this.data['unknown'] = response[17];
      this.data["ExternalTemperature"] = response[18] / 2.0;
      //this.data['hour'] =  response[19];
      //this.data['min'] =  response[20];
      //this.data['sec'] =  response[21];
      //this.data['dayofweek'] =  response[22];

      let schedule = [];
      for (let i = 0; i < 8; i++) {
        schedule[i] = {};
      }
      for (let i = 0; i < 8; i++) {
        let h = response[2 * i + 23];
        let m = response[2 * i + 24];
        schedule[i]["time"] = (h < 10 ? "0" + h : h.toString()) + ":" + (m < 10 ? "0" + m : m.toString());
        schedule[i]["temp"] = response[i + 39] / 2.0;
      }
      this.data["schedule"] = schedule;

      await this._updateCapabilities(generation);
      if (this._isHysenActive(generation)) await this._updateAllSettings(generation);
    } catch (err) {
      this._utils.debugLog(this, "**> hysen.get_full_status - catch = " + err);
    }
  }

  /**
   * Change controller mode
   * AutoMode
   *              Manual mode will activate last used temperature.  In typical usage call set_target_temperature() to
   *              activate manual control and set temperature.
   *                 0 for manual mode
   *                 1 for auto (scheduled/timed) mode
   * LoopMode     Scheduling mode for days
   *                 index in [ "12345,67", "123456,7", "1234567" ]
   *                 1 ("12345,67") means Saturday and Sunday follow the "weekend" schedule
   *                 2 ("123456,7") means Saturday follows weekday and Sunday follows "weekend" schedule
   *                 3 ("1234567") means every day (including Saturday and Sunday) follows the "weekday" schedule
   * The sensor command is currently experimental
   */
  async set_mode(AutoMode, LoopMode, sensor) {
    try {
      if (sensor === undefined) {
        sensor = 0;
      }
      let mode_byte = (LoopMode << 4) + AutoMode;

      var payload = new Uint8Array([0x01, 0x06, 0x00, 0x02, mode_byte, sensor]);
      await this.send_request(payload);
    } catch (err) {
      this._utils.debugLog(this, "**> hysen.set_mode: catch = " + err);
      throw err;
    }
  }

  /**
   * Advanced settings
   * LoopMode     Scheduling mode for days
   *                 index in [ "12345,67", "123456,7", "1234567" ]
   *                 1 ("12345,67") means Saturday and Sunday follow the "weekend" schedule
   *                 2 ("123456,7") means Saturday follows weekday and Sunday follows "weekend" schedule
   *                 3 ("1234567") means every day (including Saturday and Sunday) follows the "weekday" schedule
   * AutoMode
   *              Manual mode will activate last used temperature.  In typical usage call set_target_temperature() to
   *              activate manual control and set temperature.
   *                 0 for manual mode
   *                 1 for auto (scheduled/timed) mode
   * SensorMode   Sensor mode (SEN)
   *                 0 for internal sensor,
   *                 1 for external sensor,
   *                 2 for internal control temperature, external limit temperature.
   *                 Factory default: 0.
   * TempRangeExtSensor
   *              Set temperature range for external sensor
   *                 TempRangeExtSensor = 5..99.
   *                 Factory default: 42C
   * FloorTempDeadZone
   *              Deadzone for floor temprature
   *                 dif = 1..9.
   *                 Factory default: 2C
   * SensorUpperLimit
   *              Upper temperature limit for internal sensor
   *                 SensorUpperLimit = 5..99.
   *                 Factory default: 35C
   * SensorLowerLimit
   *              Lower temperature limit for internal sensor
   *                 SensorLowerLimit = 5..99.
   *                 Factory default: 5C
   * RoomTempAdjust
   *              Actual temperature calibration
   *                 adj = -0.5.
   *                 Prescision 0.1C
   * AntiFreezeMode
   *              Anti-freezing function
   *                 0 for anti-freezing function shut down,
   *                 1 for anti-freezing function open.
   *                 Factory default: 0
   * poweron      Power on memory
   *                 0 for power on memory off,
   *                 1 for power on memory on.
   *                 Factory default: 0
   */
  async set_advanced(LoopMode, AutoMode, SensorMode, TempRangeExtSensor, FloorTempDeadZone, SensorUpperLimit, SensorLowerLimit, RoomTempAdjust, AntiFreezeMode, poweron) {
    try {
      RoomTempAdjust = RoomTempAdjust * 2;
      if (RoomTempAdjust < 0) {
        RoomTempAdjust = 65536 + RoomTempAdjust;
      }
      let payload = new Uint8Array([0x01, 0x10, 0x00, 0x02, 0x00, 0x05, 0x0a, (LoopMode << 4) + AutoMode, SensorMode, TempRangeExtSensor, FloorTempDeadZone, SensorUpperLimit, SensorLowerLimit, (RoomTempAdjust >> 8) & 0xff, RoomTempAdjust & 0xff, AntiFreezeMode, poweron]);

      await this.send_request(payload);
    } catch (err) {
      this._utils.debugLog(this, "**> hysen.set_advanced: catch = " + err);
      throw err;
    }
  }

  /**
   * Set temperature for manual mode (also activates manual mode if currently in automatic)
   */
  async set_target_temperature(temp) {
    try {
      let payload = new Uint8Array([0x01, 0x06, 0x00, 0x01, 0x00, temp * 2]);
      await this.send_request(payload);
    } catch (err) {
      this._utils.debugLog(this, "**> hysen.set_target_temperature: catch = " + err);
      throw err;
    }
  }

  /**
   * Set device on(1) or off(0), does not deactivate Wifi connectivity.
   * ParentalMode disables control by buttons on thermostat.
   */
  async set_power(power, ParentalMode) {
    try {
      let payload = new Uint8Array([0x01, 0x06, 0x00, 0x00, ParentalMode ? 1 : 0, power]);
      await this.send_request(payload);
    } catch (err) {
      this._utils.debugLog(this, "**> hysen.set_power: catch = " + err);
      throw err;
    }
  }

  /**
   * set time on device
   *
   * hour    [0..23]
   * minute  [0..59]
   * second  [0..59]
   * day     [1..7]   1 = Monday, 2 = Tuesday, ... , 7 = Sunday
   */
  async set_time(hour, minute, second, day) {
    try {
      let payload = new Uint8Array([0x01, 0x10, 0x00, 0x08, 0x00, 0x02, 0x04, hour, minute, second, day]);
      await this.send_request(payload);
    } catch (err) {
      this._utils.debugLog(this, "**> hysen.set_time: catch = " + err);
      throw err;
    }
  }

  /**
   * Set timer schedule
   * Format is the same as you get from get_full_status.
   * weekday is a list (ordered) of 6 dicts like:
   * {'time': "17:30", 'temp': 22 }
   * Each one specifies the thermostat temp that will become effective at 'time'
   * weekend is similar but only has 2 (e.g. switch on in morning and off in afternoon)
   *
   * schedule = array[0..7]['time' | 'temp']
   *                   where [x]['time] in format "00:00"
   * weekday = schedule[0..5]
   * weekend = schedule[6..7]
   */
  async set_schedule(schedule) {
    try {
      //this._utils.debugLog(this, "==> hysen.set_schedule")

      // Begin with some magic values ...
      let input_payload = new Uint8Array([0x01, 0x10, 0x00, 0x0a, 0x00, 0x0c, 0x18]);
      let payload = new Uint8Array(24);

      // times (format 'hh:mm'
      for (let i = 0; i < 8; i++) {
        payload[i * 2] = Number(schedule[i]["time"].substring(0, 2)); // hour
        payload[i * 2 + 1] = Number(schedule[i]["time"].substring(3, 5)); // minute
      }
      // temperatures
      for (let i = 0; i < 8; i++) {
        payload[i + 16] = schedule[i]["temp"] * 2;
      }

      await this.send_request(this._utils.concatTypedArrays(input_payload, payload));
    } catch (err) {
      this._utils.debugLog(this, "**> hysen.set_schedule: catch = " + err);
      throw err;
    }
  }

  async onCapabilityTargetTemperature(temp) {
    const generation = this._hysenGeneration;
    await this.set_target_temperature(temp);
    if (this._isHysenActive(generation)) this.data["TargetTemperature"] = temp;
  }

  async onCapabilityParentalMode(mode) {
    const generation = this._hysenGeneration;
    if (this.data["power"] !== 0 && this.data["power"] !== 1) {
      throw new Error("Thermostat power state is not available yet; retry after its first update");
    }
    const parentalMode = !!mode;
    await this.set_power(this.data["power"], parentalMode);
    if (!this._isHysenActive(generation)) return;
    this.data["ParentalMode"] = parentalMode;
    const changed = parentalMode !== this.getCapabilityValue("parental_mode");
    try {
      await this.setCapabilityValue("parental_mode", parentalMode);
    } catch (err) {
      this.error("Thermostat parental command acknowledged; Homey capability update failed", err);
    }
    if (changed && this._isHysenActive(generation)) await this._trigger_parentalmode(generation);
  }

  async onInit() {
    if (this._communicate) await this.onUninit();
    const generation = this._hysenGeneration = (this._hysenGeneration || 0) + 1;
    this._hysenStopped = false;
    try {
      if (await super.onInit() === false || this._localStopped) return false;
      if (!this._isHysenActive(generation)) return;
      this.data = {};
      this.registerCapabilityListener("target_temperature", this.onCapabilityTargetTemperature.bind(this));
      this.registerCapabilityListener("parental_mode", this.onCapabilityParentalMode.bind(this));

      // Initial data fetch after a 4-second delay
      this._startupTimeout = this.homey.setTimeout(
        async function () {
          if (!this._isHysenActive(generation)) return;
          this._startupTimeout = null;
          try {
            await this.get_full_status(generation);
            if (!this._isHysenActive(generation)) return;
            await this.get_temperature(generation);
            if (!this._isHysenActive(generation)) return;

            // Start periodic updates after initial fetch
            const checkInterval = this.getSettings().CheckInterval || 5; // Default to 5 minutes if not set
            this.start_check_interval(checkInterval);
          } catch (error) {
            this._utils.debugLog(this, "**> HysenDevice.onInit: catch = " + error);
          }
        }.bind(this),
        4000
      ); // timeout in [msec]
    } catch (error) {
      this._utils.debugLog(this, "**> HysenDevice.onInit: catch = " + error);
    }
  }

  /**
   * This method will be called when a device has been removed.
   */
  onDeleted() {
    return this.onUninit();
  }

  onUninit() {
    this._hysenStopped = true;
    this._hysenGeneration = (this._hysenGeneration || 0) + 1;
    if (this._startupTimeout != null) this.homey.clearTimeout(this._startupTimeout);
    if (this._clockResetTimeout != null) this.homey.clearTimeout(this._clockResetTimeout);
    this._startupTimeout = null;
    this._clockResetTimeout = null;
    this.data = undefined;
    return super.onUninit();
  }
}

module.exports = HysenDevice;
