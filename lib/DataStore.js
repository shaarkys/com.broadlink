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

const fs = require("fs");
const BroadlinkUtils = require("./../lib/BroadlinkUtils.js");

// Different DataStore instances can address the same command file.
const operations = new Map();

function copyCommands(commands) {
  if (!Array.isArray(commands) || commands.some(item => !item || !item.name || !item.cmd)) {
    throw new Error("Invalid command storage structure");
  }
  return commands.map(item => ({ name: item.name, cmd: new Uint8Array(Object.values(item.cmd)) }));
}

class DataStore {
  /**
   *
   * holds an Array with records:
   *    {
   *       name     [String]
   *       cmd      [Uint8Array]
   *    }
   *
   * Note: the 'name' is also stored in the device settings.
   * the Array and the Settings may have a different order of names.
   */

  /**
   * Class constructor, needed to define class-variables
   */

  constructor(storeName, homey) {
    this.dataArray = [];
    this._committedData = [];
    this.storeName = storeName;
    this._utils = new BroadlinkUtils(homey);
  }

  /**
   * @returns: -1 if not found, index-in-array otherwise
   */
  findCommand(cmdName) {
    for (var i = 0, len = this.dataArray.length; i < len; i++) {
      if (this.dataArray[i].name === cmdName) {
        return i;
      }
    }
    return -1;
  }

  /**
   * saveOnCloseEvent() is called during init and registeres the unload event. The unload
   * event is called just before the app is being closed (for instance when the app is updated,
   * homey is shutting down).
   */
  //saveOnCloseEvent() {
  //
  //   Homey.on( 'unload', function() {
  //      this._utils.debugLog(this, "unload called");
  //      this.storeCommands();
  //   });
  //}

  _fileName() { return `/userdata/${this.storeName}.json`; }

  _enqueue(action) {
    const fileName = this._fileName();
    const operation = (operations.get(fileName) || Promise.resolve()).then(action);
    const settled = operation.catch(() => {});
    operations.set(fileName, settled);
    settled.then(() => { if (operations.get(fileName) === settled) operations.delete(fileName); });
    return operation;
  }

  _publish(commands) {
    this._committedData = copyCommands(commands);
    this.dataArray = copyCommands(commands);
  }

  async _readStored() {
    let data;
    try { data = await fs.promises.readFile(this._fileName(), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return copyCommands(JSON.parse(data));
  }

  async _persist(commands) {
    const fileName = this._fileName();
    const tempFileName = `${fileName}.tmp`;
    const maxRetries = 3;
    const data = JSON.stringify(commands);
  
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Check if data is null, undefined, or an empty string
        if (!data || data === "null" || data === "undefined") {
          throw new Error("Data is null, undefined, or an empty string");
        }
  
        this._utils.debugLog(this, `Storing commands to temporary file: ${tempFileName} (Attempt ${attempt})`);
  
        // Write data to a temporary file
        await fs.promises.writeFile(tempFileName, data);
  
        // Validate the temporary file
        const tempFileData = await fs.promises.readFile(tempFileName, "utf8");
        const tempParsedData = JSON.parse(tempFileData);
  
        // Additional validation: Ensure structure matches expected format
        if (!Array.isArray(tempParsedData) || tempParsedData.some((item) => !item || !item.name || !item.cmd)) {
          throw new Error("Validation failed: Temporary file structure is invalid");
        }
  
        // Rename the temporary file to the target file
        await fs.promises.rename(tempFileName, fileName);
        this._utils.debugLog(this, `**> Data successfully stored <**`);
        return;
      } catch (err) {
        this._utils.debugLog(this, `**> Storing dataArray failed (Attempt ${attempt}): ${err}`);
        if (attempt === maxRetries) {
          throw new Error(`Failed to store commands after ${maxRetries} attempts: ${err}`);
        }
      }
    }
  }

  /**
   * saveUserData() saves the user data into a JSON file on the filesystem
   */
  async storeCommands() {
    let candidate;
    try { candidate = copyCommands(this.dataArray); }
    catch (error) { this.dataArray = copyCommands(this._committedData); throw error; }
    return this._enqueue(async () => {
      try {
        await this._persist(candidate);
        this._publish(candidate);
      } catch (error) {
        this.dataArray = copyCommands(this._committedData);
        throw error;
      }
    });
  }
 

  /**
   * @params callback    function called once all data has been read
   */
  async readCommands(callback) {
    await this._enqueue(async () => {
      const commands = await this._readStored();
      this._publish(commands);
    });
    // Callbacks may perform storage operations, so run them outside the queue.
    if (typeof callback === "function") await callback();
  }

  /**
   *
   */
  async deleteAllCommands() {
    return this._enqueue(async () => {
      try { await fs.promises.unlink(this._fileName()); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      this._publish([]);
      this._utils.debugLog(this, "Command storage deleted.");
    });
  }
  

  /**
   * @return: true if command stored, false otherwise
   */
  async addCommand(cmdName, data) {
    try {
      const command = copyCommands([{ name: cmdName, cmd: data }])[0];
      return await this._enqueue(async () => {
        const candidate = await this._readStored();
        if (candidate.some(item => item.name === cmdName)) { this._publish(candidate); return false; }
        candidate.push(command);
        await this._persist(candidate);
        this._publish(candidate);
        return true;
      });
    } catch (err) {
      this._utils.debugLog(this, `**> Failed to add command: ${err.message}`);
      return false;
    }
  }

  /**
   *
   */
  async deleteCommand(cmdName) {
    try {
      await this._enqueue(async () => {
        const commands = await this._readStored();
        // Filter out the command to be deleted
        const candidate = commands.filter(item => item.name !== cmdName);
        await this._persist(candidate);
        this._publish(candidate);
      });
    } catch (err) {
      // Log any errors
      this._utils.debugLog(this, `**> Failed to delete command: ${err.message}`);
      throw err;
    }
  }

  /**
   * @return: true if renamed, false otherwise
   */
  async renameCommand(oldName, newName) {
    try {
      return await this._enqueue(async () => {
        const candidate = await this._readStored();
        const element = candidate.findIndex(item => item.name === oldName);
        if (candidate.some(item => item.name === newName) || element < 0) { this._publish(candidate); return false; }
        candidate[element].name = newName;
        await this._persist(candidate);
        this._publish(candidate);
        return true;
      });
    } catch (err) {
      // Log any errors
      this._utils.debugLog(this, `**> Failed to rename command: ${err.message}`);
      return false;
    }
  }

  /**
   * @return {Uint8Array} commanddata
   */
  getCommandData(cmdName) {
    try {
      let element = this.findCommand(cmdName);
      if (element >= 0) {
        this._utils.debugLog(this, `Command data for ${cmdName} found.`);
        return this.dataArray[element].cmd;
      } else {
        this._utils.debugLog(this, `Command data for ${cmdName} not found.`);
        throw new Error(`Command ${cmdName} not found.`);
      }
    } catch (err) {
      this._utils.debugLog(this, `**> Error retrieving command data: ${err.message}`);
      throw err;
    }
  }
  

  /**
   * Get a list of the names of all commands
   */
  getCommandNameList() {
    try {
      const nameList = this.dataArray.map(item => item.name);
      this._utils.debugLog(this, `Command name list generated: ${nameList}`);
      return nameList;
    } catch (err) {
      this._utils.debugLog(this, `**> Error generating command name list: ${err.message}`);
      return [];
    }
  }
}

module.exports = DataStore;
