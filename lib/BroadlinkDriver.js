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

class BroadlinkDriver extends Homey.Driver {
  constructor(...props) {
    super(...props);
    this._utils = new BroadlinkUtils(this.homey);
  }

  /**
   * Method that will be called when a driver is initialized.
   * @param options {Object}.CompatibilityID
   */
  onInit(options) {
    if (options) {
      this.CompatibilityID = options.CompatibilityID;
    }
    // list of devices discovered during pairing
    this.discoveredDevice = undefined;
  }

  /**
   * Set the CompatibilityID for this device
   */
  setCompatibilityID(id) {
    this.CompatibilityID = id;
  }

  /**
   * Handles the backend of the pairing sequence.
   * Communication to the frontend is done via events => socket.emit('x')
   *
   */
  onPair(session) {
    // Initialize session-specific variables
    session.discoveredDevice = undefined;
    session._communicate = new Communicate();
    session._isConnected = true;

    const safeEmit = (event, payload) => {
      if (!session._isConnected) {
        this._utils.debugLog(this, `Pair session inactive; skip emit: ${event}`);
        return;
      }
      try {
        session.emit(event, payload);
      } catch (err) {
        this._utils.debugLog(this, `Pair session emit failed (${event}): ${err.message}`);
      }
    };

    // Configure communication options
    const commOptions = {
      ipAddress: null,
      mac: null,
      id: null,
      count: Math.floor(Math.random() * 0xffff),
      key: null,
      homey: this.homey,
    };
    session._communicate.configure(commOptions);

    // Handle session disconnect
    session.setHandler("disconnect", async () => {
      try {
        this._utils.debugLog(this, "Pair session disconnected");
        session._isConnected = false;
        if (session._communicate) {
          session._communicate.destroy();
          session._communicate = undefined;
        }
        session.discoveredDevice = undefined;
      } catch (err) {
        this._utils.debugLog(this, `Error during disconnect: ${err.message}`);
      }
    });

    session.setHandler("start_discover", async (data) => {
      session.discoveredDevice = undefined;
      this._utils.debugLog(this, "**>onPair.start_discover: " + JSON.stringify(data));

      if (!session._isConnected) {
        this._utils.debugLog(this, "**>onPair.start_discover: session not connected");
        return;
      }
      if (!session._communicate) {
        this._utils.debugLog(this, "**>onPair.start_discover: communicate not available");
        safeEmit("discovered", null);
        return;
      }

      try {
        let localAddress = await this._utils.getHomeyIp();
        // Retain original port removal logic
        let i = localAddress.indexOf(":");
        if (i > 0) {
          localAddress = localAddress.slice(0, i);
        }
        this._utils.debugLog(this, "**>onPair.localAddress: " + localAddress);

        const info = await session._communicate.discover(5, localAddress, data.address);
        this._utils.debugLog(this, "**>onPair.resolved: " + JSON.stringify(info));

        const devinfo = this._utils.getDeviceInfo(info.devtype, this.CompatibilityID);
        this._utils.debugLog(this, "**>onPair.resolved deviceinfo: " + JSON.stringify(devinfo));

        const readableMac = this._utils.asHex(info.mac.reverse(), ":");
        this._utils.debugLog(this, "**>onPair.resolved readableMac: " + readableMac);

        session.discoveredDevice = {
          device: {
            name: `${devinfo.name} (${readableMac})`,
            data: {
              name: devinfo.name,
              mac: this._utils.arrToHex(info.mac),
              devtype: info.devtype.toString(),
            },
            settings: {
              ipAddress: info.ipAddress,
            },
          },
          isCompatible: devinfo.isCompatible,
          typeName: info.devtype.toString(16).toUpperCase(),
        };

        this._utils.debugLog(this, "**>onPair.resolved discoveredDevice: " + JSON.stringify(session.discoveredDevice));
        safeEmit("discovered", session.discoveredDevice);
      } catch (err) {
        this._utils.debugLog(this, `**>onPair.error during discovery: ${err.message}`);
        safeEmit("discovered", null);
      }
    });

    session.setHandler("list_devices", async () => {
      if (!session.discoveredDevice) {
        this._utils.debugLog(this, "==>Broadlink - list_devices: No device discovered");
        return [];
      }

      const devices = [
        {
          name: session.discoveredDevice.device.name,
          data: {
            id: session.discoveredDevice.device.data.mac,
            isCompatible: session.discoveredDevice.isCompatible,
            typeName: session.discoveredDevice.typeName,
            ...session.discoveredDevice.device.data,
          },
          settings: session.discoveredDevice.device.settings,
        },
      ];

      this._utils.debugLog(this, "==>Broadlink - list_devices: " + JSON.stringify(devices));
      return devices;
    });
  }
}

module.exports = BroadlinkDriver;
