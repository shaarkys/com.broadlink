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

const dgram = require("dgram");
const crypto = require("crypto");
const BroadlinkUtils = require("./BroadlinkUtils.js");
const MAX_LOG_LENGTH = 500; // Maximum length of the logged response

class Communicate {
  /**
   * options = { count: this.count,			// integer
   *			mac:   this.mac,				// Uint8Array[6]
   *			ipAddress: this.ipAddress		// string: '123.123.123.123'
   *
   *			key: this.key   // might be null // Uint8Array[16]
   *			id:  this.id	// might be null // Uint8Array[4]
   *		}
   *
   *  Note: all options (except 'count') are strings
   */
  configure(options) {
    this.count = options.count;
    this.deviceType = options.deviceType;

    // Get the homey instance and store it in the utils class
    this._utils = new BroadlinkUtils(options.homey);

    // Also set the homey instance to this class as a property
    this.homey = options.homey;

    if (options.ipAddress) {
      this.ipAddress = options.ipAddress;
    } else {
      this.ipAddress = "255.255.255.255";
    }

    if (options.id) {
      this.id = options.id;
    } else {
      this.id = new Uint8Array([0, 0, 0, 0]);
    }

    if (options.mac) {
      this.mac = options.mac;
    } else {
      this.mac = new Uint8Array([0, 0, 0, 0, 0, 0]);
    }
    if (options.key && options.key.length == 16) {
      this.key = options.key;
    } else {
      this.key = new Uint8Array([0x09, 0x76, 0x28, 0x34, 0x3f, 0xe9, 0x9e, 0x23, 0x76, 0x5c, 0x15, 0x13, 0xac, 0xcf, 0x8b, 0x02]);
    }
    this.iv = new Uint8Array([0x56, 0x2e, 0x17, 0x99, 0x6d, 0x09, 0x3d, 0x28, 0xdd, 0xb3, 0xba, 0x69, 0x5a, 0x2e, 0x6f, 0x58]);
    this.checkRepeatCount = 0;
  }

  /**
   * Update the IPaddress.
   */
  setIPaddress(address) {
    this.ipAddress = address;
    this._utils.debugLog(this, `IP Address updated to: ${this.ipAddress}`);
  }

  /**
   *
   */
  destroy() {
    if (this.dgramSocket !== undefined) {
      clearTimeout(this.tm);
      this.tm = undefined;
      this.dgramSocket.close();
      this.dgramSocket = undefined;
      this.callback = null;
    }
  }

  /**
   *
   * @return [Promise]
   */
  async sendto(packet, ipaddress, port, timeout) {
    if (this.dgramSocket === undefined) {
      this._utils.debugLog(this, "==> Communicate.sendto - create socket");
      this.callback = { resolve: null, reject: null };
      this.dgramSocket = dgram.createSocket("udp4");

      this.dgramSocket.on("error", (err) => {
        this._utils.debugLog(this, "**> dgramSocket error" + err);
        clearTimeout(this.tm);
        this.tm = undefined;
        this.callback.reject(Error(err.stack));
      });

      this.dgramSocket.on("message", (msg, rinfo) => {
        clearTimeout(this.tm);
        this.tm = undefined;
        let rsp = {
          data: msg, // msg is type Buffer
          size: rinfo.size,
          address: rinfo.address,
          port: rinfo.port,
        };
        this._utils.debugLog(this, "<== Communicate.sendto - got message with size=" + rsp["size"]);
        this.callback.resolve(rsp);
      });
    }

    return new Promise(
      function (resolve, reject) {
        this.callback.reject = reject;
        this.callback.resolve = resolve;
        this.dgramSocket.send(packet, port, ipaddress);
        const hexData = this._utils.asHex(packet); // Convert packet to HEX
        this._utils.debugLog(this, `==> Communicate.sendto - send packet to ${ipaddress}:${port}. Data: ${hexData}`);
        
        this.tm = setTimeout(
          function () {
            clearTimeout(this.tm);
            this.tm = undefined;
            this._utils.debugLog(this, "**> dgramSocket timeout");
            if (this.dgramSocket !== undefined) {
              this.dgramSocket.close();
              this.dgramSocket = undefined;
            }
            reject(Error(this.homey.__("errors.sending timeout")));
          }.bind(this),
          timeout * 1000
        ); // timeout in [msec]
      }.bind(this)
    );
  }

