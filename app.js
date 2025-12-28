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
const { Device } = require("homey");
const DataStore = require("./lib/DataStore");
const BroadlinkUtils = require("./lib/BroadlinkUtils");

const DEBUG = process.env.DEBUG === "1";

// Capture the original method for setWarning to prevent errors : Not Found: Device with ID
const originalSetWarning = Device.prototype.setWarning;

Device.prototype.setWarning = async function (message) {
  try {
    await originalSetWarning.call(this, message);
  } catch (err) {
    this.log(`Suppressed setWarning error: ${err.message}`);
  }
};

/**
 * Main entry point for app.
 */
class BroadlinkApp extends Homey.App {
  async onInit() {
    this.log(`${this.id} is running...(debug mode ${DEBUG ? "on" : "off"})`);
    if (DEBUG) {
      require("inspector").open(9223, "0.0.0.0");
    }

    this.homey.on("memwarn", () => {
      // simply ignore it
    });

    this._utils = new BroadlinkUtils(this.homey);
    this._rfDevices = new Map(); // key: mac, value: device instance

    // Register settings-based RF manager bridge (works without App API endpoints)
    this.homey.settings.on("set", async (key) => {
      if (key !== "rfManagerAction") return;
      await this.handleRfManagerAction();
    });

    // Keep a snapshot of RF devices available for the settings UI.
    await this.updateRfDevicesSetting();

    // Optional: register App API routes if supported by this runtime
    this.registerApiRoutes(this.homey.api);
  }

  /**
   * Register an RF-capable device for API use.
   * @param {Homey.Device} device
   */
  registerRfDevice(device) {
    try {
      const data = device.getData();
      const mac = data?.mac;
      if (!mac) return;
      this._rfDevices.set(mac, device);
      this.updateRfDevicesSetting().catch((err) => this._utils.debugLog(null, `updateRfDevicesSetting failed: ${err}`));
    } catch (err) {
      this._utils.debugLog(null, `registerRfDevice failed: ${err}`);
    }
  }

  /**
   * Unregister a device (called on delete).
   * @param {Homey.Device} device
   */
  unregisterRfDevice(device) {
    try {
      const mac = device?.getData()?.mac;
      if (!mac) return;
      this._rfDevices.delete(mac);
      this.updateRfDevicesSetting().catch((err) => this._utils.debugLog(null, `updateRfDevicesSetting failed: ${err}`));
    } catch (err) {
      this._utils.debugLog(null, `unregisterRfDevice failed: ${err}`);
    }
  }

  /**
   * Get a list of RF-capable devices.
   */
  listRfDevices() {
    const devices = [];
    this._rfDevices.forEach((device, mac) => {
      try {
        devices.push({
          mac,
          id: device.getData()?.id,
          name: device.getName(),
          driverId: device.driver?.id || device.getDriver()?.id,
        });
      } catch (err) {
        this._utils.debugLog(null, `listRfDevices entry failed: ${err}`);
      }
    });
    return devices;
  }

  /**
   * Helper to get a datastore for a MAC address.
   * Prefers a live device instance but falls back to a fresh DataStore.
   */
  async getRfStore(mac) {
    const device = this._rfDevices.get(mac);
    if (device && device.dataStore) {
      // Ensure it's loaded
      if (!device.dataStore.dataArray.length) {
        await device.dataStore.readCommands();
      }
      return { dataStore: device.dataStore, device };
    }

    const dataStore = new DataStore(mac, this.homey);
    await dataStore.readCommands();
    return { dataStore, device: null };
  }

