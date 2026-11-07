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

'use strict';

const BroadlinkDevice = require('./../../lib/BroadlinkDevice');


class DooyaDevice extends BroadlinkDevice {

	async onInit() {
		if (await super.onInit() === false || this._localStopped) return false;
		this.registerCapabilityListener('button.open', this.onCapabilityOpen.bind(this));
		this.registerCapabilityListener('button.close', this.onCapabilityClose.bind(this));
		this.registerCapabilityListener('button.stop', this.onCapabilityStop.bind(this));

		if (this.getCapabilities().indexOf('windowcoverings_closed') > -1) {
			this.registerCapabilityListener('windowcoverings_closed', this.onCapabilityWcClosed.bind(this))
		}
		else {
			this.windowcoverings_closed = false;
		}
	}

	async _set_state(closedState) {
		const previousState = this._get_state();
		// Keep the acknowledged command state even if Homey cannot store it.
		this.windowcoverings_closed = closedState;
		if (this.getCapabilities().indexOf('windowcoverings_closed') > -1) {
			try {
				await this.setCapabilityValue('windowcoverings_closed', closedState);
			} catch (err) {
				this.error('Dooya command acknowledged; Homey capability update failed', err);
			}
		}
		if (closedState !== previousState) {
			let drv = this.driver;
			try {
				await (closedState ? drv.trigger_closed : drv.trigger_open).trigger(this, {}, {});
			} catch (err) {
				this.error('Dooya command acknowledged; Homey Flow trigger failed', err);
			}
		}
	}

	/**
	 * @return TRUE if 'closed', FALSE if 'open'  
	 */
	_get_state() {
		if (this.windowcoverings_closed !== undefined) return this.windowcoverings_closed;
		if (this.getCapabilities().indexOf('windowcoverings_closed') > -1) {
			return this.getCapabilityValue('windowcoverings_closed')
		}
		else {
			return this.windowcoverings_closed
		}
	}


	check_condition_closed() {
		return Promise.resolve(this._get_state())
	}

	async do_action_close() {
		await this._sendCommand(0x02, 0x00);
		await this._set_state(true);
		return true;
	}

	async do_action_open() {
		await this._sendCommand(0x01, 0x00);
		await this._set_state(false);
		return true;
	}

	do_action_toggle() {
		if (this._get_state()) {
			return this.do_action_open()
		}
		else {
			return this.do_action_close()
		}
	}


	/**
	 * @param  cmd   command to send  ['open', 'close', 'stop', 'get_percentage' ]
	 * @return  if cmd==get_percentage: the opened percentage
	 *          otherwise: nothing
	 */
	async _sendCommand(cmd1, cmd2) {
		try {
			let res = await this._communicate.dooya_set_state(cmd1, cmd2);
			return res
		}
		catch (err) {
			this._utils.debugLog(this, "**> DooyaDevice._sendCommand " + cmd1 + "." + cmd2 + ": error = " + err);
			throw err;
		}
	}

	async onCapabilityWcClosed(state) {
		return state ? this.do_action_close() : this.do_action_open();
	}

	async onCapabilityOpen(state) {
		return this.do_action_open();
	}

	async onCapabilityClose(state) {
		return this.do_action_close();
	}

	async onCapabilityStop(state) {
		return this._sendCommand(0x03, 0x00);
	}

	async get_percentage(self) {
		return await this._sendCommand(0x06, 0x5d)
	}

}

module.exports = DooyaDevice;