  /**
   *
   * @return [Buffer] with response message
   */
  async send_packet(command, version, payload) {
    this._utils.debugLog(this, "->send_packet: payload=" + this._utils.asHex(payload));

    this.count = (this.count + 1) & 0xffff;
    let packet = new Uint8Array(0x38);
    packet[0x00] = 0x5a;
    packet[0x01] = 0xa5;
    packet[0x02] = 0xaa;
    packet[0x03] = 0x55;
    packet[0x04] = 0x5a;
    packet[0x05] = 0xa5;
    packet[0x06] = 0xaa;
    packet[0x07] = 0x55;
    // Based pm https://github.com/kiwi-cam/broadlinkjs-rm/blob/master/index.js#L406-L407
    //packet[0x24] = version ? 0x9d : 0x2a;
    //packet[0x25] = 0x27;
    packet[0x24] = this.deviceType & 0xff
    packet[0x25] = this.deviceType >> 8
    packet[0x26] = command;
    packet[0x28] = this.count & 0xff;
    packet[0x29] = this.count >> 8;
    // https://github.com/kiwi-cam/broadlinkjs-rm/commit/5fdb5ed5988080f2774385e75b1477871420dad7
    // check, test !!!! Is it inline with other implementations ?
    packet[0x2a] = this.mac[5];
    packet[0x2b] = this.mac[4];
    packet[0x2c] = this.mac[3];
    packet[0x2d] = this.mac[2];
    packet[0x2e] = this.mac[1];
    packet[0x2f] = this.mac[0];
    packet[0x30] = this.id[0];
    packet[0x31] = this.id[1];
    packet[0x32] = this.id[2];
    packet[0x33] = this.id[3];
 

    // pad the payload for AES encryption, should be in in multiples of 16 bytes
    if (payload.length > 0) {
      var numpad = (Math.trunc(payload.length / 16) + 1) * 16 - payload.length;
      payload = this._utils.concatTypedArrays(payload, new Uint8Array(numpad));
    }

    // calculate the checksum over the payload
    let checksum = 0xbeaf;
    let i = 0;
    for (i = 0; i < payload.length; i++) {
      checksum = checksum + payload[i];
      checksum = checksum & 0xffff;
    }

    // add checksum of payload to header
    packet[0x34] = checksum & 0xff;
    packet[0x35] = checksum >> 8;

    // encrypt payload
    payload = this.encrypt(payload);

    // concatinate header and payload
    packet = this._utils.concatTypedArrays(packet, payload);

    // calculate checksum of entire packet, add to header
    checksum = 0xbeaf;
    for (i = 0; i < packet.length; i++) {
      checksum += packet[i];
      checksum = checksum & 0xffff;
    }
    packet[0x20] = checksum & 0xff;
    packet[0x21] = checksum >> 8;

    // send packet with a single retry after 5 seconds
    let response;
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        response = await this.sendto(packet, this.ipAddress, 80, 20);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        this._utils.debugLog(this, `send_packet attempt ${attempt} error: ${message}`);
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }
    }
    if (lastError) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      return {
        error: -1,
        message,
        data: null,
        payload: null,
        cmd: null,
      };
    }

    if (response && response.data) {
      const responseHex = this._utils.asHex(response.data);
      this._utils.debugLog(
        this,
        "->send_packet - response= " +
          (responseHex.length > MAX_LOG_LENGTH ? responseHex.substring(0, MAX_LOG_LENGTH) + "..." : responseHex)
      );
    }

    if (response) {
      response.error = response.data[0x22] | (response.data[0x23] << 8);
      if (response.error == 0) {
        this._utils.debugLog(this, " No error received, error code : " + response.error);
        let r = this.decrypt(response.data.slice(0x38)); // remove 0x38 bytes from start of array, then decrypt
        response.cmd = r.slice(0, 4); // get first 4 bytes in array
        response.payload = r.slice(0x04); // remove first 4 bytes of array

        this._utils.debugLog(
          this,
          "<-send_packet: payload =" +
            this.ipAddress +
            ": cmd :" +
            (this._utils.asHex(response.cmd).length > MAX_LOG_LENGTH
              ? this._utils.asHex(response.cmd).substring(0, MAX_LOG_LENGTH) + "..."
              : this._utils.asHex(response.cmd)) +
            ":" +
            " resp " +
            (this._utils.asHex(response.payload).length > MAX_LOG_LENGTH
              ? this._utils.asHex(response.payload).substring(0, MAX_LOG_LENGTH) + "..."
              : this._utils.asHex(response.payload))
        );
      }
    } else {
      this._utils.debugLog(this, " We got error = " + (response ? response.error : "no response"));
      response = response || {};
      response.error = -1;
    }

    return response;
  }

  /**
   * Encrypt data with AES, 128 bits, in CBC mode.
   * Use previously configured key and iv (Initial Vector).
   *
   * @return [Buffer]
   */
  encrypt(payload) {
    var encipher = crypto.createCipheriv("aes-128-cbc", this.key, this.iv);
    let encryptdata = encipher.update(payload, "binary", "binary");
    let encode_encryptdata = new Buffer.from(encryptdata, "binary");

    return encode_encryptdata;
  }

  /**
   * Decrypt data with AES, 128 bits, in CBC mode.
   * Use previously configured key and iv (Initial Vector).
   *
   * @return [Buffer]
   */
  decrypt(payload) {
    var decipher = crypto.createDecipheriv("aes-128-cbc", this.key, this.iv);
    decipher.setAutoPadding(false);
    var decoded = [];

    for (var i = 0; i < payload.length; i += 16) {
      decoded += decipher.update(payload.slice(i, i + 16), "binary", "binary");
    }
    decoded += decipher.final("binary");
    var result = new Uint8Array(new Buffer.from(decoded, "binary"));

    return result;
  }

  /**
   * Authenticate device.
   * - encrypt/decrypt keys are default ones.
   * - from response, the encrypt/decrypt keys for further communication can be retrieved.
   *
   * @return  key and id
   */
  async auth() {
    var payload = new Uint8Array(0x50);
    payload[0x04] = 0x31;
    payload[0x05] = 0x31;
    payload[0x06] = 0x31;
    payload[0x07] = 0x31;
    payload[0x08] = 0x31;
    payload[0x09] = 0x31;
    payload[0x0a] = 0x31;
    payload[0x0b] = 0x31;
    payload[0x0c] = 0x31;
    payload[0x0d] = 0x31;
    payload[0x0e] = 0x31;
    payload[0x0f] = 0x31;
    payload[0x10] = 0x31;
    payload[0x11] = 0x31;
    payload[0x12] = 0x31;
    payload[0x1e] = 0x01;
    payload[0x2d] = 0x01;
    payload[0x30] = "T".charCodeAt();
    payload[0x31] = "e".charCodeAt();
    payload[0x32] = "s".charCodeAt();
    payload[0x33] = "t".charCodeAt();
    payload[0x34] = " ".charCodeAt();
    payload[0x35] = " ".charCodeAt();
    payload[0x36] = "1".charCodeAt();

    let response = await this.send_packet(0x65, false, payload);
    if (!response || !response.payload) {
      this._utils.debugLog(this, "**> auth: decrypt payload error");
      throw new Error(this.homey.__("errors.decrypt_payload"));
    }

    var key = response.payload.slice(0, 0x10); // get at most 16 bytes
    if (key.length % 16 != 0) {
      this._utils.debugLog(this, "**> auth: keylength error");
      throw new Error(this.homey.__("errors.decrypt_keylength") + key.length);
    }
    var id = response.cmd;
    this.id = id;
    this.key = key;
    let authData = {
      id: id,
      key: key,
    };
    // Format the authentication data manually for logging
    const authDataFormatted = {
      id: Array.from(this.id)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      key: Array.from(this.key)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    };

    this._utils.debugLog(this, `<== auth: auth data : id: ${authDataFormatted.id}, key: ${authDataFormatted.key}`);

    return authData;
  }

  /**
   * Get day-of-week, where Monday=1 and Sunday=7
   */
  getIsoWeekday(dateObj) {
    let wd = dateObj.getDay();
    if (wd == 0) wd = 7; // Sunday should be '7'
    return wd;
  }

  /**
   * Discover a Broadlink device.
   * Either an IP address of the device is given, or the broadcast address is used.
   * Note that for a broadcast address, multiple devices might be discovered.
   *
   *
   * input: timeout in [sec]
   *		local_ip_address  null or string
   *		device_ip_address null or string
   *
   */
  async discover(timeout, local_ip_address, device_ip_address) {
    if (local_ip_address == null) {
      throw new Error(this.homey.__("errors.discover_local_ip"));
    }

    // if not given, use broadcast address
    if (device_ip_address == null) {
      device_ip_address = "255.255.255.255";
    }

    //this._utils.debugLog(this, "\n****\n****  OVERRIDE IP ADDRESS IN DISCOVER\n****")
    //local_ip_address = "192.168.0.40"

    var port = 44488; // any random port will do.

    // convert to array
    var address = local_ip_address.split(".");

    var packet = new Uint8Array(0x30);
    var d = new Date();

    // get timezone offset without DaylightSavingTime
    let jan = new Date(d.getFullYear(), 0, 1); // Date of 1-jan of this year
    var timezone = jan.getTimezoneOffset() / -60; // timezone in hours difference, without DST

    var year = d.getFullYear();

    if (timezone < 0) {
      packet[0x08] = 0xff + timezone - 1;
      packet[0x09] = 0xff;
      packet[0x0a] = 0xff;
      packet[0x0b] = 0xff;
    } else {
      packet[0x08] = timezone;
      packet[0x09] = 0;
      packet[0x0a] = 0;
      packet[0x0b] = 0;
    }
    packet[0x0c] = year & 0xff;
    packet[0x0d] = (year >> 8) & 0xff;
    packet[0x0e] = d.getMinutes();
    packet[0x0f] = d.getHours();
    packet[0x10] = Number(year % 100);
    packet[0x11] = this.getIsoWeekday(d);
    packet[0x12] = d.getDate();
    packet[0x13] = d.getMonth() + 1;
    packet[0x18] = Number(address[0]);
    packet[0x19] = Number(address[1]);
    packet[0x1a] = Number(address[2]);
    packet[0x1b] = Number(address[3]);
    packet[0x1c] = port & 0xff;
    packet[0x1d] = port >> 8;
    packet[0x26] = 6;

    // calculate checksum over header
    var checksum = 0xbeaf;
    let i = 0;
    for (i = 0; i < 0x30; i++) {
      checksum = checksum + packet[i];
    }
    checksum = checksum & 0xffff;

    // add checksum to header
    packet[0x20] = checksum & 0xff;
    packet[0x21] = (checksum >> 8) & 0xff;

    let response = await this.sendto(packet, device_ip_address, 80, timeout);
    let info = {
      ipAddress: response.address,
      mac: response.data.slice(0x3a, 0x3a + 6),
      devtype: response.data[0x34] | (response.data[0x35] << 8),
    };

    return info;
  }

  /**
   * Set device in learning mode.
   * After this, user can press a button on an IR remote.
   * Then, use check_IR_data() to read the sampled-data.
   */
  async enter_learning() {
    this._utils.debugLog(this, ">> Entering IR learning (default) <<");
    var payload = new Uint8Array(16);
    payload[0] = 3;
    await this.send_packet(0x6a, false, payload);
  }

  async enter_learning_red() {
    this._utils.debugLog(this, ">> IR learning, Red Bean or RM4 Mini and Pro <<");
    var payload = new Uint8Array(16);
    payload[0] = 4;
    payload[1] = 0;
    payload[2] = 3;
    await this.send_packet(0x6a, false, payload);
  }

  /**
   *
   */
  async _check_data(payload) {
    this.checkRepeatCount = 8;

    return new Promise(
      function (resolve, reject) {
        let tm = setInterval(
          function () {
            this._utils.debugLog(this, "_check_data - repeat=" + this.checkRepeatCount);
            this.send_packet(0x6a, false, payload)
              .then(
                function (response) {
                  if (response.error == 0) {
                    clearInterval(tm);
                    tm = null;
                    this._utils.debugLog(this, "**> _check_data resp = " + this._utils.asHex(response.payload));
                    resolve(response.payload);
                  } else {
                    this.checkRepeatCount = this.checkRepeatCount - 1;
                    if (this.checkRepeatCount <= 0) {
                      clearInterval(tm);
                      tm = null;
                      reject("tried long enough");
                    }
                  }
                }.bind(this),
                (rejection) => {
                  this._utils.debugLog(this, "**> _check_data - reject: " + rejection);
                  clearInterval(tm);
                  tm = null;
                  reject("aborted");
                }
              )
              .catch((err) => {
                this._utils.debugLog(this, "**> _check_data - catch: " + err);
                clearInterval(tm);
                tm = null;
                reject(err);
              });
          }.bind(this),
          2000
        ); // timeout in [msec]
      }.bind(this)
    );
  }

  // used for RM3 and RM3 Red bean only at this moment
  async check_IR_data() {
    var payload;
    if (this.deviceType == 0x5f36) {
      // RM Mini 3 Red Bean device type
      payload = new Uint8Array(16);
      payload[1] = 0;
      payload[2] = 4;
      this._utils.debugLog(this, `Modified payload, device RM3 Red Bean 0x5f36: `, this.deviceType);
    } else {
      this._utils.debugLog(this, `Classic RM3 legacy device (0x4):`, this.deviceType);
      payload = new Uint8Array(16);
      payload[0] = 4;
    }
    return await this._check_data(payload);
  }

  async check_IR_data_red() {
    this._utils.debugLog(this, `Modified payload, device Red Bean or RM4 (0x4,0x0,0x4): `, this.deviceType);
    var payload = new Uint8Array(16);
    payload[0] = 4;
    payload[1] = 0;
    payload[2] = 4; // Adjust the payload values as needed for RM4 Mini

    const response = await this._check_data(payload);

    // Adjust response data for RM4 devices by removing the first 2 bytes
    const adjustedResponse = response.slice(2);
    this._utils.debugLog(this, `Adjusted response data: ${this._utils.asHex(adjustedResponse)}`);

    return adjustedResponse;
  }

  async check_IR_data_rm4mini() {
    this._utils.debugLog(this, `Device RM4 Mini (0x4,0x0,0x4): `, this.deviceType);
    var payload = new Uint8Array(16);
    payload[0] = 4;
    payload[1] = 0;
    payload[2] = 4; // Adjust the payload values as needed for RM4 Mini
    return await this._check_data(payload);
  }

  /**
   * Method to check temperature for RM4 Pro
   */
  async checkTempHumidity_rm4pro() {
    this._utils.debugLog(this, `>>> Checking temperature and humidity <<<`);
    var payload = new Uint8Array(16);
    payload[2] = 0x24;

    try {
      var resp = await this._check_data(payload);
      this._utils.debugLog(this, `>>> Checking temp/hum data response: ` + (resp));

      // Unpack the response to get temperature
      let temperature = [resp[0x2], resp[0x3]];
      let humidity = [resp[0x4], resp[0x5]];
      this._utils.debugLog(this, `>>> Identified Temperature: ${temperature} °C <<<`);
      this._utils.debugLog(this, `>>> Identified Humidity: ${humidity} % <<<`);
      return { temperature, humidity };
    } catch (err) {
      this._utils.debugLog(this, `>>> Error checking temperature: ${err.message}`);
      throw err;
    }
  }


  /**
   *
   */
  async enterRFSweep() {
    var payload = new Uint8Array(16);
    payload[0] = 0x19;
    //was previously true but do match with
    this._utils.debugLog(this, `>>> Entering RF sweeping <<<`);
    await this.send_packet(0x6a, true, payload);
  }

  /**
   *
   */
  async checkRFData() {
    var payload = new Uint8Array(16);
    payload[0] = 0x1a;
    var retryCount = 3;
    this._utils.debugLog(this, `>>> Checking RF frequency data <<<`);
    do {
      var resp = await this._check_data(payload);
      retryCount = retryCount - 1;
    } while (retryCount > 0 && resp[0] != 1);
    if (resp[0] != 1) {
      // Log the full response for detailed inspection
      this._utils.debugLog(
        this,
        `>>> Full RF response: ${Array.from(resp)
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(", ")}`
      );
      this._utils.debugLog(this, `>>> Frequency not identified <<<`);
      throw new Error(this.homey.__("errors.no_key_detected"));
    }
  }

  /**
   *
   */
  async checkRFData2() {
    var payload = new Uint8Array(16);
    this._utils.debugLog(this, `>>> Checking RF data <<<`);
    payload[0] = 0x1b;
    return await this._check_data(payload);
  }

  /**
   *
   */
  async cancelRFSweep() {
    this._utils.debugLog(this, `>>> Stopping RF learning <<<`);
    var payload = new Uint8Array(16);
    payload[0] = 0x1e;
    await this.send_packet(0x6a, false, payload);
  }

  /**
   *
   */
  async enterRFSweep_rm4pro() {
    var payload = new Uint8Array(16);
    payload[0] = 0x04;
    payload[1] = 0x00;
    payload[2] = 0x19;
    this._utils.debugLog(this, `>>> Entering RF sweeping <<<`);

    //was previously true but do match with other implementation !!!!
    await this.send_packet(0x6a, true, payload);
  }

  /**
   *
   */
  async checkRFData_rm4pro() {
    var payload = new Uint8Array(16);
    payload[0] = 0x04;
    payload[1] = 0x00;
    payload[2] = 0x1a;
    var retryCount = 10;
    do {
      this._utils.debugLog(this, `>>> Checking RF frequency data <<< , retry : `, 11 - retryCount);
      var resp = await this._check_data(payload);
      this._utils.debugLog(this, `>>> Checking RF payload : ` + payload);
      this._utils.debugLog(this, `>>> Checking RF frequency data : ` + resp);
      retryCount = retryCount - 1;
      let frequencyBytes = resp.slice(3, 7);
      let frequency =
        (frequencyBytes[0] | (frequencyBytes[1] << 8) | (frequencyBytes[2] << 16) | (frequencyBytes[3] << 24)) / 1000.0;
      this._utils.debugLog(this, `>>> Sweeping on frequency: ${frequency} MHz <<<`);
    } while (retryCount > 0 && resp[2] != 1);

    if (resp[2] != 1) {
      // Log the full response for detailed inspection
      this._utils.debugLog(this, `>>> Frequency not identified <<<`);
      throw new Error(this.homey.__("errors.no_key_detected"));
    } else {
      // Decode frequency
      this._utils.debugLog(
        this,
        `>>> Full RF response: ${Array.from(resp)
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(", ")}`
      );
      let frequencyBytes = resp.slice(3, 7);
      let frequency =
        (frequencyBytes[0] | (frequencyBytes[1] << 8) | (frequencyBytes[2] << 16) | (frequencyBytes[3] << 24)) / 1000.0;
      this._utils.debugLog(this, `>>> Identified Final Frequency: ${frequency} MHz, bytes ${frequencyBytes}  <<<`);
            return frequencyBytes; // Return frequencyBytes directly
    }
  }


  async checkRFData2_rm4pro(frequencyBytes) {
    this._utils.debugLog(this, `checkRFData2_rm4pro with frequencyBytes: ${this._utils.arrToHex(frequencyBytes)}`);

    let payload = new Uint8Array(10);
    payload.set([0x04, 0x00, 0x1b], 0);
    payload.set(frequencyBytes, 6);

    let retryCount = 10;

    do {
        this._utils.debugLog(this, `>>> Sending packet to check captured RF data, retry: ${10 - retryCount} <<<`);
        await this._check_data(payload);

        payload.set([0x04, 0x00, 0x04], 0);
        
        let response = await this._check_data(payload);
        this._utils.debugLog(
            this,
            `>>> Full RF response: ${Array.from(response)
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join(", ")}`);

        if (response[0] !== 0 || response[1] !== 0 || response[2] !== 0 || response[3] !== 0) {
            this._utils.debugLog(this, `>>> RF data captured successfully <<< ${this._utils.arrToHex(response.slice(2))}`);
            return response.slice(2);
        }

        retryCount--;
    } while (retryCount > 0);

    this._utils.debugLog(this, `>>> Failed to capture RF data <<<`);
    throw new Error(this.homey.__("errors.no_rf_data"));
}


  /**
   *
   
  async checkRFData2_rm4pro(frequencyBytes) {
    this._utils.debugLog(this, `checkRFData2_rm4pro with frequencyBytes: ${this._utils.arrToHex(frequencyBytes)}`);

    let payload = new Uint8Array(10);
    payload[0] = 0x04;
    payload[1] = 0x00;
    payload[2] = 0x1b;
    payload[6] = frequencyBytes[0];
    payload[7] = frequencyBytes[1];
    payload[8] = frequencyBytes[2];
    payload[9] = frequencyBytes[3];

    let retryCount = 10;
    do {
        this._utils.debugLog(this, `>>> Sending packet to check captured RF data, retry: ${10 - retryCount} <<<`);
        await this._check_data(payload);
        //this._utils.debugLog(this, `>>> Received response: ${this._utils.arrToHex(resp)} <<<`);
        payload[0] = 0x04;
        payload[1] = 0x00;
        payload[2] = 0x04;
     //   payload[6] = frequencyBytes[0];
       // payload[7] = frequencyBytes[1];
        //payload[8] = frequencyBytes[2];
        //payload[9] = frequencyBytes[3];
        let resp = await this._check_data(payload);
        this._utils.debugLog(
                    this,
          `>>> Full RF response: ${Array.from(resp)
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(", ")}`);
        // find the right response !!!! 
        // find the right response !!!! 
        // find the right response !!!! 
       // if (resp[2] === 0x04) {
            this._utils.debugLog(this, `>>> RF data captured successfully <<< ${this._utils.arrToHex(resp.slice(2))}`);

            // check the slice !!!!
            // check the slice !!!!
            // check the slice !!!!
            return resp.slice(2); // Assuming the useful data starts from the 5th byte
        //}

        retryCount--;
    } while (retryCount > 0);

    this._utils.debugLog(this, `>>> Failed to capture RF data <<<`);
    throw new Error(this.homey.__("errors.no_rf_data"));
} */


  /**
   *
   */
  async cancelRFSweep_rm4pro() {
    this._utils.debugLog(this, `>>> Stopping RF learning <<<`);
    var payload = new Uint8Array(16);
    payload[0] = 0x04;
    payload[1] = 0x00;
    payload[2] = 0x1e;
    await this.send_packet(0x6a, true, payload);
  }

  /**
   * Send a command to the device. The command was previously retrieved
   * with check_IR_data()
   */
  async send_IR_RF_data(data) {
    var payload;
    if (this.deviceType == 0x5f36) {
      // RM Mini 3 Red Bean device type
      payload = new Uint8Array(4);
      payload[0] = 0xd0;
      payload[1] = 0x00;
      payload[2] = 0x02;
      this._utils.debugLog(this, `Sent device Red Bean :`, this.deviceType);
    } else {
      payload = new Uint8Array(4);
      payload[0] = 0x02;
    }
    payload = this._utils.concatTypedArrays(payload, data);
    this._utils.debugLog(this, `Sent standard RM3 :`, this.deviceType);
    await this.send_packet(0x6a, false, payload);
  }

  async send_IR_RF_data_red(data) {
    var payload = new Uint8Array(4);
    payload[0] = 0xd0;
    payload[1] = 0x00;
    payload[2] = 0x02;
    payload = this._utils.concatTypedArrays(payload, data);
    this._utils.debugLog(this, `Sent device Red Bean/RM4 :`, this.deviceType);
    await this.send_packet(0x6a, false, payload);
  }

  async send_IR_RF_data_minired(data) {
    var payload = new Uint8Array(6); // Increase the size to 6 bytes
    payload[0] = 0xd0;
    payload[1] = 0x00;
    payload[2] = 0x02;
    payload[3] = 0x00; // Add missing bytes
    payload[4] = 0x00;
    payload[5] = 0x00;
    payload = this._utils.concatTypedArrays(payload, data);
    this._utils.debugLog(this, `Sent device RM3 Red Bean :`, this.deviceType);
    await this.send_packet(0x6a, false, payload);
  }
  async send_IR_RF_data_rm4pro(data) {
    var payload = new Uint8Array(6);
    // ??? modified based on "this.code_sending_header = this.rm4Type ? new Buffer([0xda, 0x00]) : new Buffer([]);" - https://github.com/kiwi-cam/broadlinkjs-rm/blob/3b4793c8bece65b8421fab4595f70c64adef3211/index.js#L271
    // previously it was payload[0] = 0xd0; ???
    payload[0] = 0xda;
    payload[1] = 0x00;
    payload[2] = 0x02;
    payload[3] = 0x00;
    payload[4] = 0x00;
    payload[5] = 0x00;
    payload = this._utils.concatTypedArrays(payload, data);
    this._utils.debugLog(this, `Sent device RM4 Pro :`, this.deviceType);
    await this.send_packet(0x6a, false, payload);
  }
  /**
   *
   */
  async read_status() {
    var payload = new Uint8Array(16);
    payload[0] = 0x01;
    let response = await this.send_packet(0x6a, false, payload);

    if (response.error == 0) {
      return response.payload;
    } else {
      throw new Error(this.homey.__("errors.invalid_response"));
    }
  }

  /**
   * Sets the night light state of the smart plug
   * @param {byte} state   [0,1,2,3]
   */
  async setPowerState(state) {
    var payload = new Uint8Array(16);
    payload[0] = 0x02;
    payload[4] = state;
    await this.send_packet(0x6a, false, payload);
  }

  /**
   * SP2 and SP3S
   */
  async sp2_get_energy() {
    var payload = new Uint8Array([8, 0, 254, 1, 5, 1, 0, 0, 0, 45]);
    let response = await this.send_packet(0x6a, false, payload);
    if (response.error == 0) {
      return response.payload;
    }
    throw new Error(this.homey.__("errors.invalid_response"));
  }

  /**
   * Returns the power state of the smart power strip in raw format.
   */
  async mp1_check_power() {
    var payload = new Uint8Array(16);
    payload[0x00] = 0x0a;
    payload[0x02] = 0xa5;
    payload[0x03] = 0xa5;
    payload[0x04] = 0x5a;
    payload[0x05] = 0x5a;
    payload[0x06] = 0xae;
    payload[0x07] = 0xc0;
    payload[0x08] = 0x01;

    let response = await this.send_packet(0x6a, false, payload);
    if (response.error == 0) {
      return response.payload[0x0a];
    }
    throw new Error(this.homey.__("errors.invalid_response"));
  }

  /**
   * @param  sid  [integer or string]  1..4
   * @param  mode [boolean]  true = on, false = off
   */
  async mp1_set_power_state(sid, mode) {
    if (sid !== Number) {
      sid = Number(sid);
    }
    let sid_mask = 0x01 << (sid - 1);

    var payload = new Uint8Array(16);
    payload[0x00] = 0x0d;
    payload[0x02] = 0xa5;
    payload[0x03] = 0xa5;
    payload[0x04] = 0x5a;
    payload[0x05] = 0x5a;
    payload[0x06] = 0xb2 + (mode ? sid_mask << 1 : sid_mask);
    payload[0x07] = 0xc0;
    payload[0x08] = 0x02;
    payload[0x0a] = 0x03;
    payload[0x0d] = sid_mask;
    payload[0x0e] = mode ? sid_mask : 0;

    try {
      let resp = await this.send_packet(0x6a, false, payload);
      if (resp.error != 0) {
        throw new Error(this.homey.__("errors.invalid_response"));
      }
    } catch (err) {
      throw new Error(this.homey.__("errors.invalid_response"));
    }
  }

  /**
   *
   */
  async sp1_set_power_state(mode) {
    var payload = new Uint8Array(4);
    payload[0] = mode ? 0x01 : 0x00;
    payload[1] = 0x04;
    payload[2] = 0x04;
    payload[3] = 0x04;

    try {
      await this.send_packet(0x66, false, payload);
    } catch (err) {
      //throw new Error(this.homey.__('errors.invalid_response'))
    }
  }

  /**
   *
   */
  async dooya_set_state(cmd1, cmd2) {
    var payload = new Uint8Array(16);
    payload[0] = 0x09;
    payload[2] = 0xbb;
    payload[3] = cmd1;
    payload[4] = cmd2;
    payload[9] = 0xfa;
    payload[10] = 0x44;
    let response = await this.send_packet(0x6a, false, payload);

    if (response.error == 0) {
      if (response.payload.length > 0) {
        return response.payload[0];
      }
    }
    throw new Error(this.homey.__("errors.invalid_response"));
  }
}

module.exports = Communicate;
