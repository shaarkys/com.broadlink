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

//const Log = require('homey-log').Log;
const DeviceInfo = require("./DeviceInfo");

/*
 * homey-log sends error reports to Sentry.IO
 * in env.js its DSN is defined.
 * log in to Sentry.IO with your github account to view the events.
 */

class BroadlinkUtils {
  constructor(homey) {
    this.homey = homey;
  }

  epochToTimeFormatter(epoch) {
    if (epoch == null) epoch = new Date().getTime();
    return new Date(epoch).toTimeString().replace(/.*(\d{2}:\d{2}:\d{2}).*/, "$1");
  }

  concatTypedArrays(a, b) {
    if (!a || !b) {
      this.debugLog(null, "Invalid array inputs for concatenation", { a, b });
    }
    var c = new a.constructor(a.length + b.length);
    c.set(a, 0);
    c.set(b, a.length);
    return c;
  }

  hexDigit(b) {
    const nibble = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A", "B", "C", "D", "E", "F"];
    let l = b & 0x0f;
    let h = (b >> 4) & 0x0f;
    return "" + nibble[h] + nibble[l];
  }

  /**
   *  Convert an Array (might be typed) to a human reabable string,
   *  where each byte is separated by a comma
   */
  asHex(arr, separator) {
    if (!arr) {
      this.debugLog(null, "Invalid array input for hex conversion", arr);
    }
    if (separator == null) {
      separator = ",";
    }
    var s = Array(arr.length);
    for (var i = 0; i < arr.length; i++) {
      s[i] = this.hexDigit(arr[i]);
    }
    return Array.apply([], s).join(separator);
  }

  /**
   *  Convert an Array (might be typed) to a string,
   *  without any separation characters
   */
  arrToHex(arr) {
    if (arr == null) { 
      //this.debugLog(null, "Invalid array input for hex conversion", arr);
      return "";
    }
    var s = Array(arr.length);
    for (var i = 0; i < arr.length; i++) {
      s[i] = this.hexDigit(arr[i]);
    }
    return Array.apply([], s).join("");
  }

  /**
   * Convert a string with hex-representation to a
   * typed array with bytes.
   * example:  hexToArr( '12A4F0D8' ) -> Uint8Array([ 0x12, 0xA4, 0xF0, 0xD8 ])
   */
  hexToArr(str) {
    if (str == null) { 
      //this.debugLog(null, "Invalid string input for array conversion", str);
      return null;
    }
    for (var bytes = [], c = 0; c < str.length; c += 2) {
      bytes.push(parseInt(str.slice(c, c + 2), 16));
    }
    return new Uint8Array(bytes);
  }

  /**
   * Gets the IP address of this Homey (i.e. our own IP address)
   *
   * return: [Promise]
   *         from Promise, return IP address
   */
  async getHomeyIp() {
    try {
      return await this.homey.cloud.getLocalAddress();
    } catch (error) {
      this.debugLog(null, "Error getting Homey IP address", error);
      throw error;
    }
  }

  debugLog(device, message, data) {
    // Calculate deviceType in hexadecimal format
    const deviceType =
      device && typeof device.getData === "function" ? `0x${parseInt(device.getData().devtype, 10).toString(16)}` : "Unknown";

    const deviceDetails =
      device && typeof device.getData === "function" ? `${device.getData().name} (Type: ${deviceType})` : "Broadlink";

    const logMessage = `[${deviceDetails}] ${message}`;

    // Temporarily enable logging for all installations
    console.log(`${this.epochToTimeFormatter()} ${logMessage}`, data || "");

    // Check if the 'homey' and 'settings' are available in the device context
    // if (device && device.homey && device.homey.settings) {
    //     const settings = device.homey.settings.get('DebugSettings');
    //     if (settings && settings['logging']) {
    //         console.log(`${this.epochToTimeFormatter()} ${logMessage}`, data || '');
    //     }
    //     if (settings && settings['errorreport']) {
    //         Log.captureMessage(`${logMessage} ${data || ''}`);
    //     }
    // } else {
    //     // Fallback logging if settings are not available
    //     console.log(`${this.epochToTimeFormatter()} ${logMessage}`, data || '');
    // }
  }

  getDeviceInfo(founddevID, expectedType) {
    var foundInfo = DeviceInfo.devType2Info(founddevID);
  
    if (foundInfo.type == expectedType) {
      foundInfo.isCompatible = true;
    }
  
    let s = this.homey.settings.get("DebugSettings");
    if (s && s["compat"]) {
      foundInfo.isCompatible = true;
    }
    this.debugLog(
      null, 
      "getDeviceInfo: found = 0x" +
        founddevID.toString(16) +
        "  expectedType = " +
        expectedType +
        "  isComp = " +
        foundInfo.isCompatible
    );
    return foundInfo;
  }
}

module.exports = BroadlinkUtils;