  registerApiRoutes(api) {
    if (!api) {
      this._logRfManagerDebug("App API not available; RF command manager is using settings storage");
      return false;
    }

    const register = (registerName, path, handler) => {
      if (!api || typeof api[registerName] !== "function") {
        return false;
      }
      try {
        const result = api[registerName](path, handler);
        // Some SDK versions return a promise here; guard against unhandled rejections
        if (result && typeof result.catch === "function") {
          result.catch((err) => this._utils.debugLog(null, `API registration failed for ${registerName} ${path}: ${err}`));
        }
        return true;
      } catch (err) {
        this._utils.debugLog(null, `API registration failed for ${registerName} ${path}: ${err}`);
        return false;
      }
    };

    const ok =
      register("registerGet", "/rf/devices", async (req, res) => {
        try {
          res.json({ devices: this.listRfDevices() });
        } catch (err) {
          this._utils.debugLog(null, `GET /rf/devices failed: ${err}`);
          res.status(500).json({ error: "Failed to list devices" });
        }
      }) &&
      register("registerGet", "/rf/devices/:mac/commands", async (req, res) => {
        try {
          const mac = req.params.mac;
          const { dataStore } = await this.getRfStore(mac);
          res.json({ mac, commands: dataStore.getCommandNameList(), count: dataStore.dataArray.length });
        } catch (err) {
          this._utils.debugLog(null, `GET /rf/devices/:mac/commands failed: ${err}`);
          res.status(500).json({ error: "Failed to list commands" });
        }
      }) &&
      register("registerPost", "/rf/devices/:mac/commands/rename", async (req, res) => {
        try {
          const mac = req.params.mac;
          const { oldName, newName } = req.body || {};
          if (!oldName || !newName) {
            return res.status(400).json({ error: "oldName and newName are required" });
          }
          const { dataStore, device } = await this.getRfStore(mac);
          if (dataStore.findCommand(newName) >= 0) {
            return res.status(400).json({ error: "A command with the new name already exists" });
          }
          const renamed = await dataStore.renameCommand(oldName, newName);
          if (!renamed) {
            return res.status(404).json({ error: "Command not found" });
          }
          // Keep legacy settings in sync for backward compatibility
          if (device && typeof device.updateSettings === "function") {
            device.updateSettings();
          }
          res.json({ mac, oldName, newName });
        } catch (err) {
          this._utils.debugLog(null, `POST /rf/devices/:mac/commands/rename failed: ${err}`);
          res.status(500).json({ error: "Failed to rename command" });
        }
      }) &&
      register("registerDelete", "/rf/devices/:mac/commands/:cmdName", async (req, res) => {
        try {
          const mac = req.params.mac;
          const cmdName = req.params.cmdName;
          if (!cmdName) {
            return res.status(400).json({ error: "Command name is required" });
          }
          const { dataStore, device } = await this.getRfStore(mac);
          await dataStore.deleteCommand(cmdName);
          if (device && typeof device.updateSettings === "function") {
            device.updateSettings();
          }
          res.json({ mac, deleted: cmdName });
        } catch (err) {
          this._utils.debugLog(null, `DELETE /rf/devices/:mac/commands/:cmdName failed: ${err}`);
          res.status(500).json({ error: "Failed to delete command" });
        }
      });

    if (!ok) {
    }

    return ok;
  }

  async updateRfDevicesSetting() {
    const devices = this.listRfDevices();
    await this.homey.settings.set("rfDevices", devices);
  }

  async updateRfCommandsSetting(mac) {
    if (!mac) return;
    const { dataStore } = await this.getRfStore(mac);
    const commands = dataStore.getCommandNameList();
    await this.homey.settings.set(`rfCommands_${mac}`, commands);
  }

  async handleRfManagerAction() {
    const action = this.homey.settings.get("rfManagerAction");
    if (!action || !action.type) return;

    const result = {
      requestId: action.requestId || `${Date.now()}`,
      type: action.type,
      mac: action.mac || "",
      ok: false,
      ts: Date.now(),
    };

    try {
      switch (action.type) {
        case "refreshDevices":
          await this.updateRfDevicesSetting();
          result.ok = true;
          break;
        case "refreshCommands":
          await this.updateRfCommandsSetting(action.mac);
          result.ok = true;
          break;
        case "renameCommand": {
          const { mac, oldName, newName } = action;
          if (!mac || !oldName || !newName) {
            throw new Error("mac, oldName and newName are required");
          }
          const { dataStore, device } = await this.getRfStore(mac);
          if (dataStore.findCommand(newName) >= 0) {
            throw new Error("A command with the new name already exists");
          }
          const renamed = await dataStore.renameCommand(oldName, newName);
          if (!renamed) {
            throw new Error("Command not found");
          }
          if (device && typeof device.updateSettings === "function") {
            device.updateSettings();
          }
          await this.updateRfCommandsSetting(mac);
          result.ok = true;
          break;
        }
        case "deleteCommand": {
          const { mac, cmdName } = action;
          if (!mac || !cmdName) {
            throw new Error("mac and cmdName are required");
          }
          const { dataStore, device } = await this.getRfStore(mac);
          await dataStore.deleteCommand(cmdName);
          if (device && typeof device.updateSettings === "function") {
            device.updateSettings();
          }
          await this.updateRfCommandsSetting(mac);
          result.ok = true;
          break;
        }
        default:
          throw new Error(`Unsupported action: ${action.type}`);
      }
    } catch (err) {
      result.error = err.message || String(err);
    }

    await this.homey.settings.set("rfManagerResult", result);
  }

}

module.exports = BroadlinkApp;
